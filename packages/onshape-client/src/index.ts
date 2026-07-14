import { createHash } from "node:crypto";
import { parseFeatureJson, type CadOperation, type RegenerationError } from "@morassistant/cad-command-schema";
import type { PartStudioContext } from "@morassistant/shared-types";
import { buildRectangleSketchFeature } from "./rectangle-sketch.js";
import { buildCircleSketchFeature, buildExtrudeFeature, buildFilletFeature } from "./native-features.js";

export { buildRectangleSketchFeature } from "./rectangle-sketch.js";
export {
  buildCircleSketchFeature,
  buildExtrudeFeature,
  buildFilletFeature,
  type CircleSketchInput,
  type ExtrudeFeatureInput,
  type ExtrudeOperation,
  type FilletFeatureInput
} from "./native-features.js";

export interface OnshapeOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationUrl?: string;
  tokenUrl?: string;
}

export interface OnshapeTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
}

export interface FeatureParameter {
  btType?: string;
  parameterId?: string;
  expression?: string;
  [key: string]: unknown;
}

export interface OnshapeFeature {
  btType?: string;
  featureId: string;
  featureType?: string;
  name?: string;
  parameters?: FeatureParameter[];
  featureStatus?: string;
  [key: string]: unknown;
}

export interface FeatureListResponse {
  features: OnshapeFeature[];
  featureStates?: unknown;
  serializationVersion?: string;
  sourceMicroversion?: string;
  [key: string]: unknown;
}

export interface FeatureDependencyNode {
  featureId: string;
  name: string;
  featureType: string;
  status: string;
  index: number;
  dependsOn: string[];
  usedBy: string[];
}

export interface PartStudioGeometrySummary {
  bodyCount?: number;
  solidBodyCount?: number;
  faceCount?: number;
  edgeCount?: number;
  vertexCount?: number;
  partCount?: number;
  volumeM3?: number;
  massKg?: number;
  centroidM?: [number, number, number];
}

export interface PartStudioInspection {
  featureTree: FeatureListResponse;
  dependencies: FeatureDependencyNode[];
  geometry: PartStudioGeometrySummary;
  bodyDetails?: unknown;
  massProperties?: unknown;
  topologyEvaluation?: unknown;
  warnings: string[];
}

export interface PartStudioGeometryEvidence {
  bodyDetails?: unknown;
  massProperties?: unknown;
  topologyEvaluation?: unknown;
  warnings: string[];
}

export interface FeatureUpdateConcurrency {
  serializationVersion?: string;
  sourceMicroversion?: string;
}

export interface AppliedOperation {
  message: string;
  response: unknown;
}

function upstreamErrorDetail(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "errorMessage", "error_description", "error"]) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const clean = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
    if (clean) return clean.slice(0, 300);
  }
  return undefined;
}

export function featureFingerprint(feature: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(feature)).digest("hex");
}

function referencedFeatureIds(feature: OnshapeFeature, knownIds: Set<string>): string[] {
  const references = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (knownIds.has(value)) references.add(value);
      for (const token of value.match(/[A-Za-z0-9_~-]{3,}/gu) ?? []) {
        if (knownIds.has(token)) references.add(token);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(feature);
  references.delete(feature.featureId);
  return [...references];
}

export function buildFeatureDependencyGraph(tree: FeatureListResponse): FeatureDependencyNode[] {
  const knownIds = new Set(tree.features.map((feature) => feature.featureId));
  const states = normalizeFeatureStates(tree.featureStates);
  const nodes = tree.features.map((feature, index) => ({
    featureId: feature.featureId,
    name: feature.name ?? feature.featureId,
    featureType: feature.featureType ?? "unknown",
    status: String(states.get(feature.featureId)?.featureStatus ?? feature.featureStatus ?? "OK"),
    index,
    dependsOn: referencedFeatureIds(feature, knownIds),
    usedBy: [] as string[]
  }));
  const byId = new Map(nodes.map((node) => [node.featureId, node]));
  for (const node of nodes) {
    for (const dependency of node.dependsOn) byId.get(dependency)?.usedBy.push(node.featureId);
  }
  return nodes;
}

function topologyCounts(value: unknown): PartStudioGeometrySummary {
  const summary: PartStudioGeometrySummary = {};
  type CountKey = "bodyCount" | "faceCount" | "edgeCount" | "vertexCount";
  const countKeys = new Map<string, CountKey>([
    ["bodies", "bodyCount"],
    ["faces", "faceCount"],
    ["edges", "edgeCount"],
    ["vertices", "vertexCount"]
  ]);
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      const target = countKeys.get(key.toLocaleLowerCase());
      if (target && Array.isArray(child)) summary[target] = (summary[target] ?? 0) + child.length;
      visit(child);
    }
  };
  visit(value);
  return summary;
}

function firstFinite(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return firstFinite(value[0]);
  return undefined;
}

function featureScriptPrimitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(featureScriptPrimitive);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.value)) {
    const entries = record.value as unknown[];
    if (entries.every((entry) => entry && typeof entry === "object" && "key" in entry && "value" in entry)) {
      return Object.fromEntries(entries.map((entry) => {
        const pair = entry as Record<string, unknown>;
        return [String(featureScriptPrimitive(pair.key)), featureScriptPrimitive(pair.value)];
      }));
    }
    return entries.map(featureScriptPrimitive);
  }
  if ("value" in record && Object.keys(record).every((key) => ["btType", "typeTag", "value"].includes(key))) {
    return featureScriptPrimitive(record.value);
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, featureScriptPrimitive(child)]));
}

function geometrySummary(bodyDetails: unknown, massProperties: unknown, topologyEvaluation: unknown): PartStudioGeometrySummary {
  const summary = topologyCounts(bodyDetails);
  const mass = massProperties && typeof massProperties === "object"
    ? (massProperties as Record<string, unknown>).bodies
    : undefined;
  if (mass && typeof mass === "object" && !Array.isArray(mass)) {
    const bodies = mass as Record<string, unknown>;
    summary.partCount = Object.keys(bodies).filter((key) => key !== "-all-").length;
    const aggregate = bodies["-all-"];
    if (aggregate && typeof aggregate === "object") {
      const record = aggregate as Record<string, unknown>;
      const volumeM3 = firstFinite(record.volume);
      const massKg = firstFinite(record.mass);
      if (volumeM3 !== undefined) summary.volumeM3 = volumeM3;
      if (massKg !== undefined) summary.massKg = massKg;
      if (Array.isArray(record.centroid) && record.centroid.length >= 3) {
        const centroid = record.centroid.slice(0, 3);
        if (centroid.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))) {
          summary.centroidM = centroid as [number, number, number];
        }
      }
    }
  }
  const decoded = featureScriptPrimitive(
    topologyEvaluation && typeof topologyEvaluation === "object"
      ? (topologyEvaluation as Record<string, unknown>).result
      : topologyEvaluation
  );
  if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
    const record = decoded as Record<string, unknown>;
    for (const key of ["solidBodyCount", "faceCount", "edgeCount", "vertexCount"] as const) {
      const value = firstFinite(record[key]);
      if (value !== undefined) summary[key] = value;
    }
  }
  return summary;
}

function resolveFeatureReferences(value: unknown, features: OnshapeFeature[]): unknown {
  if (typeof value === "string" && value.startsWith("@feature:")) {
    const name = value.slice("@feature:".length).trim();
    const feature = features.find((candidate) => candidate.name?.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (!feature) throw new Error(`Referenced feature ${name} was not found.`);
    return feature.featureId;
  }
  if (Array.isArray(value)) return value.map((item) => resolveFeatureReferences(item, features));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveFeatureReferences(item, features)]));
  }
  return value;
}

function canonicalizeFeaturePayload(feature: Record<string, unknown>): Record<string, unknown> {
  const canonical = structuredClone(feature);
  if (canonical.featureType === "extrude" && Array.isArray(canonical.parameters)) {
    canonical.namespace ??= "";
    canonical.suppressed ??= false;
    canonical.returnAfterSubfeatures ??= false;
    canonical.subFeatures ??= [];
    canonical.parameterLibraries ??= [];
    canonical.suppressionState ??= null;
    const enumNames: Record<string, string> = {
      bodyType: "ExtendedToolBodyType",
      operationType: "NewBodyOperationType",
      endBound: "BoundingType",
      startBound: "BoundingType",
      secondDirectionBound: "BoundingType"
    };
    for (const parameter of canonical.parameters) {
      if (parameter && typeof parameter === "object") {
        const record = parameter as Record<string, unknown>;
        record.libraryRelationType ??= "DEFAULT";
        record.parameterName ??= "";
        const parameterId = typeof record.parameterId === "string" ? record.parameterId : "";
        if (record.btType === "BTMParameterEnum-145" && enumNames[parameterId]) {
          record.namespace ??= "";
          record.enumName = enumNames[parameterId];
        }
        if (record.btType === "BTMParameterQuantity-147") {
          record.isInteger ??= false;
          record.value ??= 0;
          record.units ??= "";
        }
        if (record.btType === "BTMParameterQueryList-148" && Array.isArray(record.queries)) {
          for (const query of record.queries) {
            if (!query || typeof query !== "object") continue;
            const queryRecord = query as Record<string, unknown>;
            if (queryRecord.btType !== "BTMIndividualSketchRegionQuery-140" || typeof queryRecord.featureId !== "string") continue;
            queryRecord.queryStatement ??= null;
            queryRecord.filterInnerLoops ??= false;
            queryRecord.deterministicIds ??= ["JOC"];
            queryRecord.queryString ??= `query = qSketchRegion(id + ${JSON.stringify(`F${queryRecord.featureId}`)}, false);`;
          }
        }
      }
    }
    const parameters = canonical.parameters as Array<Record<string, unknown>>;
    const ensureBoolean = (parameterId: string): void => {
      if (parameters.some((parameter) => parameter?.parameterId === parameterId)) return;
      parameters.push({
        btType: "BTMParameterBoolean-144",
        libraryRelationType: "DEFAULT",
        value: false,
        parameterId,
        parameterName: ""
      });
    };
    ensureBoolean("oppositeDirection");
    ensureBoolean("symmetric");
  }
  return canonical;
}

export class OnshapeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly retryAfterSeconds?: number,
    readonly rateLimitRemaining?: number
  ) {
    super(message);
    this.name = "OnshapeApiError";
  }
}

export function buildOnshapeAuthorizationUrl(config: OnshapeOAuthConfig, state: string, companyId?: string): string {
  const url = new URL(config.authorizationUrl ?? "https://oauth.onshape.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  if (companyId) url.searchParams.set("company_id", companyId);
  return url.toString();
}

async function exchange(config: OnshapeOAuthConfig, params: URLSearchParams): Promise<OnshapeTokens> {
  params.set("client_id", config.clientId);
  params.set("client_secret", config.clientSecret);
  const response = await fetch(config.tokenUrl ?? "https://oauth.onshape.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: params
  });
  const body = await response.json().catch(() => null) as TokenResponse | null;
  if (
    !response.ok ||
    !body?.access_token ||
    !body.refresh_token ||
    typeof body.expires_in !== "number" ||
    !Number.isFinite(body.expires_in)
  ) {
    const record = body && typeof body === "object" ? body as unknown as Record<string, unknown> : null;
    throw new OnshapeApiError("Onshape OAuth token exchange failed.", response.status, record ? {
      ...(typeof record.error === "string" ? { error: record.error } : {}),
      ...(typeof record.error_description === "string" ? { errorDescription: record.error_description } : {})
    } : null);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + Math.max(0, body.expires_in - 60) * 1000,
    tokenType: body.token_type ?? "Bearer"
  };
}

export function exchangeOnshapeCode(config: OnshapeOAuthConfig, code: string): Promise<OnshapeTokens> {
  return exchange(config, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri
  }));
}

export function refreshOnshapeTokens(config: OnshapeOAuthConfig, refreshToken: string): Promise<OnshapeTokens> {
  return exchange(config, new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }));
}

export interface OnshapeClientOptions {
  accessToken: () => Promise<string> | string;
  refreshAccessToken?: () => Promise<string>;
  baseUrl?: string;
  apiVersion?: string;
}

export class OnshapeClient {
  private readonly baseUrl: string;
  private readonly apiVersion: string;

  constructor(private readonly options: OnshapeClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://cad.onshape.com").replace(/\/$/, "");
    this.apiVersion = options.apiVersion ?? "v16";
  }

  private async request<T>(path: string, init: RequestInit = {}, retryAuth = true, rateLimitAttempt = 0): Promise<T> {
    const accessToken = await this.options.accessToken();
    const response = await fetch(`${this.baseUrl}/api/${this.apiVersion}${path}`, {
      ...init,
      headers: {
        accept: "application/json;charset=UTF-8; qs=0.09",
        authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "content-type": "application/json;charset=UTF-8; qs=0.09" } : {}),
        ...init.headers
      },
      redirect: "follow"
    });

    if (response.status === 401 && retryAuth && this.options.refreshAccessToken) {
      await this.options.refreshAccessToken();
      return this.request<T>(path, init, false, rateLimitAttempt);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("json")
      ? await response.json().catch(() => null)
      : await response.text().catch(() => "");
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader === null
        ? Math.min(2 ** rateLimitAttempt, 5)
        : /^\d+(?:\.\d+)?$/u.test(retryAfterHeader.trim())
          ? Number(retryAfterHeader)
          : Math.max(0, (Date.parse(retryAfterHeader) - Date.now()) / 1_000);
      if (rateLimitAttempt < 2 && Number.isFinite(retryAfterSeconds) && retryAfterSeconds <= 30) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, retryAfterSeconds) * 1_000));
        return this.request<T>(path, init, retryAuth, rateLimitAttempt + 1);
      }
      const remainingHeader = response.headers.get("x-rate-limit-remaining");
      const rateLimitRemaining = remainingHeader !== null && Number.isFinite(Number(remainingHeader))
        ? Number(remainingHeader)
        : undefined;
      const retryMessage = Number.isFinite(retryAfterSeconds)
        ? ` Onshape asked MorAssistant to retry in ${Math.ceil(retryAfterSeconds)} seconds.`
        : " Try again after Onshape's endpoint rate-limit window resets.";
      throw new OnshapeApiError(
        `Onshape API rate limit reached.${retryMessage}`,
        response.status,
        body,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
        rateLimitRemaining
      );
    }
    if (!response.ok) {
      const detail = upstreamErrorDetail(body);
      throw new OnshapeApiError(
        `Onshape API request failed (${response.status}).${detail ? ` ${detail}` : ""}`,
        response.status,
        body
      );
    }
    return body as T;
  }

  async listFeatures(context: PartStudioContext): Promise<FeatureListResponse> {
    const query = new URLSearchParams({
      rollbackBarIndex: "-1",
      includeGeometryIds: "true",
      noSketchGeometry: "false"
    });
    if (context.configuration) query.set("configuration", context.configuration);
    return this.request<FeatureListResponse>(
      `/partstudios/d/${encodeURIComponent(context.documentId)}/w/${encodeURIComponent(context.workspaceId)}/e/${encodeURIComponent(context.elementId)}/features?${query}`
    );
  }

  async getBodyDetails(context: PartStudioContext): Promise<unknown> {
    const query = new URLSearchParams();
    if (context.configuration) query.set("configuration", context.configuration);
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.request(
      `/partstudios/d/${encodeURIComponent(context.documentId)}/w/${encodeURIComponent(context.workspaceId)}/e/${encodeURIComponent(context.elementId)}/bodydetails${suffix}`
    );
  }

  async getMassProperties(context: PartStudioContext): Promise<unknown> {
    const query = new URLSearchParams();
    if (context.configuration) query.set("configuration", context.configuration);
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.request(
      `/partstudios/d/${encodeURIComponent(context.documentId)}/w/${encodeURIComponent(context.workspaceId)}/e/${encodeURIComponent(context.elementId)}/massproperties${suffix}`
    );
  }

  async evaluateFeatureScript(context: PartStudioContext, script: string, libraryVersion?: number): Promise<unknown> {
    const query = new URLSearchParams({ rollbackBarIndex: "-1" });
    if (context.configuration) query.set("configuration", context.configuration);
    return this.request(
      `/partstudios/d/${encodeURIComponent(context.documentId)}/w/${encodeURIComponent(context.workspaceId)}/e/${encodeURIComponent(context.elementId)}/featurescript?${query}`,
      {
        method: "POST",
        body: JSON.stringify({ script, ...(libraryVersion ? { libraryVersion } : {}) })
      }
    );
  }

  async getTransientIdsForFeatureEdges(
    context: PartStudioContext,
    featureId: string,
    libraryVersion?: number
  ): Promise<string[]> {
    const script = [
      "function(context is Context, definition is map)",
      "{",
      "    var ids = [];",
      `    for (var edge in evaluateQuery(context, qCreatedBy(makeId(${JSON.stringify(featureId)}), EntityType.EDGE)))`,
      "    {",
      "        ids = append(ids, edge.transientId);",
      "    }",
      "    return ids;",
      "}"
    ].join("\n");
    const response = await this.evaluateFeatureScript(context, script, libraryVersion);
    const result = response && typeof response === "object"
      ? featureScriptPrimitive((response as Record<string, unknown>).result)
      : undefined;
    if (!Array.isArray(result) || !result.every((item) => typeof item === "string" && item.length > 0)) {
      throw new Error(`Onshape did not return a valid edge selection for feature ${featureId}.`);
    }
    return [...new Set(result)];
  }

  async inspectPartStudio(
    context: PartStudioContext,
    existingFeatureTree?: FeatureListResponse,
    existingGeometry?: PartStudioGeometryEvidence
  ): Promise<PartStudioInspection> {
    const featureTree = existingFeatureTree ?? await this.listFeatures(context);
    const topologyScript = [
      "function(context is Context, definition is map)",
      "{",
      "    return {",
      '        "solidBodyCount" : size(evaluateQuery(context, qBodyType(qEverything(EntityType.BODY), BodyType.SOLID))),',
      '        "faceCount" : size(evaluateQuery(context, qEverything(EntityType.FACE))),',
      '        "edgeCount" : size(evaluateQuery(context, qEverything(EntityType.EDGE))),',
      '        "vertexCount" : size(evaluateQuery(context, qEverything(EntityType.VERTEX)))',
      "    };",
      "}"
    ].join("\n");
    let geometry = existingGeometry;
    if (!geometry) {
      const [bodyResult, massResult, topologyResult] = await Promise.allSettled([
        this.getBodyDetails(context),
        this.getMassProperties(context),
        this.evaluateFeatureScript(context, topologyScript, typeof featureTree.libraryVersion === "number" ? featureTree.libraryVersion : undefined)
      ]);
      const warnings: string[] = [];
      if (bodyResult.status === "rejected") warnings.push("Onshape body details were unavailable; feature-level planning remains available.");
      if (massResult.status === "rejected") warnings.push("Onshape mass properties were unavailable; dimensional and feature planning remains available.");
      if (topologyResult.status === "rejected") warnings.push("The read-only FeatureScript topology probe was unavailable.");
      geometry = {
        ...(bodyResult.status === "fulfilled" ? { bodyDetails: bodyResult.value } : {}),
        ...(massResult.status === "fulfilled" ? { massProperties: massResult.value } : {}),
        ...(topologyResult.status === "fulfilled" ? { topologyEvaluation: topologyResult.value } : {}),
        warnings
      };
    }
    const { bodyDetails, massProperties, topologyEvaluation, warnings } = geometry;
    return {
      featureTree,
      dependencies: buildFeatureDependencyGraph(featureTree),
      geometry: geometrySummary(bodyDetails, massProperties, topologyEvaluation),
      ...(bodyDetails !== undefined ? { bodyDetails } : {}),
      ...(massProperties !== undefined ? { massProperties } : {}),
      ...(topologyEvaluation !== undefined ? { topologyEvaluation } : {}),
      warnings
    };
  }

  async updateFeature(
    context: PartStudioContext,
    feature: OnshapeFeature,
    concurrency: FeatureUpdateConcurrency = {}
  ): Promise<unknown> {
    return this.request(
      `/partstudios/d/${encodeURIComponent(context.documentId)}/w/${encodeURIComponent(context.workspaceId)}/e/${encodeURIComponent(context.elementId)}/features/featureid/${encodeURIComponent(feature.featureId)}`,
      {
        method: "POST",
        body: JSON.stringify({
          btType: "BTFeatureDefinitionCall-1406",
          feature,
          ...(concurrency.serializationVersion ? { serializationVersion: concurrency.serializationVersion } : {}),
          ...(concurrency.sourceMicroversion ? {
            sourceMicroversion: concurrency.sourceMicroversion,
            rejectMicroversionSkew: true
          } : {})
        })
      }
    );
  }

  async addFeature(
    context: PartStudioContext,
    feature: Record<string, unknown>,
    concurrency: FeatureUpdateConcurrency = {}
  ): Promise<unknown> {
    return this.request(
      `/partstudios/d/${encodeURIComponent(context.documentId)}/w/${encodeURIComponent(context.workspaceId)}/e/${encodeURIComponent(context.elementId)}/features`,
      {
        method: "POST",
        body: JSON.stringify({
          btType: "BTFeatureDefinitionCall-1406",
          feature,
          ...(concurrency.serializationVersion ? { serializationVersion: concurrency.serializationVersion } : {}),
          ...(concurrency.sourceMicroversion ? {
            sourceMicroversion: concurrency.sourceMicroversion,
            rejectMicroversionSkew: true
          } : {})
        })
      }
    );
  }

  async deleteFeature(context: PartStudioContext, featureId: string): Promise<unknown> {
    const query = new URLSearchParams();
    if (context.configuration) query.set("configuration", context.configuration);
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.request(
      `/partstudios/d/${encodeURIComponent(context.documentId)}/w/${encodeURIComponent(context.workspaceId)}/e/${encodeURIComponent(context.elementId)}/features/featureid/${encodeURIComponent(featureId)}${suffix}`,
      { method: "DELETE" }
    );
  }

  async applyOperationDetailed(
    context: PartStudioContext,
    operation: CadOperation,
    featureTree?: FeatureListResponse
  ): Promise<AppliedOperation> {
    const tree = featureTree ?? await this.listFeatures(context);
    if (operation.type === "create_rectangle_sketch") {
      if (tree.features.some((feature) => feature.name?.toLocaleLowerCase() === operation.sketchName.toLocaleLowerCase())) {
        throw new Error(`A feature named ${operation.sketchName} already exists.`);
      }
      const response = await this.addFeature(context, buildRectangleSketchFeature({
        name: operation.sketchName,
        widthMm: operation.widthMm,
        heightMm: operation.heightMm,
        centerXmm: operation.centerXmm,
        centerYmm: operation.centerYmm
      }), tree);
      return {
        message: `Created ${operation.sketchName}: ${operation.widthMm} mm × ${operation.heightMm} mm on the Top plane.`,
        response
      };
    }

    if (operation.type === "create_circle_sketch") {
      if (tree.features.some((feature) => feature.name?.toLocaleLowerCase() === operation.sketchName.toLocaleLowerCase())) {
        throw new Error(`A feature named ${operation.sketchName} already exists.`);
      }
      const response = await this.addFeature(context, buildCircleSketchFeature({
        name: operation.sketchName,
        radiusMm: operation.radiusMm,
        centerXmm: operation.centerXmm,
        centerYmm: operation.centerYmm
      }), tree);
      return {
        message: `Created ${operation.sketchName}: Ø${operation.radiusMm * 2} mm on the Top plane.`,
        response
      };
    }

    if (operation.type === "extrude_sketch") {
      if (tree.features.some((feature) => feature.name?.toLocaleLowerCase() === operation.featureName.toLocaleLowerCase())) {
        throw new Error(`A feature named ${operation.featureName} already exists.`);
      }
      const source = tree.features.find(
        (feature) => feature.name?.toLocaleLowerCase() === operation.sourceFeatureName.toLocaleLowerCase()
      );
      if (!source) throw new Error(`Extrude source sketch ${operation.sourceFeatureName} was not found.`);
      if (source.featureType !== "newSketch") throw new Error(`${operation.sourceFeatureName} is not a sketch.`);
      const response = await this.addFeature(context, buildExtrudeFeature({
        name: operation.featureName,
        sketchFeatureId: source.featureId,
        depthMm: operation.depthMm,
        operation: operation.operation,
        oppositeDirection: operation.oppositeDirection,
        symmetric: operation.symmetric
      }), tree);
      const verb = operation.operation === "REMOVE" ? "Cut" : operation.operation === "ADD" ? "Added" : "Extruded";
      return {
        message: `${verb} ${operation.sourceFeatureName} by ${operation.depthMm} mm as ${operation.featureName} (${operation.operation}).`,
        response
      };
    }

    if (operation.type === "fillet_feature_edges") {
      if (tree.features.some((feature) => feature.name?.toLocaleLowerCase() === operation.featureName.toLocaleLowerCase())) {
        throw new Error(`A feature named ${operation.featureName} already exists.`);
      }
      const target = tree.features.find(
        (feature) => feature.name?.toLocaleLowerCase() === operation.targetFeatureName.toLocaleLowerCase()
      );
      if (!target) throw new Error(`Fillet target ${operation.targetFeatureName} was not found.`);
      const edgeTransientIds = await this.getTransientIdsForFeatureEdges(
        context,
        target.featureId,
        typeof tree.libraryVersion === "number" ? tree.libraryVersion : undefined
      );
      if (edgeTransientIds.length === 0) {
        throw new Error(`${operation.targetFeatureName} did not create any filletable edges.`);
      }
      const response = await this.addFeature(context, buildFilletFeature({
        name: operation.featureName,
        edgeTransientIds,
        radiusMm: operation.radiusMm,
        tangentPropagation: operation.tangentPropagation
      }), tree);
      return {
        message: `Created ${operation.featureName}: ${operation.radiusMm} mm fillet on edges created by ${operation.targetFeatureName}.`,
        response
      };
    }

    if (operation.type === "create_feature") {
      if (tree.features.some((feature) => feature.name?.toLocaleLowerCase() === operation.featureName.toLocaleLowerCase())) {
        throw new Error(`A feature named ${operation.featureName} already exists.`);
      }
      const feature = canonicalizeFeaturePayload(
        resolveFeatureReferences(parseFeatureJson(operation.featureJson), tree.features) as Record<string, unknown>
      );
      const response = await this.addFeature(context, feature, tree);
      return { message: `Created ${operation.featureName} (${operation.featureType}).`, response };
    }

    const original = tree.features.find((feature) => feature.featureId === operation.featureId);
    if (!original) throw new Error(`Feature ${operation.featureId} was not found.`);

    if (operation.type === "delete_feature") {
      if (original.name !== operation.currentName) throw new Error(`Feature ${operation.featureId} has changed since preview.`);
      const response = await this.deleteFeature(context, operation.featureId);
      return { message: `Deleted ${operation.currentName}.`, response };
    }

    if (operation.type === "replace_feature") {
      if (original.name !== operation.currentName || featureFingerprint(original) !== operation.currentFeatureHash) {
        throw new Error(`Feature ${operation.featureId} has changed since preview.`);
      }
      const replacement = {
        ...canonicalizeFeaturePayload(
          resolveFeatureReferences(parseFeatureJson(operation.featureJson), tree.features) as Record<string, unknown>
        ),
        featureId: operation.featureId
      } as OnshapeFeature;
      const response = await this.updateFeature(context, replacement, tree);
      return { message: `Updated ${operation.currentName} as ${operation.featureType}.`, response };
    }

    const feature = structuredClone(original);

    if (operation.type === "rename_feature") {
      if (feature.name !== operation.currentName) throw new Error(`Feature ${operation.featureId} has changed since preview.`);
      feature.name = operation.newName;
      const response = await this.updateFeature(context, feature, tree);
      return { message: `Renamed ${operation.currentName} to ${operation.newName}.`, response };
    }

    const parameter = feature.parameters?.find((candidate) => candidate.parameterId === operation.parameterId);
    if (!parameter) throw new Error(`Parameter ${operation.parameterId} was not found.`);
    if (parameter.expression !== operation.currentExpression) {
      throw new Error(`Parameter ${operation.parameterId} has changed since preview.`);
    }
    parameter.expression = operation.newExpression;
    const response = await this.updateFeature(context, feature, tree);
    return { message: `Changed ${operation.featureName}.${operation.parameterId} to ${operation.newExpression}.`, response };
  }

  async applyOperation(
    context: PartStudioContext,
    operation: CadOperation,
    featureTree?: FeatureListResponse
  ): Promise<string> {
    return (await this.applyOperationDetailed(context, operation, featureTree)).message;
  }

  async inspectRegenerationErrors(context: PartStudioContext): Promise<RegenerationError[]> {
    const tree = await this.listFeatures(context);
    return this.regenerationErrors(tree);
  }

  regenerationErrors(tree: FeatureListResponse): RegenerationError[] {
    const states = normalizeFeatureStates(tree.featureStates);
    return tree.features.flatMap((feature) => {
      const state = states.get(feature.featureId);
      const status = String(state?.featureStatus ?? feature.featureStatus ?? "OK");
      if (["OK", "INFO"].includes(status.toUpperCase())) return [];
      return [{
        featureId: feature.featureId,
        featureName: feature.name ?? feature.featureId,
        status,
        ...(typeof state?.message === "string" ? { message: state.message } : {})
      }];
    });
  }
}

export function normalizeFeatureStates(value: unknown): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  if (Array.isArray(value)) {
    for (const state of value) {
      if (state && typeof state === "object") {
        const record = state as Record<string, unknown>;
        const id = record.featureId ?? record.id;
        if (typeof id === "string") result.set(id, record);
      }
    }
  } else if (value && typeof value === "object") {
    for (const [id, state] of Object.entries(value)) {
      if (state && typeof state === "object") result.set(id, state as Record<string, unknown>);
    }
  }
  return result;
}
