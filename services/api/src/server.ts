import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  cadPlanSchema,
  validatePlanAgainstIntent,
  validatePlanAgainstFeatureTree,
  type CadOperation,
  type OperationExecutionResult,
  type RegenerationError,
  type StoredCadPlan
} from "@morassistant/cad-command-schema";
import {
  CodexWorkerPool,
  type CodexRuntimeStatus,
  type PlanningProgress,
  type PlanningProgressCallback
} from "@morassistant/codex-worker";
import {
  buildOnshapeAuthorizationUrl,
  exchangeOnshapeCode,
  featureFingerprint,
  OnshapeClient,
  OnshapeApiError,
  refreshOnshapeTokens,
  type FeatureListResponse,
  type FeatureSpecsResponse,
  type OnshapeOAuthConfig,
  type OnshapeFeature,
  type PartStudioGeometryEvidence,
  type OnshapeTokens
} from "@morassistant/onshape-client";
import type { PartStudioContext } from "@morassistant/shared-types";
import { SessionStore, type UserSession } from "./session-store.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.string().url().optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  SESSION_ENCRYPTION_KEY: z.string().min(32).optional(),
  SESSION_DB_PATH: z.string().min(1).default(":memory:"),
  INSTALLATION_TOKEN: z.string().min(32).optional(),
  ONSHAPE_CLIENT_ID: z.string().min(1).optional(),
  ONSHAPE_CLIENT_SECRET: z.string().min(1).optional(),
  ONSHAPE_REDIRECT_URI: z.string().url().optional(),
  ONSHAPE_AUTHORIZATION_URL: z.string().url().default("https://oauth.onshape.com/oauth/authorize"),
  ONSHAPE_TOKEN_URL: z.string().url().default("https://oauth.onshape.com/oauth/token"),
  ONSHAPE_BASE_URL: z.string().url().default("https://cad.onshape.com"),
  ONSHAPE_API_VERSION: z.string().default("v16"),
  ONSHAPE_SNAPSHOT_FRESH_MS: z.coerce.number().int().min(0).max(3_600_000).default(5 * 60_000),
  CODEX_MODEL: z.string().min(1).optional(),
  CODEX_REASONING_EFFORT: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  CODEX_COMMAND: z.string().default("codex"),
  CODEX_USERS_ROOT: z.string().default(resolve(repositoryRoot, "data/codex-users")),
  CODEX_MAX_WORKERS: z.coerce.number().int().min(1).max(100).default(4),
  CODEX_IDLE_TIMEOUT_MS: z.coerce.number().int().min(11 * 60_000).max(3_600_000).default(15 * 60_000)
});

const env = envSchema.parse(process.env);
if (env.NODE_ENV === "production" && (!env.SESSION_SECRET || !env.SESSION_ENCRYPTION_KEY || !env.APP_ORIGIN || env.SESSION_DB_PATH === ":memory:")) {
  throw new Error("SESSION_SECRET, SESSION_ENCRYPTION_KEY, SESSION_DB_PATH, and APP_ORIGIN are required in production.");
}
if (env.APP_ORIGIN && new URL(env.APP_ORIGIN).origin !== env.APP_ORIGIN.replace(/\/$/, "")) {
  throw new Error("APP_ORIGIN must contain only an origin, without a path, query, or fragment.");
}
if (new URL(env.ONSHAPE_BASE_URL).origin !== env.ONSHAPE_BASE_URL.replace(/\/$/, "")) {
  throw new Error("ONSHAPE_BASE_URL must contain only an origin, without a path, query, or fragment.");
}
if ([env.ONSHAPE_CLIENT_ID, env.ONSHAPE_CLIENT_SECRET, env.ONSHAPE_REDIRECT_URI].some(Boolean) &&
    ![env.ONSHAPE_CLIENT_ID, env.ONSHAPE_CLIENT_SECRET, env.ONSHAPE_REDIRECT_URI].every(Boolean)) {
  throw new Error("ONSHAPE_CLIENT_ID, ONSHAPE_CLIENT_SECRET, and ONSHAPE_REDIRECT_URI must be configured together.");
}
if (env.NODE_ENV === "production") {
  for (const [name, value] of [
    ["APP_ORIGIN", env.APP_ORIGIN!],
    ["ONSHAPE_BASE_URL", env.ONSHAPE_BASE_URL],
    ["ONSHAPE_AUTHORIZATION_URL", env.ONSHAPE_AUTHORIZATION_URL],
    ["ONSHAPE_TOKEN_URL", env.ONSHAPE_TOKEN_URL],
    ...(env.ONSHAPE_REDIRECT_URI ? [["ONSHAPE_REDIRECT_URI", env.ONSHAPE_REDIRECT_URI]] : [])
  ]) {
    if (!value || new URL(value).protocol !== "https:") throw new Error(`${name} must use HTTPS in production.`);
  }
}

const sessions = new Map<string, UserSession>();
type PlanJob = {
  id: string;
  sessionId: string;
  status: "planning" | "completed" | "failed";
  createdAt: number;
  progress: PlanningProgress[];
  plan?: StoredCadPlan;
  error?: string;
};
const planJobs = new Map<string, PlanJob>();

function updatePlanJobProgress(job: PlanJob, progress: PlanningProgress): void {
  const existing = job.progress.findIndex((item) => item.id === progress.id);
  if (existing >= 0) job.progress[existing] = progress;
  else job.progress.push(progress);
  if (job.progress.length > 30) job.progress.splice(0, job.progress.length - 30);
}
const geometryCache = new Map<string, { createdAt: number; evidence: PartStudioGeometryEvidence }>();
const featureSpecsCache = new Map<string, { createdAt: number; specs: FeatureSpecsResponse }>();
const sessionDatabasePath = env.SESSION_DB_PATH === ":memory:" ? env.SESSION_DB_PATH : resolve(repositoryRoot, env.SESSION_DB_PATH);
const sessionStore = new SessionStore(sessionDatabasePath, env.SESSION_ENCRYPTION_KEY ?? randomBytes(32).toString("base64url"));
const codexUsersRoot = resolve(repositoryRoot, env.CODEX_USERS_ROOT);
for (const expiredSessionId of sessionStore.pruneExpired(Date.now() - 90 * 24 * 60 * 60 * 1_000)) {
  const userDirectory = createHash("sha256").update(expiredSessionId).digest("hex");
  rmSync(resolve(codexUsersRoot, userDirectory), { recursive: true, force: true });
}
const workers = new CodexWorkerPool(
  codexUsersRoot,
  env.CODEX_MODEL,
  env.CODEX_REASONING_EFFORT,
  env.CODEX_COMMAND,
  env.CODEX_MAX_WORKERS,
  env.CODEX_IDLE_TIMEOUT_MS
);

function saveSession(session: UserSession): void {
  sessionStore.save(session);
}

function featuresWithHashes(features: OnshapeFeature[]): Array<OnshapeFeature & { featureHash: string }> {
  return features.map((feature) => ({ ...feature, featureHash: featureFingerprint(feature) }));
}

function geometryCacheKey(sessionId: string, context: PartStudioContext, tree: FeatureListResponse): string | undefined {
  if (!tree.sourceMicroversion) return undefined;
  return createHash("sha256").update(JSON.stringify([
    sessionId,
    context.server ?? env.ONSHAPE_BASE_URL,
    context.documentId,
    context.workspaceId,
    context.elementId,
    context.configuration ?? "",
    tree.sourceMicroversion
  ])).digest("hex");
}

function featureSpecsCacheKey(sessionId: string, context: PartStudioContext, tree: FeatureListResponse): string {
  return JSON.stringify([
    createHash("sha256").update(sessionId).digest("hex"),
    context.server ?? env.ONSHAPE_BASE_URL,
    context.documentId,
    context.workspaceId,
    context.elementId,
    context.configuration ?? "",
    tree.libraryVersion ?? "current"
  ]);
}

function pruneFeatureSpecsCache(now = Date.now()): void {
  for (const [key, entry] of featureSpecsCache) {
    if (now - entry.createdAt > 60 * 60_000) featureSpecsCache.delete(key);
  }
  while (featureSpecsCache.size > 100) {
    const oldest = featureSpecsCache.keys().next().value as string | undefined;
    if (!oldest) break;
    featureSpecsCache.delete(oldest);
  }
}

function partStudioSnapshotKey(context: PartStudioContext): string {
  return createHash("sha256").update(JSON.stringify([
    context.server ?? env.ONSHAPE_BASE_URL,
    env.ONSHAPE_API_VERSION,
    context.documentId,
    context.workspaceId,
    context.elementId,
    context.configuration ?? ""
  ])).digest("hex");
}

function isOnshapeRateLimit(error: unknown): error is OnshapeApiError {
  return error instanceof OnshapeApiError && error.status === 429;
}

function geometryEvidence(inspection: {
  bodyDetails?: unknown;
  massProperties?: unknown;
  topologyEvaluation?: unknown;
  warnings: string[];
}): PartStudioGeometryEvidence {
  return {
    ...(inspection.bodyDetails !== undefined ? { bodyDetails: inspection.bodyDetails } : {}),
    ...(inspection.massProperties !== undefined ? { massProperties: inspection.massProperties } : {}),
    ...(inspection.topologyEvaluation !== undefined ? { topologyEvaluation: inspection.topologyEvaluation } : {}),
    warnings: inspection.warnings
  };
}

function storePartStudioSnapshot(
  session: UserSession,
  contextKey: string,
  tree: FeatureListResponse,
  geometry?: PartStudioGeometryEvidence
): void {
  if (!tree.sourceMicroversion || JSON.stringify(tree).length > 2_000_000) return;
  const existing = session.partStudioSnapshots.get(contextKey);
  const reusableGeometry = existing?.tree.sourceMicroversion === tree.sourceMicroversion
    ? existing.geometry
    : undefined;
  const candidateGeometry = geometry ?? reusableGeometry;
  const safeGeometry = candidateGeometry && JSON.stringify(candidateGeometry).length <= 750_000
    ? candidateGeometry
    : undefined;
  session.partStudioSnapshots.delete(contextKey);
  session.partStudioSnapshots.set(contextKey, {
    contextKey,
    capturedAt: Date.now(),
    tree,
    ...(safeGeometry ? { geometry: safeGeometry } : {})
  });
  while (session.partStudioSnapshots.size > 20) {
    const oldestKey = session.partStudioSnapshots.keys().next().value as string | undefined;
    if (!oldestKey) break;
    session.partStudioSnapshots.delete(oldestKey);
  }
}

function responseRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function treeFromMutationResponse(
  tree: FeatureListResponse,
  operation: CadOperation,
  response: unknown
): FeatureListResponse | undefined {
  const result = responseRecord(response);
  const sourceMicroversion = result?.sourceMicroversion;
  if (!result || typeof sourceMicroversion !== "string" || sourceMicroversion.length === 0) return undefined;

  let features = structuredClone(tree.features);
  const returnedFeature = responseRecord(result.feature) as OnshapeFeature | undefined;
  if (operation.type === "create_rectangle_sketch" ||
    operation.type === "create_circle_sketch" ||
    operation.type === "extrude_sketch" ||
    operation.type === "fillet_feature_edges" ||
    operation.type === "chamfer_feature_edges" ||
    operation.type === "create_feature") {
    if (!returnedFeature || typeof returnedFeature.featureId !== "string") return undefined;
    features.push(returnedFeature);
  } else if (operation.type === "delete_feature") {
    features = features.filter((feature) => feature.featureId !== operation.featureId);
  } else {
    if (!returnedFeature || typeof returnedFeature.featureId !== "string") return undefined;
    const index = features.findIndex((feature) => feature.featureId === operation.featureId);
    if (index < 0) return undefined;
    features[index] = returnedFeature;
  }

  const featureStates = responseRecord(structuredClone(tree.featureStates)) ?? {};
  if (operation.type === "delete_feature") {
    delete featureStates[operation.featureId];
  } else if (returnedFeature) {
    const returnedState = responseRecord(result.featureState);
    if (returnedState) featureStates[returnedFeature.featureId] = returnedState;
  }
  return {
    ...structuredClone(tree),
    features,
    featureStates,
    sourceMicroversion,
    ...(typeof result.serializationVersion === "string" ? { serializationVersion: result.serializationVersion } : {})
  };
}

function pruneGeometryCache(now = Date.now()): void {
  for (const [key, entry] of geometryCache) {
    if (now - entry.createdAt > 10 * 60_000) geometryCache.delete(key);
  }
  while (geometryCache.size > 100) {
    const oldest = geometryCache.keys().next().value as string | undefined;
    if (!oldest) break;
    geometryCache.delete(oldest);
  }
}

const planRequestSchema = z.object({
  prompt: z.string().trim().min(3).max(4_000),
  context: z.unknown()
}).strict();

function parsePlanRequest(value: unknown): { prompt: string; context: PartStudioContext } {
  const input = planRequestSchema.parse(value);
  return { prompt: input.prompt, context: parseContext(input.context) };
}

async function createStoredPlan(
  session: UserSession,
  body: { prompt: string; context: PartStudioContext },
  recoveryForPlanId?: string,
  onProgress?: PlanningProgressCallback
): Promise<StoredCadPlan> {
  const client = clientFor(session, body.context);
  const snapshotKey = partStudioSnapshotKey(body.context);
  const storedSnapshot = session.partStudioSnapshots.get(snapshotKey);
  let usedStoredSnapshot = false;
  let rateLimitFallback = false;
  let featureTree: FeatureListResponse;
  if (storedSnapshot && Date.now() - storedSnapshot.capturedAt <= env.ONSHAPE_SNAPSHOT_FRESH_MS) {
    featureTree = storedSnapshot.tree;
    usedStoredSnapshot = true;
  } else {
    try {
      featureTree = await client.listFeatures(body.context);
    } catch (error) {
      if (!isOnshapeRateLimit(error) || !storedSnapshot) throw error;
      featureTree = storedSnapshot.tree;
      usedStoredSnapshot = true;
      rateLimitFallback = true;
    }
  }
  pruneGeometryCache();
  const cacheKey = geometryCacheKey(session.id, body.context, featureTree);
  const memoryGeometry = cacheKey ? geometryCache.get(cacheKey)?.evidence : undefined;
  const persistedGeometry = storedSnapshot?.tree.sourceMicroversion === featureTree.sourceMicroversion
    ? storedSnapshot?.geometry
    : undefined;
  const cachedGeometry = memoryGeometry ?? persistedGeometry;
  const rawInspection = await client.inspectPartStudio(body.context, featureTree, cachedGeometry);
  pruneFeatureSpecsCache();
  const specsKey = featureSpecsCacheKey(session.id, body.context, featureTree);
  let featureSpecs = featureSpecsCache.get(specsKey)?.specs;
  let featureSpecsWarning: string | undefined;
  if (!featureSpecs) {
    try {
      featureSpecs = await client.getFeatureSpecs(body.context);
      featureSpecsCache.set(specsKey, { createdAt: Date.now(), specs: featureSpecs });
    } catch (error) {
      featureSpecsWarning = isOnshapeRateLimit(error)
        ? "Onshape's live feature specification catalog is temporarily rate-limited; the built-in MorAssistant tool curriculum remains available."
        : "Onshape's live feature specification catalog was unavailable; the built-in MorAssistant tool curriculum remains available.";
    }
  }
  const snapshotWarning = rateLimitFallback
    ? `Onshape feature-list reads are temporarily rate-limited. Planning used the last encrypted, verified snapshot from ${new Date(storedSnapshot!.capturedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC; execution will retain the snapshot's microversion guard.`
    : undefined;
  const additionalWarnings = [snapshotWarning, featureSpecsWarning].filter((warning): warning is string => Boolean(warning));
  const inspection = {
    ...rawInspection,
    ...(featureSpecs ? { featureSpecs } : {}),
    warnings: [...rawInspection.warnings, ...additionalWarnings]
  };
  if (cacheKey && !cachedGeometry && inspection.warnings.length === 0) {
    const evidence = geometryEvidence(inspection);
    if (JSON.stringify(evidence).length <= 750_000) geometryCache.set(cacheKey, { createdAt: Date.now(), evidence });
  }
  if (!usedStoredSnapshot || !storedSnapshot?.geometry) {
    storePartStudioSnapshot(session, snapshotKey, featureTree, geometryEvidence(rawInspection));
  }
  const planning = await workers.forUser(session.id).createPlan(body.prompt, inspection, onProgress);
  const plan = cadPlanSchema.parse(planning.plan);
  validatePlanAgainstIntent(body.prompt, validatePlanAgainstFeatureTree(plan, featuresWithHashes(featureTree.features)));
  if (body.context.configuration && plan.operations.some((operation) => operation.type === "update_dimension")) {
    throw new HttpError(409, "Dimension edits in configured Part Studios are not supported yet. Rename operations remain available.");
  }
  const stored: StoredCadPlan = {
    ...plan,
    id: randomUUID(),
    context: body.context,
    prompt: body.prompt,
    status: "pending",
    createdAt: new Date().toISOString(),
    agentTrace: {
      planningAttempts: planning.attempts,
      runtime: {
        ...(planning.runtime.configuredModel ? { configuredModel: planning.runtime.configuredModel } : {}),
        model: planning.runtime.model,
        ...(planning.runtime.modelProvider ? { modelProvider: planning.runtime.modelProvider } : {}),
        ...(planning.runtime.reasoningEffort ? { reasoningEffort: planning.runtime.reasoningEffort } : {}),
        ...(planning.runtime.serviceTier ? { serviceTier: planning.runtime.serviceTier } : {})
      },
      featureCount: planning.inspection.featureCount,
      capabilityCount: planning.inspection.capabilityCount,
      nativeFeatureTypeCount: planning.inspection.nativeFeatureTypeCount,
      capabilityCatalogVersion: planning.inspection.capabilityCatalogVersion,
      dependencyCount: planning.inspection.dependencyCount,
      geometry: planning.inspection.geometry,
      inspectionWarnings: planning.inspection.warnings
    },
    ...(featureTree.sourceMicroversion ? { sourceMicroversion: featureTree.sourceMicroversion } : {}),
    ...(recoveryForPlanId ? { recoveryForPlanId } : {})
  };
  while (session.plans.size >= 100) {
    const oldestPlanId = session.plans.keys().next().value as string | undefined;
    if (!oldestPlanId) break;
    session.plans.delete(oldestPlanId);
  }
  session.plans.set(stored.id, stored);
  saveSession(session);
  return stored;
}

function prunePlanJobs(): void {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [id, job] of planJobs) {
    if (job.createdAt < cutoff && job.status !== "planning") planJobs.delete(id);
  }
}

function planJobError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const location = issue?.path.length ? issue.path.join(".") : "plan";
    return `Codex produced an invalid CAD plan at ${location}: ${issue?.message ?? "validation failed"}. Try the request again or make the intended geometry more specific.`;
  }
  if (error instanceof Error) return error.message;
  return "Could not create a CAD plan.";
}

function recoveryPrompt(plan: StoredCadPlan): string {
  const operationResults = plan.result?.operations.map((item) =>
    `${item.index + 1}. ${item.operation.type}: ${item.status} — ${item.message}`
  ).join("\n") ?? "No operation result was recorded.";
  const regeneration = plan.result?.regenerationErrors.map((item) =>
    `${item.featureName} (${item.status}): ${item.message ?? "no additional message"}`
  ).join("\n") || "No separate regeneration error was reported.";
  return [
    "Create a recovery plan for a partially executed Onshape request.",
    `Original user request: ${plan.prompt}`,
    `Original plan summary: ${plan.summary}`,
    "Execution results:",
    operationResults,
    "New regeneration errors:",
    regeneration,
    "Inspect the current Part Studio snapshot, account for operations that already applied, and propose the smallest safe alternate plan that still completes the original request. Do not repeat successful work. The recovery plan will receive its own explicit user approval."
  ].join("\n\n").slice(0, 4_000);
}

function getCookieSession(request: FastifyRequest, reply: FastifyReply): UserSession {
  const signedCookie = request.cookies.mor_session;
  const unsignedCookie = signedCookie ? request.unsignCookie(signedCookie) : undefined;
  let id = unsignedCookie?.valid ? unsignedCookie.value : undefined;
  let session = id ? sessions.get(id) ?? sessionStore.get(id) : undefined;
  let refreshCookie = false;
  if (!session) {
    id = randomUUID();
    session = sessionStore.create(id);
    sessions.set(id, session);
    refreshCookie = true;
  } else {
    if (!sessions.has(session.id)) sessions.set(session.id, session);
    if (Date.now() - session.lastTouchedAt >= 60 * 60 * 1_000) {
      saveSession(session);
      refreshCookie = true;
    }
  }
  if (refreshCookie) {
    reply.setCookie("mor_session", session.id, {
      path: "/",
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 60 * 60 * 24 * 30,
      signed: true
    });
  }
  return session;
}

const ownerSessionId = env.INSTALLATION_TOKEN
  ? `owner-${createHash("sha256").update(`morassistant:${env.INSTALLATION_TOKEN}`).digest("hex")}`
  : undefined;

function ownerSession(): UserSession {
  if (!ownerSessionId) throw new Error("Personal installation mode is not configured.");
  let session = sessions.get(ownerSessionId) ?? sessionStore.get(ownerSessionId);
  if (!session) session = sessionStore.create(ownerSessionId);
  else if (Date.now() - session.lastTouchedAt >= 60 * 60 * 1_000) saveSession(session);
  sessions.set(ownerSessionId, session);
  return session;
}

function validInstallationToken(value: unknown): boolean {
  if (!env.INSTALLATION_TOKEN || typeof value !== "string") return false;
  const expected = Buffer.from(env.INSTALLATION_TOKEN, "utf8");
  const received = Buffer.from(value, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function getSession(request: FastifyRequest, reply: FastifyReply): UserSession {
  if (!env.INSTALLATION_TOKEN) return getCookieSession(request, reply);
  const token = request.headers["x-mor-installation"];
  if (Array.isArray(token) || !validInstallationToken(token)) {
    throw new HttpError(401, "This panel is not linked to the personal MorAssistant installation.");
  }
  return ownerSession();
}

function getOAuthStartSession(request: FastifyRequest, reply: FastifyReply, installationToken?: string): UserSession {
  if (!env.INSTALLATION_TOKEN) return getCookieSession(request, reply);
  if (!validInstallationToken(installationToken)) {
    throw new HttpError(401, "Invalid personal installation link.");
  }
  return ownerSession();
}

function getOAuthCallbackSession(request: FastifyRequest, reply: FastifyReply, state: string): UserSession {
  if (!env.INSTALLATION_TOKEN) return getCookieSession(request, reply);
  const session = ownerSession();
  if (!session.onshapeState || session.onshapeState !== state) {
    throw new HttpError(400, "Invalid or expired Onshape OAuth state.");
  }
  return session;
}

function onshapeOAuthConfig(): OnshapeOAuthConfig {
  if (!env.ONSHAPE_CLIENT_ID || !env.ONSHAPE_CLIENT_SECRET || !env.ONSHAPE_REDIRECT_URI) {
    throw new Error("Onshape OAuth is not configured. Set ONSHAPE_CLIENT_ID, ONSHAPE_CLIENT_SECRET, and ONSHAPE_REDIRECT_URI.");
  }
  return {
    clientId: env.ONSHAPE_CLIENT_ID,
    clientSecret: env.ONSHAPE_CLIENT_SECRET,
    redirectUri: env.ONSHAPE_REDIRECT_URI,
    authorizationUrl: env.ONSHAPE_AUTHORIZATION_URL,
    tokenUrl: env.ONSHAPE_TOKEN_URL
  };
}

async function refreshSessionTokens(session: UserSession): Promise<OnshapeTokens> {
  if (!session.onshapeTokens) throw new Error("Onshape access is not available for this installed extension.");
  if (!session.onshapeRefresh) {
    session.onshapeRefresh = refreshOnshapeTokens(onshapeOAuthConfig(), session.onshapeTokens.refreshToken)
      .then((tokens) => {
        session.onshapeTokens = tokens;
        saveSession(session);
        return tokens;
      })
      .catch((error) => {
        delete session.onshapeTokens;
        saveSession(session);
        throw error;
      })
      .finally(() => delete session.onshapeRefresh);
  }
  return session.onshapeRefresh;
}

function clientFor(session: UserSession, context?: PartStudioContext): OnshapeClient {
  if (!session.onshapeTokens) throw new Error("Onshape access is not available for this installed extension.");
  return new OnshapeClient({
    accessToken: async () => {
      if (session.onshapeTokens!.expiresAt <= Date.now()) return (await refreshSessionTokens(session)).accessToken;
      return session.onshapeTokens!.accessToken;
    },
    refreshAccessToken: async () => (await refreshSessionTokens(session)).accessToken,
    baseUrl: context?.server ?? env.ONSHAPE_BASE_URL,
    apiVersion: env.ONSHAPE_API_VERSION
  });
}

const contextId = z.string().min(1).max(200);
const contextSchema = z.object({
  documentId: contextId,
  workspaceId: contextId,
  elementId: contextId,
  workspaceOrVersion: z.literal("w").optional(),
  configuration: z.string().max(4_000).optional(),
  server: z.string().url().max(2_048).optional()
}).strict();

function isSupportedOnshapeOrigin(origin: string): boolean {
  if (origin === new URL(env.ONSHAPE_BASE_URL).origin) return true;
  const url = new URL(origin);
  return url.protocol === "https:" && !url.port && (url.hostname === "onshape.com" || url.hostname.endsWith(".onshape.com"));
}

function parseContext(input: unknown): PartStudioContext {
  const context = contextSchema.parse(input);
  const configuration = context.configuration?.trim();
  const hasConfiguration = Boolean(
    configuration
    && configuration.toLowerCase() !== "default"
    && configuration.toLowerCase() !== "{$configuration}"
  );
  if (context.server) {
    let serverOrigin: string;
    try {
      serverOrigin = new URL(context.server).origin;
    } catch {
      throw new HttpError(400, "Invalid Onshape server context.");
    }
    if (!isSupportedOnshapeOrigin(serverOrigin)) {
      throw new HttpError(400, "This extension launch came from an unexpected Onshape stack.");
    }
  }
  return {
    documentId: context.documentId,
    workspaceId: context.workspaceId,
    elementId: context.elementId,
    ...(context.workspaceOrVersion ? { workspaceOrVersion: context.workspaceOrVersion } : {}),
    ...(hasConfiguration ? { configuration: configuration! } : {}),
    ...(context.server ? { server: new URL(context.server).origin } : {})
  };
}

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function logError(error: unknown): { error: unknown } | { errorType: string } {
  return env.NODE_ENV === "development"
    ? { error }
    : { errorType: error instanceof Error ? error.name : "UnknownError" };
}

const app = Fastify({
  logger: true,
  logController: new LogController({ disableRequestLogging: true }),
  trustProxy: env.NODE_ENV === "production",
  bodyLimit: 64 * 1024
});
await app.register(cookie, { secret: env.SESSION_SECRET ?? randomBytes(32).toString("hex") });
await app.register(rateLimit, {
  max: 180,
  timeWindow: "1 minute",
  keyGenerator: (request) => {
    const signedCookie = request.cookies.mor_session;
    if (!signedCookie) return request.ip;
    const unsignedCookie = request.unsignCookie(signedCookie);
    return unsignedCookie.valid ? unsignedCookie.value : request.ip;
  }
});
await app.register(cors, {
  origin: env.APP_ORIGIN ?? (env.NODE_ENV === "development" ? true : false),
  credentials: true
});
app.addHook("onSend", async (request, reply, payload) => {
  const privateNetworkPreflight = request.headers["access-control-request-private-network"];
  if (
    request.method === "OPTIONS"
    && privateNetworkPreflight === "true"
    && env.APP_ORIGIN
    && request.headers.origin === env.APP_ORIGIN
  ) {
    // Chrome's Private Network Access preflight is triggered when the public
    // Netlify panel reaches a personal Tailscale Funnel address. Without this
    // opt-in the browser reports only a generic `Failed to fetch`, even though
    // the normal CORS preflight and Funnel health check both succeed.
    reply.header("access-control-allow-private-network", "true");
  }
  return payload;
});
await app.register(helmet, {
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  xFrameOptions: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'none'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      formAction: ["'self'", env.ONSHAPE_AUTHORIZATION_URL],
      frameAncestors: ["'self'", env.ONSHAPE_BASE_URL, "https://*.onshape.com"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"]
    }
  }
});

app.addHook("onSend", async (request, reply, payload) => {
  if (request.url.startsWith("/api/") || request.url.startsWith("/oauth/")) {
    reply.header("cache-control", "no-store");
  }
  return payload;
});

app.addHook("preHandler", async (request, reply) => {
  if (request.method !== "POST" || !request.url.startsWith("/api/") || !env.APP_ORIGIN) return;
  if (request.headers.origin !== env.APP_ORIGIN) {
    return reply.code(403).send({ error: "Untrusted request origin." });
  }
});

app.get("/health", async (_request, reply) => {
  if (!sessionStore.isHealthy()) return reply.code(503).send({ ok: false });
  return { ok: true };
});

app.get("/api/status", async (request, reply) => {
  const session = getSession(request, reply);
  if (session.onshapeTokens && session.onshapeTokens.expiresAt <= Date.now()) {
    await refreshSessionTokens(session).catch((error) => {
      request.log.warn(logError(error), "Onshape access refresh failed");
    });
  }
  let codex: "connected" | "pending" | "disconnected" = session.codexLoginId ? "pending" : "disconnected";
  let codexRuntime: CodexRuntimeStatus | undefined;
  if (!session.codexLoginId && (session.codexConnected || env.INSTALLATION_TOKEN)) {
    try {
      const worker = workers.forUser(session.id);
      if (await worker.accountStatus() === "connected") {
        codex = "connected";
        codexRuntime = await worker.runtimeStatus();
        if (!session.codexConnected) {
          session.codexConnected = true;
          saveSession(session);
        }
      } else if (session.codexConnected) {
        delete session.codexConnected;
        saveSession(session);
      }
    } catch (error) {
      request.log.warn(logError(error), "Unable to read Codex account status");
    }
  }
  return {
    onshape: session.onshapeTokens ? "connected" : "disconnected",
    codex,
    ...(codexRuntime ? { codexRuntime } : {})
  };
});

app.get("/oauth/onshape/start", async (request, reply) => {
  const query = z.object({
    redirectOnshapeUri: z.string().url().max(2_048).optional(),
    companyId: z.string().min(1).max(200).optional(),
    installationToken: z.string().min(32).max(512).optional()
  }).passthrough().parse(request.query);
  const session = getOAuthStartSession(request, reply, query.installationToken);
  const oauthConfig = onshapeOAuthConfig();
  delete session.onshapeRedirectUri;
  if (query.redirectOnshapeUri) {
    const redirect = new URL(query.redirectOnshapeUri);
    if (!isSupportedOnshapeOrigin(redirect.origin)) {
      return reply.code(400).send({ error: "Invalid Onshape return URI." });
    }
    session.onshapeRedirectUri = redirect.toString();
  }
  session.onshapeState = randomBytes(24).toString("base64url");
  saveSession(session);
  return reply.redirect(buildOnshapeAuthorizationUrl(
    oauthConfig,
    session.onshapeState,
    query.companyId && query.companyId !== "cad" ? query.companyId : undefined
  ));
});

app.get("/oauth/onshape/callback", async (request, reply) => {
  const query = z.object({
    code: z.string().min(1).optional(),
    state: z.string().min(1),
    error: z.string().min(1).optional()
  }).passthrough().parse(request.query);
  const session = getOAuthCallbackSession(request, reply, query.state);
  if (!session.onshapeState || query.state !== session.onshapeState) {
    throw new HttpError(400, "Invalid or expired Onshape OAuth state.");
  }
  delete session.onshapeState;
  saveSession(session);
  if (query.error) {
    delete session.onshapeRedirectUri;
    saveSession(session);
    return reply.code(400).type("text/html").send(`<!doctype html><meta charset="utf-8"><title>Onshape access denied</title><main><h1>Onshape access was not granted</h1><p>No access was stored. Return to Onshape and grant MorAssistant when you are ready.</p></main>`);
  }
  if (!query.code) throw new HttpError(400, "Onshape did not return an authorization code.");
  session.onshapeTokens = await exchangeOnshapeCode(onshapeOAuthConfig(), query.code);
  saveSession(session);
  if (session.onshapeRedirectUri) {
    const redirectUri = session.onshapeRedirectUri;
    delete session.onshapeRedirectUri;
    saveSession(session);
    return reply.redirect(redirectUri);
  }
  return reply.type("text/html").send(`<!doctype html><meta charset="utf-8"><title>Onshape connected</title><main><h1>Onshape access granted</h1><p>Return to Onshape and reopen the MorAssistant panel.</p></main>`);
});

app.post("/api/codex/connect", async (request, reply) => {
  const session = getSession(request, reply);
  if (session.codexLoginId) return reply.code(409).send({ error: "A Codex sign-in is already pending." });
  if (session.codexConnected) return reply.code(409).send({ error: "Codex is already connected." });
  const worker = workers.forUser(session.id);
  let login;
  try {
    login = await worker.startDeviceCodeLogin();
  } catch (error) {
    workers.stopForUser(session.id);
    throw error;
  }
  session.codexLoginId = login.loginId;
  void worker.waitForLogin(login.loginId).then((success) => {
    delete session.codexLoginId;
    if (success) {
      session.codexConnected = true;
      saveSession(session);
    }
  }).catch((error) => {
    delete session.codexLoginId;
    request.log.warn(logError(error), "Codex device login did not complete");
  });
  return login;
});

app.get("/api/features", async (request, reply) => {
  const session = getSession(request, reply);
  const context = parseContext(request.query);
  const tree = await clientFor(session, context).listFeatures(context);
  return {
    features: tree.features.map((feature) => ({
      featureId: feature.featureId,
      name: feature.name,
      featureType: feature.featureType,
      parameters: feature.parameters?.filter((parameter) => typeof parameter.expression === "string")
        .map((parameter) => ({ parameterId: parameter.parameterId, expression: parameter.expression }))
    }))
  };
});

app.post("/api/plans", async (request, reply) => {
  const session = getSession(request, reply);
  const stored = await createStoredPlan(session, parsePlanRequest(request.body));
  reply.code(201);
  return stored;
});

app.post("/api/plan-jobs", async (request, reply) => {
  const session = getSession(request, reply);
  const body = parsePlanRequest(request.body);
  prunePlanJobs();
  if ([...planJobs.values()].some((job) => job.sessionId === session.id && job.status === "planning")) {
    return reply.code(409).send({ error: "A CAD plan is already being created for this session." });
  }

  const job: PlanJob = {
    id: randomUUID(),
    sessionId: session.id,
    status: "planning",
    createdAt: Date.now(),
    progress: [{ id: "inspection", kind: "inspection", message: "Reading the current Onshape model and live feature catalog.", at: Date.now() }]
  };
  planJobs.set(job.id, job);
  void createStoredPlan(session, body, undefined, (progress) => updatePlanJobProgress(job, progress)).then((plan) => {
    job.status = "completed";
    job.plan = plan;
  }).catch((error) => {
    job.status = "failed";
    job.error = planJobError(error);
    request.log.error(logError(error), "Background plan creation failed");
  });

  reply.code(202);
  return { id: job.id, status: job.status, progress: job.progress };
});

app.get("/api/plan-jobs/:id", async (request, reply) => {
  const session = getSession(request, reply);
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  prunePlanJobs();
  const job = planJobs.get(id);
  if (!job || job.sessionId !== session.id) return reply.code(404).send({ error: "Plan request not found." });
  if (job.status === "completed") return { id: job.id, status: job.status, progress: job.progress, plan: job.plan };
  if (job.status === "failed") return { id: job.id, status: job.status, progress: job.progress, error: job.error };
  return { id: job.id, status: job.status, progress: job.progress };
});

app.post("/api/plans/:id/recovery-jobs", async (request, reply) => {
  const session = getSession(request, reply);
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const failedPlan = session.plans.get(id);
  if (!failedPlan) return reply.code(404).send({ error: "Plan not found." });
  if (failedPlan.status !== "failed" || !failedPlan.result) {
    return reply.code(409).send({ error: "A recovery plan is available only after a failed execution." });
  }
  const existing = [...session.plans.values()].find((candidate) => candidate.recoveryForPlanId === failedPlan.id);
  if (existing) return { id: randomUUID(), status: "completed", plan: existing };
  prunePlanJobs();
  if ([...planJobs.values()].some((job) => job.sessionId === session.id && job.status === "planning")) {
    return reply.code(409).send({ error: "A CAD plan is already being created for this session." });
  }
  const job: PlanJob = {
    id: randomUUID(),
    sessionId: session.id,
    status: "planning",
    createdAt: Date.now(),
    progress: [{ id: "inspection", kind: "inspection", message: "Re-reading the changed Onshape model for recovery.", at: Date.now() }]
  };
  planJobs.set(job.id, job);
  void createStoredPlan(
    session,
    { prompt: recoveryPrompt(failedPlan), context: failedPlan.context },
    failedPlan.id,
    (progress) => updatePlanJobProgress(job, progress)
  ).then((plan) => {
    job.status = "completed";
    job.plan = plan;
  }).catch((error) => {
    job.status = "failed";
    job.error = planJobError(error);
    request.log.error(logError(error), "Background recovery planning failed");
  });
  reply.code(202);
  return { id: job.id, status: job.status, progress: job.progress };
});

app.post("/api/plans/:id/apply", async (request, reply) => {
  const session = getSession(request, reply);
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const plan = session.plans.get(id);
  if (!plan) return reply.code(404).send({ error: "Plan not found." });
  if (plan.status !== "pending") return reply.code(409).send({ error: `Plan is already ${plan.status}.` });

  const client = clientFor(session, plan.context);
  const snapshotKey = partStudioSnapshotKey(plan.context);
  plan.status = "applying";
  saveSession(session);
  let preexistingRegenerationErrors: RegenerationError[];
  let currentTree: FeatureListResponse;
  let usedStoredSnapshot = false;
  try {
    const snapshot = session.partStudioSnapshots.get(snapshotKey);
    const canUseGuardedSnapshot = Boolean(
      snapshot
      && plan.sourceMicroversion
      && snapshot.tree.sourceMicroversion === plan.sourceMicroversion
      && !plan.operations.some((operation) => operation.type === "delete_feature")
    );
    if (canUseGuardedSnapshot) {
      currentTree = snapshot!.tree;
      usedStoredSnapshot = true;
    } else {
      currentTree = await client.listFeatures(plan.context);
      storePartStudioSnapshot(session, snapshotKey, currentTree);
    }
    if (plan.sourceMicroversion && currentTree.sourceMicroversion !== plan.sourceMicroversion) {
      throw new Error("The Part Studio changed after the plan preview. Create a fresh plan before applying changes.");
    }
    validatePlanAgainstIntent(plan.prompt, validatePlanAgainstFeatureTree(plan, featuresWithHashes(currentTree.features)));
    preexistingRegenerationErrors = client.regenerationErrors(currentTree);
  } catch (error) {
    plan.status = "pending";
    saveSession(session);
    throw error;
  }
  const operations: OperationExecutionResult[] = [];
  const preexistingKeys = new Set(preexistingRegenerationErrors.map((item) =>
    `${item.featureId}\u0000${item.status}\u0000${item.message ?? ""}`
  ));
  let regenerationErrors = [] as typeof preexistingRegenerationErrors;

  for (const [index, operation] of plan.operations.entries()) {
    try {
      const applied = await client.applyOperationDetailed(plan.context, operation, currentTree);
      let verification: OperationExecutionResult["verification"] = "passed";
      let verificationNote = "";
      let currentErrors: RegenerationError[];
      const responseTree = treeFromMutationResponse(currentTree, operation, applied.response);
      if (responseTree) {
        currentTree = responseTree;
        storePartStudioSnapshot(session, snapshotKey, currentTree);
        currentErrors = client.regenerationErrors(currentTree);
        verificationNote = usedStoredSnapshot
          ? " Onshape's mutation response supplied the new guarded microversion and regeneration state without another feature-list read."
          : "";
      } else {
        try {
          currentTree = await client.listFeatures(plan.context);
          storePartStudioSnapshot(session, snapshotKey, currentTree);
          currentErrors = client.regenerationErrors(currentTree);
        } catch (error) {
          verification = "not_run";
          currentErrors = [{
            featureId: "unknown",
            featureName: "Regeneration check",
            status: "CHECK_FAILED",
            message: error instanceof Error ? error.message : "Unable to check regeneration status."
          }];
        }
      }
      regenerationErrors = currentErrors.filter((item) => !preexistingKeys.has(
        `${item.featureId}\u0000${item.status}\u0000${item.message ?? ""}`
      ));
      if (regenerationErrors.length > 0) {
        operations.push({
          index,
          operation,
          status: verification === "not_run" ? "applied" : "failed",
          verification: verification === "not_run" ? "not_run" : "failed",
          message: verification === "not_run"
            ? `${applied.message} The change was accepted, but regeneration verification could not run; execution stopped before any later operation.`
            : `${applied.message} Onshape regeneration then reported ${regenerationErrors.length} new error${regenerationErrors.length === 1 ? "" : "s"}; execution stopped.`
        });
        break;
      }
      operations.push({
        index,
        operation,
        status: "applied",
        verification,
        message: `${applied.message}${verificationNote}`
      });
    } catch (error) {
      operations.push({
        index,
        operation,
        status: "failed",
        verification: "not_run",
        message: error instanceof Error ? error.message : "Unknown operation failure."
      });
      break;
    }
  }

  const failed = operations.length < plan.operations.length
    || operations.some((operation) => operation.status === "failed")
    || regenerationErrors.length > 0;
  plan.status = failed ? "failed" : "applied";
  plan.result = {
    status: plan.status,
    operations,
    regenerationErrors,
    preexistingRegenerationErrors
  };
  saveSession(session);
  return plan;
});

app.setErrorHandler((error, request, reply) => {
  const status = error instanceof z.ZodError
    ? 400
    : error instanceof HttpError
      ? error.statusCode
      : error instanceof OnshapeApiError
        ? ([401, 403, 404, 409, 429].includes(error.status) ? error.status : 502)
        : /changed since preview|changed after the plan|no longer exists/i.test(error instanceof Error ? error.message : "")
          ? 409
          : /not configured|not available for this installed extension|worker capacity is temporarily full/i.test(error instanceof Error ? error.message : "")
            ? 503
            : 500;
  if (status >= 500) request.log.error(logError(error), "Request failed");
  else request.log.warn(logError(error), "Request rejected");
  reply.code(status).send({
    error: error instanceof z.ZodError ? "Invalid request." : error instanceof Error ? error.message : "Internal server error.",
    ...(error instanceof z.ZodError ? { details: error.issues } : {})
  });
});

const panelDist = resolve(repositoryRoot, "apps/onshape-panel/dist");
if (existsSync(panelDist)) {
  await app.register(fastifyStatic, { root: panelDist, wildcard: false });
}

const shutdown = async () => {
  workers.stopAll();
  await app.close();
  sessionStore.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ host: env.HOST, port: env.PORT });

export type { PartStudioContext };
