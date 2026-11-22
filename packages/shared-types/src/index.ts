export type OnshapeElementType = "PARTSTUDIO" | "ASSEMBLY";

export interface OnshapeElementContext {
  documentId: string;
  workspaceId: string;
  elementId: string;
  workspaceOrVersion?: "w";
  configuration?: string;
  server?: string;
  elementType?: OnshapeElementType;
}

export type PartStudioContext = OnshapeElementContext;
export type AssemblyContext = OnshapeElementContext;

export const DEFAULT_CODEX_MODEL = "gpt-6.2-sol";
export const DEFAULT_CODEX_EFFORT = "high";
export const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type CodexEffort = typeof CODEX_EFFORTS[number];

export interface CodexModelOption {
  model: string;
  label: string;
  defaultEffort: CodexEffort;
  efforts: CodexEffort[];
}

export interface PlanningPreferences {
  model?: string;
  effort?: CodexEffort;
}

export interface PlanningProgress {
  id: string;
  kind: "inspection" | "reasoning" | "research" | "validation";
  message: string;
  at: number;
  usage?: PlanningUsage;
  activityOnly?: boolean;
}

export interface PlanningUsage {
  totalTokens: number;
  cachedInputTokens: number;
  limitTokens: number;
}

export type PlanningJobStatus = "planning" | "stopping" | "completed" | "failed" | "cancelled" | "timed_out" | "token_limit";

export interface CadTarget {
  id: string;
  name: string;
  type: string;
}

export interface ConnectionStatus {
  onshape: "connected" | "disconnected";
  codex: "connected" | "pending" | "disconnected";
  codexModels?: CodexModelOption[];
  deviceLogin?: DeviceCodeLogin;
  codexRuntime?: {
    configuredModel?: string;
    model: string;
    modelProvider?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    available: boolean;
  };
}

export interface DeviceCodeLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface ApiErrorBody {
  error: string;
  details?: unknown;
}
