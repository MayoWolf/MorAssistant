import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { StoredCadPlan } from "@morassistant/cad-command-schema";
import type { ConnectionStatus, DeviceCodeLogin, OnshapeElementContext, OnshapeElementType } from "@morassistant/shared-types";

const emptyStatus: ConnectionStatus = { onshape: "disconnected", codex: "disconnected" };
const apiOrigin = (import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/$/, "");
const installationStorageKey = "morassistant.installation-token";

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
  return <span className={`connection-pill ${state}`}><i />{label}</span>;
}

function LiveActivity({ progress, label }: { progress: PlanningProgress[]; label: string }) {
  const visible = progress.length > 0 ? progress : [{
    id: "starting",
    kind: "inspection" as const,
    message: "Starting Sol and loading the current Onshape tab context.",
    at: Date.now()
  }];
  return <section className="live-activity" aria-label={label} aria-live="polite">
    <div className="activity-heading"><span className="live-dot" /><div><strong>Sol is working live</strong><small>{label}</small></div></div>
    <ol>{visible.map((item) => <li key={item.id} className={item.kind}>
      <span>{item.kind === "research" ? "⌕" : item.kind === "validation" ? "✓" : item.kind === "reasoning" ? "◇" : "↻"}</span>
      <p>{item.message}</p>
    </li>)}</ol>
    <p className="activity-note">Live reasoning summaries and research activity—not private chain-of-thought.</p>
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
    <div className="plan-heading">
      <div><span className="eyebrow">{hasOperations ? "Proposed plan" : "Answer"}</span><h2>{plan.summary}</h2></div>
      <span className={`risk ${plan.risk}`}>{hasOperations ? `${plan.risk} risk` : "no change"}</span>
    </div>
    <p className="assistant-copy">{plan.message ?? plan.summary}</p>
    {plan.agentTrace && <div className="agent-trace" aria-label="Model inspection summary">
      <span><strong>{plan.agentTrace.elementType === "ASSEMBLY" ? plan.agentTrace.instanceCount ?? "—" : plan.agentTrace.featureCount}</strong><small>{plan.agentTrace.elementType === "ASSEMBLY" ? "instances read" : "features read"}</small></span>
      <span><strong>{plan.agentTrace.capabilityCount ?? "—"}</strong><small>CAD tools learned</small></span>
      <span><strong>{plan.agentTrace.elementType === "ASSEMBLY" ? plan.agentTrace.featureCount : plan.agentTrace.nativeFeatureTypeCount ?? "—"}</strong><small>{plan.agentTrace.elementType === "ASSEMBLY" ? "mates / features" : "live feature types"}</small></span>
      <span><strong>{plan.agentTrace.dependencyCount}</strong><small>{plan.agentTrace.elementType === "ASSEMBLY" ? "mate links" : "dependency links"}</small></span>
      <span><strong>{plan.agentTrace.elementType === "ASSEMBLY" ? plan.operations.filter((operation) => operation.type === "insert_assembly_component").length : plan.agentTrace.geometry.solidBodyCount ?? plan.agentTrace.geometry.partCount ?? "—"}</strong><small>{plan.agentTrace.elementType === "ASSEMBLY" ? "library inserts" : "solid bodies"}</small></span>
      <span><strong>{plan.agentTrace.planningAttempts}</strong><small>validation pass{plan.agentTrace.planningAttempts === 1 ? "" : "es"}</small></span>
    </div>}
    {plan.agentTrace?.runtime && <p className="runtime-proof">
      {plan.agentTrace.continuedConversation ? "Continued conversation" : "Started conversation"} · <strong>{plan.agentTrace.runtime.model}</strong>
      {plan.agentTrace.runtime.reasoningEffort ? ` · ${plan.agentTrace.runtime.reasoningEffort} reasoning` : ""}
    </p>}
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
    <div className="approval-bar">
      <div><strong>{!hasOperations ? "Answered" : plan.status === "pending" ? "Ready for review" : plan.status === "applied" ? "Changes applied" : "Execution stopped"}</strong><small>{!hasOperations ? "No CAD change was proposed." : plan.status === "pending" ? "Onshape can undo applied edits." : `${plan.result?.operations.filter((item) => item.status === "applied").length ?? 0} operation(s) applied.`}</small></div>
      {hasOperations && plan.status === "pending" && <button className="apply-button" onClick={() => onApply(plan)} disabled={busy !== null}>{busy === "applying" && activePlanId === plan.id ? "Applying…" : "Approve & apply"}</button>}
    </div>
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
      <div className="assistant-label"><BrandMark /><span>Sol</span></div>
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
  const [deviceLogin, setDeviceLogin] = useState<DeviceCodeLogin | null>(null);
  const [prompt, setPrompt] = useState("");
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
      if (next.codex !== "pending") setDeviceLogin(null);
    } catch (cause) {
      setStatusError(cause instanceof Error ? cause.message : "Could not reach the service.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refreshStatus();
      if (active) timer = setTimeout(() => void poll(), 3_000);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [refreshStatus]);

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
    if (!context) return;
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
  }, [context]);

  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [history.length, pendingPrompt, activity]);

  const upsertPlan = (nextPlan: StoredCadPlan) => {
    setHistory((current) => {
      const withoutPlan = current.filter((item) => item.id !== nextPlan.id);
      return [...withoutPlan, nextPlan].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    });
  };

  const connectCodex = async () => {
    setError(null);
    try {
      const login = await api<DeviceCodeLogin>("/api/codex/connect", { method: "POST" });
      setDeviceLogin(login);
      setStatus((current) => ({ ...(current ?? emptyStatus), codex: "pending" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start ChatGPT sign-in.");
    }
  };

  const createPlan = async (event: FormEvent) => {
    event.preventDefault();
    if (!context || !prompt.trim()) return;
    const submittedPrompt = prompt.trim();
    setBusy("planning"); setError(null); setRecoveryMessage(null); setActivity([]); setPendingPrompt(submittedPrompt); setPrompt("");
    try {
      const job = await api<PlanJobResponse>("/api/plan-jobs", {
        method: "POST",
        body: JSON.stringify({ prompt: submittedPrompt, context })
      });
      setActivity(job.progress ?? []);
      const completedPlan = job.status === "completed" ? job.plan : await waitForPlan(job.id, setActivity);
      upsertPlan(completedPlan);
      setHasPersistentContext(true);
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
          "Codex re-read the updated model and prepared this recovery plan; nothing else will run until you approve it."
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

  const updatePrompt = (value: string) => setPrompt(value);

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const ready = status?.onshape === "connected" && status.codex === "connected" && Boolean(context);
  const isAssembly = context?.elementType === "ASSEMBLY";
  const elementLabel = isAssembly ? "Assembly" : "Part Studio";
  const runtimeLabel = status?.codexRuntime
    ? `${status.codexRuntime.model.replace(/^gpt-/u, "GPT ").replace(/-sol$/u, " Sol")}${status.codexRuntime.reasoningEffort ? ` · ${status.codexRuntime.reasoningEffort}` : ""}`
    : "Codex";

  return <main>
    <header>
      <div className="brand"><BrandMark /><div><strong>MorAssistant</strong><span>Onshape copilot</span></div></div>
      <div className="connections">
        <ConnectionPill label={runtimeLabel} state={status?.codexRuntime && !status.codexRuntime.available ? "disconnected" : status?.codex ?? "loading"} />
      </div>
    </header>

    {!context && <section className="notice warning">
      <strong>Open this panel from a Part Studio or Assembly</strong>
      <p>The extension URL must include documentId, workspaceId, and elementId.</p>
    </section>}

    {status && status.onshape !== "connected" && <section className="notice error">
      <strong>Onshape access has not been granted</strong>
      <p>This installed extension needs Onshape access in My account → Applications. After granting it, reopen the panel.</p>
    </section>}

    {status && status.codex !== "connected" && <section className="setup-card">
      <span className="eyebrow">One-time setup</span>
      <h1>Connect Codex</h1>
      <p>Use your ChatGPT sign-in to power this Onshape copilot. No OpenAI API key is required.</p>
      <div className="setup-actions">
        <button type="button" className="connect-button" onClick={() => void connectCodex()} disabled={status.codex === "pending"}>
          <span className="step-num">◇</span><span><strong>{status.codex === "pending" ? "Waiting for sign-in" : "Continue with ChatGPT"}</strong><small>Authorize Codex for this Onshape extension</small></span><b>→</b>
        </button>
      </div>
    </section>}

    {deviceLogin && <section className="device-card">
      <span className="eyebrow">ChatGPT sign-in</span>
      <p>Open the secure verification page, then enter this one-time code.</p>
      <div className="device-code">{deviceLogin.userCode}</div>
      <a href={deviceLogin.verificationUrl} target="_blank" rel="noreferrer">Open verification page ↗</a>
    </section>}

    {(error || statusError) && <section className="notice error" role="alert"><strong>Something needs attention</strong><p>{error ?? statusError}</p></section>}
    {recoveryMessage && <section className="notice recovery"><strong>Recovery plan ready</strong><p>{recoveryMessage}</p></section>}
    <section className="chat-shell" aria-label={`${elementLabel} conversation`}>
      <div className="chat-meta">
        <div><span className="eyebrow">{elementLabel} chat{contextName ? ` · ${contextName}` : ""}</span><strong>{history.length} turn{history.length === 1 ? "" : "s"}</strong></div>
        <span className={hasPersistentContext ? "memory-on" : "memory-new"}><i />{hasPersistentContext ? "Context active" : "New context"}</span>
      </div>
      {!historyLoaded && <div className="chat-empty"><BrandMark /><strong>Loading conversation…</strong></div>}
      {historyLoaded && history.length === 0 && !pendingPrompt && <div className="chat-empty">
        <BrandMark />
        <strong>Build with Sol, one conversation at a time.</strong>
        <p>{isAssembly
          ? "Ask about the mechanism, import an FRCDesignLib component, place wheels on shafts, move instances, or suppress hardware. Sol keeps the thread and re-reads the live assembly every turn."
          : "Ask for a part, then keep refining it: “make it wider,” “add four mounting holes,” or “now fillet those edges.” Sol keeps the thread and re-reads the live model every turn."}</p>
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
          <div className="assistant-label"><BrandMark /><span>Sol</span></div>
          <LiveActivity progress={activity} label={busy === "recovering" ? "Preparing a recovery plan" : "Continuing the conversation"} />
        </div>
      </article>}
      <div ref={conversationEnd} />
    </section>

    <section className="workspace composer">
      <div className="section-title"><span className="eyebrow">Message Sol</span><span className="safe-label">Same {elementLabel} context</span></div>
      <form onSubmit={(event) => void createPlan(event)}>
        <textarea
          value={prompt}
          onChange={(event) => updatePrompt(event.target.value)}
          onKeyDown={handlePromptKeyDown}
          placeholder={history.length
            ? isAssembly ? "Keep going… import a wheel, place it on that shaft, move it, or ask why." : "Keep going… make it larger, move it, add holes, or ask why."
            : isAssembly ? "Describe what you want to inspect, import, or place in this assembly…" : "Describe what you want to build or change…"}
          rows={4}
          disabled={!ready || busy !== null}
        />
        <div className="prompt-footer">
          <span>{hasPersistentContext ? "Using conversation memory" : context ? `Current ${elementLabel}` : "No Onshape context"}</span>
          <button type="submit" disabled={!ready || prompt.trim().length < 3 || busy !== null}>
            {busy === "planning" ? "Thinking…" : "Send"}<span>⌘/Ctrl ↵</span>
          </button>
        </div>
      </form>
    </section>

    <footer><span className="shield">◇</span> No CAD change runs without approval</footer>
  </main>;
}
