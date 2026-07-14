export interface PartStudioContext {
  documentId: string;
  workspaceId: string;
  elementId: string;
  workspaceOrVersion?: "w";
  configuration?: string;
  server?: string;
}

export interface ConnectionStatus {
  onshape: "connected" | "disconnected";
  codex: "connected" | "pending" | "disconnected";
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
