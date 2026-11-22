import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { StoredCadPlan } from "@morassistant/cad-command-schema";
import {
  DEFAULT_CODEX_EFFORT, DEFAULT_CODEX_MODEL,
  type CadTarget, type CodexEffort, type ConnectionStatus, type DeviceCodeLogin, type OnshapeElementContext, type OnshapeElementType
} from "@morassistant/shared-types";

const emptyStatus: ConnectionStatus = { onshape: "disconnected", codex: "disconnected" };
const apiOrigin = (import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/$/, "");
const installationStorageKey = "morassistant.installation-token";
const effortLabels: Record<CodexEffort, string> = {
  none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High",
  xhigh: "Extra high", max: "Max", ultra: "Ultra"
};

function modelLabel(model: string): string {
  return model.replace(/^gpt-/u, "GPT ").replace(/-(sol|astra|terra|luna)$/u, (_, name: string) =>
    ` ${name.charAt(0).toUpperCase()}${name.slice(1)}`);
}

function installationTokenFromLaunch(): string | null {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const launchedToken = hash.get("installationToken");
  if (launchedToken) {
    try {
      sessionStorage.setItem(installationStorageKey, launchedToken);
    } catch {
      // The in-memory value below still supports the current iframe when a
      // browser blocks embedded storage entirely.
    }
    hash.delete("installationToken");
    const remainingHash = hash.toString();
    history.replaceState(null, "", `${location.pathname}${location.search}${remainingHash ? `#${remainingHash}` : ""}`);
    return launchedToken;
  }
  try {
    return sessionStorage.getItem(installationStorageKey);
  } catch {
    return null;
  }
}

const installationToken = installationTokenFromLaunch();

type PlanningProgress = {
  id: string;
  kind: "inspection" | "reasoning" | "research" | "validation";
  message: string;
  at: number;
};

type PlanJobResponse =
  | { id: string; status: "planning"; progress?: PlanningProgress[] }
  | { id: string; status: "completed"; progress?: PlanningProgress[]; plan: StoredCadPlan }
  | { id: string; status: "failed"; progress?: PlanningProgress[]; error: string };

type ConversationResponse = {
  plans: StoredCadPlan[];
  hasPersistentContext: boolean;
};

type ElementContextResponse = {
  context: OnshapeElementContext;
  name: string;
  elementType: OnshapeElementType;
};

type BusyState = "planning" | "applying" | "recovering" | null;

function contextFromUrl(): OnshapeElementContext | null {
  const params = new URLSearchParams(location.search);
  const documentId = params.get("documentId") ?? params.get("did");
  const workspaceId = params.get("workspaceId") ?? params.get("wid");
  const elementId = params.get("elementId") ?? params.get("eid");
  const workspaceOrVersion = params.get("workspaceOrVersion");
  const elementType = params.get("elementType");
  const rawConfiguration = params.get("configuration")?.trim();
  const configuration = rawConfiguration
    && rawConfiguration.toLowerCase() !== "default"
    && rawConfiguration.toLowerCase() !== "{$configuration}"
    ? rawConfiguration
    : undefined;
  if (!documentId || !workspaceId || !elementId || (workspaceOrVersion && workspaceOrVersion !== "w")) return null;
  return {
    documentId,
    workspaceId,
    elementId,
    ...(workspaceOrVersion === "w" ? { workspaceOrVersion: "w" as const } : {}),
    ...(configuration ? { configuration } : {}),
    ...(params.get("server") ? { server: params.get("server")! } : {}),
    ...(elementType === "PARTSTUDIO" || elementType === "ASSEMBLY" ? { elementType } : {})
  };
}

function contextQuery(context: OnshapeElementContext): string {
  const params = new URLSearchParams({
    documentId: context.documentId,
    workspaceId: context.workspaceId,
    elementId: context.elementId,
    workspaceOrVersion: context.workspaceOrVersion ?? "w"
  });
  if (context.configuration) params.set("configuration", context.configuration);
  if (context.server) params.set("server", context.server);
  if (context.elementType) params.set("elementType", context.elementType);
  return params.toString();
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiOrigin}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(installationToken ? { "x-mor-installation": installationToken } : {}),
      ...init?.headers
    }
  });
  const body = await response.json().catch(() => ({ error: `Request failed (${response.status}).` })) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body;
}

async function waitForPlan(
  jobId: string,
  onProgress: (progress: PlanningProgress[]) => void
): Promise<StoredCadPlan> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    const job = await api<PlanJobResponse>(`/api/plan-jobs/${jobId}`);
    onProgress(job.progress ?? []);
    if (job.status === "completed") return job.plan;
    if (job.status === "failed") throw new Error(job.error);
  }
  throw new Error("Codex planning timed out. Try the request again.");
}

function BrandMark() {
  return <svg viewBox="0 0 40 40" aria-hidden="true">
    <path d="M8.5 27.5V12.9L20 6.2l11.5 6.7v14.6L20 34.1 8.5 27.5Z" fill="none" stroke="currentColor" strokeWidth="2.2" />
    <path d="m12.8 25 7.2 4.2 7.2-4.2M20 29.2V15.4m-7.2-4.1L20 15.4l7.2-4.1" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
  </svg>;
}

function ConnectionPill({ label, state }: { label: string; state: string }) {
  return <span className={`connection-pill ${state}`}><i aria-hidden="true" />{label}</span>;
}

function LiveActivity({ progress, label }: { progress: PlanningProgress[]; label: string }) {
  const visible = progress.length > 0 ? progress : [{
    id: "starting",
    kind: "inspection" as const,
    message: "Reading the current Onshape tab.",
    at: Date.now()
  }];
  return <section className="live-activity" aria-label={label} aria-live="polite">
    <div className="activity-heading"><span className="live-dot" /><strong>{label}</strong></div>
    <ol>{visible.map((item) => <li key={item.id} className={item.kind}>
      <span>{item.kind === "research" ? "⌕" : item.kind === "validation" ? "✓" : item.kind === "reasoning" ? "◇" : "↻"}</span>
      <p>{item.message}</p>
    </li>)}</ol>
  </section>;
}

type PlanOperation = StoredCadPlan["operations"][number];

function operationTitle(operation: PlanOperation): string {
  switch (operation.type) {
    case "rename_feature": return "Rename feature";
    case "update_dimension": return "Update dimension";
    case "create_rectangle_sketch": return "Create rectangle sketch";
    case "create_circle_sketch": return "Create circle sketch";
    case "extrude_sketch": return "Extrude sketch";
    case "fillet_feature_edges": return "Fillet feature edges";
    case "chamfer_feature_edges": return "Chamfer feature edges";
    case "create_feature": return "Create native feature";
    case "replace_feature": return "Replace native feature";
    case "delete_feature": return "Delete feature";
    case "insert_assembly_component": return "Insert library component";
    case "transform_assembly_instance": return "Place assembly instance";
    case "set_assembly_instance_suppressed": return operation.suppressed ? "Suppress assembly instance" : "Unsuppress assembly instance";
    case "delete_assembly_instance": return "Delete assembly instance";
  }
}

function OperationDetail({ operation }: { operation: PlanOperation }) {
  switch (operation.type) {
    case "rename_feature":
      return <p><code>{operation.currentName}</code><i>→</i><code>{operation.newName}</code></p>;
    case "update_dimension":
      return <p><code>{operation.featureName}.{operation.parameterId}</code><i>→</i><code>{operation.newExpression}</code></p>;
    case "create_rectangle_sketch":
      return <p><code>{operation.sketchName}</code><i>·</i><code>{operation.widthMm} × {operation.heightMm} mm · {operation.plane}</code></p>;
    case "create_circle_sketch":
      return <p><code>{operation.sketchName}</code><i>·</i><code>Ø{operation.radiusMm * 2} mm · {operation.plane}</code></p>;
    case "extrude_sketch":
      return <p><code>{operation.sourceFeatureName}</code><i>→</i><code>{operation.featureName} · {operation.depthMm} mm{operation.startOffsetMm > 0 ? ` · offset ${operation.startOffsetMm} mm` : ""} · {operation.operation}</code></p>;
    case "fillet_feature_edges":
      return <p><code>{operation.targetFeatureName}</code><i>→</i><code>{operation.featureName} · R{operation.radiusMm} mm</code></p>;
    case "chamfer_feature_edges":
      return <p><code>{operation.targetFeatureName}</code><i>→</i><code>{operation.featureName} · {operation.distanceMm} mm</code></p>;
    case "create_feature":
      return <p><code>{operation.featureName}</code><i>·</i><code>{operation.featureType}</code></p>;
    case "replace_feature":
      return <p><code>{operation.currentName}</code><i>→</i><code>{operation.featureType}</code></p>;
    case "delete_feature":
      return <p><code>{operation.currentName}</code><i>→</i><code>deleted</code></p>;
    case "insert_assembly_component":
      return <p><code>{operation.componentName}</code><i>·</i><code>FRC/library source · placed in assembly</code></p>;
    case "transform_assembly_instance":
      return <p><code>{operation.instanceName}</code><i>→</i><code>absolute assembly placement</code></p>;
    case "set_assembly_instance_suppressed":
      return <p><code>{operation.instanceName}</code><i>→</i><code>{operation.suppressed ? "suppressed" : "unsuppressed"}</code></p>;
    case "delete_assembly_instance":
      return <p><code>{operation.instanceName}</code><i>→</i><code>deleted</code></p>;
  }
}

function PlanCard({
  plan,
  busy,
  activePlanId,
  onApply
}: {
  plan: StoredCadPlan;
  busy: BusyState;
  activePlanId: string | null;
  onApply: (plan: StoredCadPlan) => void;
}) {
  const hasOperations = plan.operations.length > 0;
  return <section className={`plan ${plan.status}`}>
    {hasOperations && <div className="plan-heading">
      <h2>{plan.summary}</h2>
      <span className={`risk ${plan.risk}`}>{plan.risk} risk</span>
    </div>}
    {(!hasOperations || (plan.message && plan.message !== plan.summary)) &&
      <p className="assistant-copy">{plan.message ?? plan.summary}</p>}
    {hasOperations && <ol className="operations">
      {plan.operations.map((operation, index) => <li key={`${operation.type}-${index}`}>
        <span className="op-index">{String(index + 1).padStart(2, "0")}</span>
        <div>
          <strong>{operationTitle(operation)}</strong>
          <OperationDetail operation={operation} />
          <small>{operation.reason}</small>
        </div>
        {plan.result?.operations[index] && <span className={`op-status ${plan.result.operations[index].status}`}>{plan.result.operations[index].status === "applied" ? "✓" : "!"}</span>}
      </li>)}
    </ol>}
    {plan.warnings.length > 0 && <div className="warnings">{plan.warnings.map((warning) => <p key={warning}>△ {warning}</p>)}</div>}
    {(plan.sources?.length ?? 0) > 0 && <div className="research-sources"><strong>Research sources</strong>{plan.sources.map((source) =>
      <a key={source.url} href={source.url} target="_blank" rel="noreferrer"><span>↗</span><span>{source.title}</span></a>
    )}</div>}
    {plan.result?.regenerationErrors.length ? <div className="warnings error-list">{plan.result.regenerationErrors.map((item) => <p key={item.featureId}>! {item.featureName}: {item.message ?? item.status}</p>)}</div> : null}
    {plan.result?.preexistingRegenerationErrors?.length ? <div className="existing-errors"><p>{plan.result.preexistingRegenerationErrors.length} pre-existing model error(s) were recorded separately and did not fail this plan.</p></div> : null}
    {hasOperations && <div className="approval-bar">
      <div><strong>{plan.status === "pending" ? "Ready for review" : plan.status === "applying" ? "Applying changes" : plan.status === "applied" ? "Changes applied" : "Execution stopped"}</strong><small>{plan.status === "pending" ? `${plan.operations.length} proposed change${plan.operations.length === 1 ? "" : "s"}` : `${plan.result?.operations.filter((item) => item.status === "applied").length ?? 0} applied`}</small></div>
      {hasOperations && plan.status === "pending" && <button className="apply-button" onClick={() => onApply(plan)} disabled={busy !== null}>{busy === "applying" && activePlanId === plan.id ? "Applying…" : "Approve & apply"}</button>}
    </div>}
    {plan.agentTrace && <details className="turn-details">
      <summary>Inspection details</summary>
      <p>{plan.agentTrace.elementType === "ASSEMBLY"
        ? `${plan.agentTrace.instanceCount ?? 0} instances · ${plan.agentTrace.featureCount} assembly features`
        : `${plan.agentTrace.featureCount} features · ${plan.agentTrace.nativeFeatureTypeCount ?? 0} live feature types`}
        {` · ${plan.agentTrace.planningAttempts} validation pass${plan.agentTrace.planningAttempts === 1 ? "" : "es"}`}</p>
      {plan.agentTrace.inspectionWarnings?.map((warning) => <p key={warning}>{warning}</p>)}
    </details>}
  </section>;
}

function ConversationTurn({
  plan,
  latest,
  busy,
  activePlanId,
  onApply
}: {
  plan: StoredCadPlan;
  latest: boolean;
  busy: BusyState;
  activePlanId: string | null;
  onApply: (plan: StoredCadPlan) => void;
}) {
  const prompt = plan.recoveryForPlanId ? "Recover from the stopped execution." : plan.prompt;
  return <article className="chat-turn">
    <div className="user-message"><span>You</span><p>{prompt}</p></div>
    <div className="assistant-message">
      <div className="assistant-label"><BrandMark /><strong>MorAssistant</strong>
        {plan.agentTrace?.runtime && <small>{modelLabel(plan.agentTrace.runtime.model)}{plan.agentTrace.runtime.reasoningEffort ? ` · ${effortLabels[plan.agentTrace.runtime.reasoningEffort as CodexEffort] ?? plan.agentTrace.runtime.reasoningEffort}` : ""}</small>}
      </div>
      {latest ? <PlanCard plan={plan} busy={busy} activePlanId={activePlanId} onApply={onApply} /> :
        <details className="past-turn">
          <summary><span>{plan.message ?? plan.summary}</span><small>{plan.operations.length === 0 ? "Answer" : `${plan.operations.length} operation${plan.operations.length === 1 ? "" : "s"}`} · {plan.status}</small></summary>
          <PlanCard plan={plan} busy={busy} activePlanId={activePlanId} onApply={onApply} />
        </details>}
    </div>
  </article>;
}

export function App() {
  const launchContext = useMemo(contextFromUrl, []);
  const [context, setContext] = useState<OnshapeElementContext | null>(launchContext);
  const [contextName, setContextName] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [model, setModel] = useState(DEFAULT_CODEX_MODEL);
  const [effort, setEffort] = useState<CodexEffort>(DEFAULT_CODEX_EFFORT);
  const [deviceLogin, setDeviceLogin] = useState<DeviceCodeLogin | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [targets, setTargets] = useState<CadTarget[]>([]);
  const [choices, setChoices] = useState<CadTarget[] | null>(null);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<StoredCadPlan[]>([]);
  const [hasPersistentContext, setHasPersistentContext] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [activity, setActivity] = useState<PlanningProgress[]>([]);
  const [busy, setBusy] = useState<BusyState>(null);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const conversationEnd = useRef<HTMLDivElement | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api<ConnectionStatus>("/api/status");
      setStatus(next);
      setStatusError(null);
      setDeviceLogin(next.deviceLogin ?? null);
    } catch (cause) {
      setStatusError(cause instanceof Error ? cause.message : "Could not reach the service.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refreshStatus();
      if (active) timer = setTimeout(() => void poll(), status?.codex === "pending" ? 3_000 : 20_000);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [refreshStatus, status?.codex]);

  useEffect(() => {
    if (!context || status?.onshape !== "connected" || contextName) return;
    let active = true;
    void api<ElementContextResponse>(`/api/context?${contextQuery(context)}`).then((response) => {
      if (!active) return;
      setContext(response.context);
      setContextName(response.name);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not identify the current Onshape tab.");
    });
    return () => { active = false; };
  }, [context, contextName, status?.onshape]);

  useEffect(() => {
    if (!context || !contextName) return;
    let active = true;
    void api<ConversationResponse>(`/api/conversation?${contextQuery(context)}`).then((conversation) => {
      if (!active) return;
      setHistory(conversation.plans);
      setHasPersistentContext(conversation.hasPersistentContext);
      setHistoryLoaded(true);
    }).catch((cause) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : "Could not load the conversation.");
      setHistoryLoaded(true);
    });
    return () => { active = false; };
  }, [context, contextName]);

  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ block: "nearest" });
  }, [history.length, pendingPrompt, activity]);

  const upsertPlan = (nextPlan: StoredCadPlan) => {
    setHistory((current) => {
      const withoutPlan = current.filter((item) => item.id !== nextPlan.id);
      return [...withoutPlan, nextPlan].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    });
  };

  const connectCodex = async () => {
    setError(null);
    setConnecting(true);
    try {
      const login = await api<DeviceCodeLogin>("/api/codex/connect", { method: "POST" });
      setDeviceLogin(login);
      setStatus((current) => ({ ...(current ?? emptyStatus), codex: "pending" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start ChatGPT sign-in.");
    } finally {
      setConnecting(false);
    }
  };

  const loadTargets = async () => {
    if (!context || loadingTargets) return;
    setLoadingTargets(true);
    setError(null);
    try {
      const response = await api<{ targets: CadTarget[] }>(`/api/context/targets?${contextQuery(context)}`);
      setChoices(response.targets);
      setFilter("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load CAD targets.");
    } finally {
      setLoadingTargets(false);
    }
  };

  const createPlan = async (event: FormEvent) => {
    event.preventDefault();
    if (!context || !ready || busy || prompt.trim().length < 3) return;
    const submittedPrompt = prompt.trim();
    setBusy("planning"); setError(null); setRecoveryMessage(null); setActivity([]); setPendingPrompt(submittedPrompt); setPrompt("");
    try {
      const job = await api<PlanJobResponse>("/api/plan-jobs", {
        method: "POST",
        body: JSON.stringify({ prompt: submittedPrompt, context, model, effort, targetIds: targets.map((target) => target.id) })
      });
      setActivity(job.progress ?? []);
      const completedPlan = job.status === "completed" ? job.plan : await waitForPlan(job.id, setActivity);
      upsertPlan(completedPlan);
      setHasPersistentContext(true);
      setTargets([]);
      setChoices(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create a plan.");
      setPrompt((current) => current || submittedPrompt);
    } finally {
      setPendingPrompt(null);
      setBusy(null);
    }
  };

  const applyPlan = async (plan: StoredCadPlan) => {
    setBusy("applying"); setActivePlanId(plan.id); setError(null);
    try {
      const applied = await api<StoredCadPlan>(`/api/plans/${plan.id}/apply`, { method: "POST" });
      upsertPlan(applied);
      if (applied.status === "failed" && !applied.recoveryForPlanId) {
        setBusy("recovering");
        setPendingPrompt("Recover from the stopped execution.");
        setActivity([]);
        const job = await api<PlanJobResponse>(`/api/plans/${applied.id}/recovery-jobs`, { method: "POST" });
        setActivity(job.progress ?? []);
        const recovery = job.status === "completed" ? job.plan : await waitForPlan(job.id, setActivity);
        upsertPlan(recovery);
        const appliedCount = applied.result?.operations.filter((item) => item.status === "applied").length ?? 0;
        const stoppedAt = applied.result?.operations.find((item) => item.status === "failed" || item.verification !== "passed");
        setRecoveryMessage([
          `Execution stopped after ${appliedCount} operation${appliedCount === 1 ? "" : "s"} applied.`,
          stoppedAt ? `Stopped at operation ${stoppedAt.index + 1}: ${stoppedAt.message}` : undefined,
          "A recovery plan is ready for review."
        ].filter(Boolean).join(" "));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not apply the plan.");
    } finally {
      setPendingPrompt(null);
      setActivePlanId(null);
      setBusy(null);
    }
  };

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const isAssembly = context?.elementType === "ASSEMBLY";
  const elementLabel = isAssembly ? "Assembly" : "Part Studio";
  const modelOptions = status?.codexModels ?? [];
  const activeModel = modelOptions.find((option) => option.model === model);
  const effortOptions = activeModel?.efforts ?? [effort];
  const connected = status?.onshape === "connected" && status?.codex === "connected";
  const modelAvailable = activeModel?.efforts.includes(effort) ?? false;
  const ready = connected && modelAvailable && Boolean(contextName) && historyLoaded;
  const examples = isAssembly
    ? ["What’s in this assembly?", "Find a 2-inch compliant wheel", "Check which components are mated"]
    : ["Make a 40 mm × 20 mm mounting plate", "Inspect the feature tree", "Build a cylinder Ø25 mm × 40 mm"];
  const visibleTargets = choices?.filter((target) => `${target.name} ${target.type}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 30);

  return <main className="panel">
    <header className="topbar">
      <div className="brand"><BrandMark /><strong>MorAssistant</strong></div>
      <div className="connections" aria-label="Connection status">
        <ConnectionPill label="Onshape" state={status?.onshape ?? "loading"} />
        <ConnectionPill label="ChatGPT" state={status?.codex ?? "loading"} />
      </div>
    </header>
    <div className="document-bar">
      <span className="eyebrow">{context ? (contextName ? elementLabel : "Onshape workspace") : "Onshape extension"}</span>
      {contextName && <strong title={contextName}>{contextName}</strong>}
      {hasPersistentContext && <span className="context-status" title="Conversation is saved for this tab">Saved chat</span>}
    </div>

    <section className="chat-shell" aria-label={`${elementLabel} conversation`}>
    {!context && <section className="notice warning">
      <strong>Open this panel from a Part Studio or Assembly</strong>
      <p>In an editable Onshape workspace, open MorAssistant from the right sidebar.</p>
    </section>}

    {status && status.onshape !== "connected" && <section className="notice error">
      <strong>Onshape access has not been granted</strong>
      <p>This installed extension needs Onshape access in My account → Applications. After granting it, reopen the panel.</p>
    </section>}

    {status?.onshape === "connected" && status.codex !== "connected" && !deviceLogin && <section className="setup-card">
      <h1>Connect ChatGPT</h1>
      <p>Sign in to use the models available to your ChatGPT account.</p>
      <div className="setup-actions">
        <button type="button" className="connect-button" onClick={() => void connectCodex()} disabled={connecting || status.codex === "pending"}>
          {connecting ? "Starting sign-in…" : status.codex === "pending" ? "Waiting for sign-in…" : "Continue with ChatGPT"} <span aria-hidden="true">↗</span>
        </button>
      </div>
    </section>}

    {deviceLogin && <section className="device-card">
      <h2>Finish ChatGPT sign-in</h2>
      <p>Open the secure verification page, then enter this one-time code.</p>
      <div className="device-code">{deviceLogin.userCode}</div>
      <a href={deviceLogin.verificationUrl} target="_blank" rel="noreferrer">Open verification page ↗</a>
    </section>}

    {!status && !statusError && <p className="loading-copy" role="status">Connecting to MorAssistant…</p>}
    {statusError && <section className="notice error" role="alert"><strong>Connection problem</strong><p>{statusError}</p>
      <button className="secondary-button" type="button" onClick={() => void refreshStatus()}>Retry connection</button>
    </section>}
    {error && <section className="notice error" role="alert"><p>{error}</p><button className="secondary-button" type="button" onClick={() => setError(null)}>Dismiss</button></section>}
    {recoveryMessage && <section className="notice recovery"><strong>Recovery plan ready</strong><p>{recoveryMessage}</p></section>}
      {context && connected && !historyLoaded && !error && <p className="loading-copy" role="status">Loading this tab’s conversation…</p>}
      {connected && historyLoaded && history.length === 0 && !pendingPrompt && <div className="chat-empty">
        <div className="empty-mark"><BrandMark /></div>
        <h1>{isAssembly ? "Work on this assembly" : "Work on this Part Studio"}</h1>
        <p>{isAssembly ? "Inspect constraints, find hardware, or preview a placement." : "Build a feature, inspect geometry, or refine an existing part."}</p>
        <div className="examples">{examples.map((example) => <button type="button" key={example} disabled={!ready}
          onClick={() => { setPrompt(example); document.getElementById("cad-prompt")?.focus(); }}>
          {example}<span aria-hidden="true">↗</span>
        </button>)}</div>
      </div>}
      {history.map((item, index) => <ConversationTurn
        key={item.id}
        plan={item}
        latest={index === history.length - 1}
        busy={busy}
        activePlanId={activePlanId}
        onApply={(candidate) => void applyPlan(candidate)}
      />)}
      {pendingPrompt && <article className="chat-turn pending-turn">
        <div className="user-message"><span>You</span><p>{pendingPrompt}</p></div>
        <div className="assistant-message">
          <div className="assistant-label"><BrandMark /><strong>MorAssistant</strong></div>
          <LiveActivity progress={activity} label={busy === "recovering" ? "Preparing a recovery plan" : "Working on your request"} />
        </div>
      </article>}
      <div ref={conversationEnd} />
    </section>

    <section className="composer" aria-label="Message composer">
      <form onSubmit={(event) => void createPlan(event)}>
        <div className="model-controls">
          <label>Model
            <select aria-label="Model" value={model} onChange={(event) => {
              const next = modelOptions.find((option) => option.model === event.target.value);
              if (!next) return;
              setModel(next.model);
              setEffort(next.efforts.includes(DEFAULT_CODEX_EFFORT) ? DEFAULT_CODEX_EFFORT : next.defaultEffort);
            }} disabled={!modelOptions.length || busy !== null}>
              {!activeModel && <option value={model}>{modelLabel(model)}{modelOptions.length ? " (unavailable)" : ""}</option>}
              {modelOptions.map((option) => <option key={option.model} value={option.model}>{option.label}</option>)}
            </select>
          </label>
          <label>Reasoning
            <select aria-label="Reasoning" value={effort} onChange={(event) => setEffort(event.target.value as CodexEffort)} disabled={!activeModel || busy !== null}>
              {!effortOptions.includes(effort) && <option value={effort}>{effortLabels[effort]} (unavailable)</option>}
              {effortOptions.map((option) => <option key={option} value={option}>{effortLabels[option]}</option>)}
            </select>
          </label>
        </div>
        {connected && !modelAvailable && <p className="model-help">{modelOptions.length
          ? "Choose a model and reasoning effort available to your account."
          : "The model list is unavailable. Retry the connection to reload it."}</p>}
        {targets.length > 0 && <div className="target-chips" aria-label="Attached CAD targets">{targets.map((target) =>
          <button type="button" key={target.id} disabled={busy !== null} onClick={() => setTargets((current) => current.filter((item) => item.id !== target.id))}
            aria-label={`Remove ${target.name}`}>{target.name} <span aria-hidden="true">×</span></button>
        )}</div>}
        {choices && <div className="target-picker">
          <div className="target-picker-top"><label htmlFor="target-filter">Choose {isAssembly ? "instances" : "features"}</label>
            <button type="button" className="secondary-button" onClick={() => setChoices(null)}>Done</button>
          </div>
          <input id="target-filter" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter by name or type" />
          <ul>{visibleTargets?.map((target) => {
            const selected = targets.some((item) => item.id === target.id);
            return <li key={target.id}><button type="button" aria-pressed={selected} disabled={busy !== null || (!selected && targets.length >= 12)}
              onClick={() => setTargets((current) => selected ? current.filter((item) => item.id !== target.id) : [...current, target])}>
              <span>{target.name}</span><small>{target.type}</small>
            </button></li>;
          })}</ul>
          {!visibleTargets?.length && <p>No matching targets.</p>}
        </div>}
        <textarea
          id="cad-prompt"
          aria-label="Message MorAssistant"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={handlePromptKeyDown}
          placeholder={history.length ? "Continue this conversation…" : "Describe what you want to inspect or change…"}
          maxLength={4_000}
          rows={2}
          disabled={!ready || busy !== null}
        />
        <div className="prompt-footer">
          <button className="secondary-button" type="button" disabled={!connected || !contextName || busy !== null || loadingTargets}
            onClick={() => choices ? setChoices(null) : void loadTargets()}>
            {loadingTargets ? "Loading targets…" : choices ? "Close targets" : "+ CAD target"}
          </button>
          <button className="send-button" type="submit" title="Send (⌘/Ctrl + Enter)" disabled={!ready || prompt.trim().length < 3 || busy !== null}>
            {busy === "planning" ? "Working…" : "Send"}<span aria-hidden="true">↑</span>
          </button>
        </div>
      </form>
    </section>

  </main>;
}
