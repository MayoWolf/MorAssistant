import { useCallback, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import type { StoredCadPlan } from "@morassistant/cad-command-schema";
import type { ConnectionStatus, DeviceCodeLogin, PartStudioContext } from "@morassistant/shared-types";

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

type PlanJobResponse =
  | { id: string; status: "planning" }
  | { id: string; status: "completed"; plan: StoredCadPlan }
  | { id: string; status: "failed"; error: string };

function contextFromUrl(): PartStudioContext | null {
  const params = new URLSearchParams(location.search);
  const documentId = params.get("documentId") ?? params.get("did");
  const workspaceId = params.get("workspaceId") ?? params.get("wid");
  const elementId = params.get("elementId") ?? params.get("eid");
  const workspaceOrVersion = params.get("workspaceOrVersion");
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
    ...(params.get("server") ? { server: params.get("server")! } : {})
  };
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

async function waitForPlan(jobId: string): Promise<StoredCadPlan> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    const job = await api<PlanJobResponse>(`/api/plan-jobs/${jobId}`);
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

function SkeletonPlan({ label = "Creating plan" }: { label?: string }) {
  return <div className="plan skeleton" aria-label={label}>
    <div className="sk-line wide" /><div className="sk-line" />
    <div className="sk-op"><span /><div><i /><i /></div></div>
    <div className="sk-op"><span /><div><i /><i /></div></div>
  </div>;
}

type PlanOperation = StoredCadPlan["operations"][number];

function operationTitle(operation: PlanOperation): string {
  switch (operation.type) {
    case "rename_feature": return "Rename feature";
    case "update_dimension": return "Update dimension";
    case "create_rectangle_sketch": return "Create rectangle sketch";
    case "create_feature": return "Create native feature";
    case "replace_feature": return "Replace native feature";
    case "delete_feature": return "Delete feature";
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
    case "create_feature":
      return <p><code>{operation.featureName}</code><i>·</i><code>{operation.featureType}</code></p>;
    case "replace_feature":
      return <p><code>{operation.currentName}</code><i>→</i><code>{operation.featureType}</code></p>;
    case "delete_feature":
      return <p><code>{operation.currentName}</code><i>→</i><code>deleted</code></p>;
  }
}

export function App() {
  const context = useMemo(contextFromUrl, []);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [deviceLogin, setDeviceLogin] = useState<DeviceCodeLogin | null>(null);
  const [prompt, setPrompt] = useState("");
  const [plan, setPlan] = useState<StoredCadPlan | null>(null);
  const [busy, setBusy] = useState<"planning" | "applying" | "recovering" | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

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
    setBusy("planning"); setError(null); setPlan(null); setRecoveryMessage(null);
    try {
      const job = await api<PlanJobResponse>("/api/plan-jobs", {
        method: "POST",
        body: JSON.stringify({ prompt, context })
      });
      setPlan(job.status === "completed" ? job.plan : await waitForPlan(job.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create a plan.");
    } finally {
      setBusy(null);
    }
  };

  const applyPlan = async () => {
    if (!plan) return;
    setBusy("applying"); setError(null);
    try {
      const applied = await api<StoredCadPlan>(`/api/plans/${plan.id}/apply`, { method: "POST" });
      setPlan(applied);
      if (applied.status === "failed" && !applied.recoveryForPlanId) {
        setBusy("recovering");
        const job = await api<PlanJobResponse>(`/api/plans/${applied.id}/recovery-jobs`, { method: "POST" });
        const recovery = job.status === "completed" ? job.plan : await waitForPlan(job.id);
        setPlan(recovery);
        setRecoveryMessage("Execution stopped at the first new Onshape error. Codex re-read the updated model and prepared this recovery plan; nothing else will run until you approve it.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not apply the plan.");
    } finally {
      setBusy(null);
    }
  };

  const updatePrompt = (value: string) => {
    setPrompt(value);
    if (plan?.status === "pending") {
      setPlan(null);
      setRecoveryMessage(null);
    }
  };

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const ready = status?.onshape === "connected" && status.codex === "connected" && Boolean(context);

  return <main>
    <header>
      <div className="brand"><BrandMark /><div><strong>MorAssistant</strong><span>Onshape copilot</span></div></div>
      <div className="connections">
        <ConnectionPill label="Codex" state={status?.codex ?? "loading"} />
      </div>
    </header>

    {!context && <section className="notice warning">
      <strong>Open this panel from a Part Studio</strong>
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

    <section className="workspace">
      <div className="section-title"><span className="eyebrow">Describe the change</span><span className="safe-label">Preview first</span></div>
      <form onSubmit={(event) => void createPlan(event)}>
        <textarea
          value={prompt}
          onChange={(event) => updatePrompt(event.target.value)}
          onKeyDown={handlePromptKeyDown}
          placeholder="Create, edit, combine, pattern, or remove Part Studio geometry…"
          rows={5}
          disabled={!ready || busy !== null}
        />
        <div className="prompt-footer">
          <span>{context ? "Current Part Studio" : "No Part Studio context"}</span>
          <button type="submit" disabled={!ready || prompt.trim().length < 3 || busy !== null}>
            {busy === "planning" ? "Planning…" : "Create plan"}<span>⌘/Ctrl ↵</span>
          </button>
        </div>
      </form>
    </section>

    {(error || statusError) && <section className="notice error" role="alert"><strong>Something needs attention</strong><p>{error ?? statusError}</p></section>}
    {recoveryMessage && <section className="notice recovery"><strong>Recovery plan ready</strong><p>{recoveryMessage}</p></section>}
    {(busy === "planning" || busy === "recovering") && <SkeletonPlan label={busy === "recovering" ? "Preparing a recovery plan" : "Creating plan"} />}

    {plan && <section className={`plan ${plan.status}`}>
      <div className="plan-heading">
        <div><span className="eyebrow">Proposed plan</span><h2>{plan.summary}</h2></div>
        <span className={`risk ${plan.risk}`}>{plan.risk} risk</span>
      </div>
      {plan.agentTrace && <div className="agent-trace" aria-label="Model inspection summary">
        <span><strong>{plan.agentTrace.featureCount}</strong><small>features read</small></span>
        <span><strong>{plan.agentTrace.dependencyCount}</strong><small>dependency links</small></span>
        <span><strong>{plan.agentTrace.geometry.solidBodyCount ?? plan.agentTrace.geometry.partCount ?? "—"}</strong><small>solid bodies</small></span>
        <span><strong>{plan.agentTrace.planningAttempts}</strong><small>validation pass{plan.agentTrace.planningAttempts === 1 ? "" : "es"}</small></span>
      </div>}
      <ol className="operations">
        {plan.operations.map((operation, index) => <li key={`${operation.type}-${index}`}>
          <span className="op-index">{String(index + 1).padStart(2, "0")}</span>
          <div>
            <strong>{operationTitle(operation)}</strong>
            <OperationDetail operation={operation} />
            <small>{operation.reason}</small>
          </div>
          {plan.result?.operations[index] && <span className={`op-status ${plan.result.operations[index].status}`}>{plan.result.operations[index].status === "applied" ? "✓" : "!"}</span>}
        </li>)}
      </ol>
      {plan.warnings.length > 0 && <div className="warnings">{plan.warnings.map((warning) => <p key={warning}>△ {warning}</p>)}</div>}
      {plan.result?.regenerationErrors.length ? <div className="warnings error-list">{plan.result.regenerationErrors.map((item) => <p key={item.featureId}>! {item.featureName}: {item.message ?? item.status}</p>)}</div> : null}
      {plan.result?.preexistingRegenerationErrors?.length ? <div className="existing-errors"><p>{plan.result.preexistingRegenerationErrors.length} pre-existing model error(s) were recorded separately and did not fail this plan.</p></div> : null}
      <div className="approval-bar">
        <div><strong>{plan.status === "pending" ? "Ready for review" : plan.status === "applied" ? "Changes applied" : "Execution stopped"}</strong><small>{plan.status === "pending" ? "Onshape can undo applied edits." : `${plan.result?.operations.filter((item) => item.status === "applied").length ?? 0} operation(s) applied.`}</small></div>
        {plan.status === "pending" && <button className="apply-button" onClick={() => void applyPlan()} disabled={busy !== null}>{busy === "applying" ? "Applying…" : "Approve & apply"}</button>}
      </div>
    </section>}

    <footer><span className="shield">◇</span> No CAD change runs without approval</footer>
  </main>;
}
