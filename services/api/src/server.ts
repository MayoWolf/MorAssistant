import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  validatePlanAgainstFeatureTree,
  type OperationExecutionResult,
  type StoredCadPlan
} from "@morassistant/cad-command-schema";
import { CodexWorkerPool } from "@morassistant/codex-worker";
import {
  buildOnshapeAuthorizationUrl,
  exchangeOnshapeCode,
  OnshapeClient,
  OnshapeApiError,
  refreshOnshapeTokens,
  type OnshapeOAuthConfig,
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
  ONSHAPE_CLIENT_ID: z.string().min(1).optional(),
  ONSHAPE_CLIENT_SECRET: z.string().min(1).optional(),
  ONSHAPE_REDIRECT_URI: z.string().url().optional(),
  ONSHAPE_AUTHORIZATION_URL: z.string().url().default("https://oauth.onshape.com/oauth/authorize"),
  ONSHAPE_TOKEN_URL: z.string().url().default("https://oauth.onshape.com/oauth/token"),
  ONSHAPE_BASE_URL: z.string().url().default("https://cad.onshape.com"),
  ONSHAPE_API_VERSION: z.string().default("v13"),
  CODEX_MODEL: z.string().min(1).optional(),
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
  env.CODEX_COMMAND,
  env.CODEX_MAX_WORKERS,
  env.CODEX_IDLE_TIMEOUT_MS
);

function saveSession(session: UserSession): void {
  sessionStore.save(session);
}

function getSession(request: FastifyRequest, reply: FastifyReply): UserSession {
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
    ...(context.configuration ? { configuration: context.configuration } : {}),
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
  if (session.codexConnected) {
    try {
      if (await workers.forUser(session.id).accountStatus() === "connected") codex = "connected";
      else {
        delete session.codexConnected;
        saveSession(session);
      }
    } catch (error) {
      request.log.warn(logError(error), "Unable to read Codex account status");
    }
  }
  return { onshape: session.onshapeTokens ? "connected" : "disconnected", codex };
});

app.get("/oauth/onshape/start", async (request, reply) => {
  const session = getSession(request, reply);
  const oauthConfig = onshapeOAuthConfig();
  const query = z.object({
    redirectOnshapeUri: z.string().url().max(2_048).optional(),
    companyId: z.string().min(1).max(200).optional()
  }).passthrough().parse(request.query);
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
  const session = getSession(request, reply);
  const query = z.object({
    code: z.string().min(1).optional(),
    state: z.string().min(1),
    error: z.string().min(1).optional()
  }).passthrough().parse(request.query);
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
  const input = z.object({ prompt: z.string().trim().min(3).max(4_000), context: z.unknown() }).strict().parse(request.body);
  const body = { prompt: input.prompt, context: parseContext(input.context) };
  const client = clientFor(session, body.context);
  const featureTree = await client.listFeatures(body.context);
  const plan = cadPlanSchema.parse(await workers.forUser(session.id).createPlan(body.prompt, featureTree));
  validatePlanAgainstFeatureTree(plan, featureTree.features);
  if (body.context.configuration && plan.operations.some((operation) => operation.type === "update_dimension")) {
    throw new HttpError(409, "Dimension edits in configured Part Studios are not supported yet. Rename operations remain available.");
  }
  const stored: StoredCadPlan = {
    ...plan,
    id: randomUUID(),
    context: body.context,
    prompt: body.prompt,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  while (session.plans.size >= 100) {
    const oldestPlanId = session.plans.keys().next().value as string | undefined;
    if (!oldestPlanId) break;
    session.plans.delete(oldestPlanId);
  }
  session.plans.set(stored.id, stored);
  saveSession(session);
  reply.code(201);
  return stored;
});

app.post("/api/plans/:id/apply", async (request, reply) => {
  const session = getSession(request, reply);
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const plan = session.plans.get(id);
  if (!plan) return reply.code(404).send({ error: "Plan not found." });
  if (plan.status !== "pending") return reply.code(409).send({ error: `Plan is already ${plan.status}.` });

  const client = clientFor(session, plan.context);
  plan.status = "applying";
  saveSession(session);
  try {
    const currentTree = await client.listFeatures(plan.context);
    validatePlanAgainstFeatureTree(plan, currentTree.features);
  } catch (error) {
    plan.status = "pending";
    saveSession(session);
    throw error;
  }
  const operations: OperationExecutionResult[] = [];

  for (const [index, operation] of plan.operations.entries()) {
    try {
      const message = await client.applyOperation(plan.context, operation);
      operations.push({ index, operation, status: "applied", message });
    } catch (error) {
      operations.push({
        index,
        operation,
        status: "failed",
        message: error instanceof Error ? error.message : "Unknown operation failure."
      });
      break;
    }
  }

  const regenerationErrors = await client.inspectRegenerationErrors(plan.context).catch((error) => [{
    featureId: "unknown",
    featureName: "Regeneration check",
    status: "CHECK_FAILED",
    message: error instanceof Error ? error.message : "Unable to check regeneration status."
  }]);
  const failed = operations.some((operation) => operation.status === "failed") || regenerationErrors.length > 0;
  plan.status = failed ? "failed" : "applied";
  plan.result = { status: plan.status, operations, regenerationErrors };
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
