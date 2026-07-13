import type { CadOperation, RegenerationError } from "@morassistant/cad-command-schema";
import type { PartStudioContext } from "@morassistant/shared-types";

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

export interface FeatureUpdateConcurrency {
  serializationVersion?: string;
  sourceMicroversion?: string;
}

export class OnshapeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
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
    this.apiVersion = options.apiVersion ?? "v15";
  }

  private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
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

    if (response.status === 401 && retry && this.options.refreshAccessToken) {
      await this.options.refreshAccessToken();
      return this.request<T>(path, init, false);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("json")
      ? await response.json().catch(() => null)
      : await response.text().catch(() => "");
    if (!response.ok) throw new OnshapeApiError(`Onshape API request failed (${response.status}).`, response.status, body);
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

  async applyOperation(context: PartStudioContext, operation: CadOperation): Promise<string> {
    const tree = await this.listFeatures(context);
    const original = tree.features.find((feature) => feature.featureId === operation.featureId);
    if (!original) throw new Error(`Feature ${operation.featureId} was not found.`);
    const feature = structuredClone(original);

    if (operation.type === "rename_feature") {
      if (feature.name !== operation.currentName) throw new Error(`Feature ${operation.featureId} has changed since preview.`);
      feature.name = operation.newName;
      await this.updateFeature(context, feature, tree);
      return `Renamed ${operation.currentName} to ${operation.newName}.`;
    }

    const parameter = feature.parameters?.find((candidate) => candidate.parameterId === operation.parameterId);
    if (!parameter) throw new Error(`Parameter ${operation.parameterId} was not found.`);
    if (parameter.expression !== operation.currentExpression) {
      throw new Error(`Parameter ${operation.parameterId} has changed since preview.`);
    }
    parameter.expression = operation.newExpression;
    await this.updateFeature(context, feature, tree);
    return `Changed ${operation.featureName}.${operation.parameterId} to ${operation.newExpression}.`;
  }

  async inspectRegenerationErrors(context: PartStudioContext): Promise<RegenerationError[]> {
    const tree = await this.listFeatures(context);
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

function normalizeFeatureStates(value: unknown): Map<string, Record<string, unknown>> {
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
