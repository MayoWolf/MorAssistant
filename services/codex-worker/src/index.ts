import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  CAD_PLAN_JSON_SCHEMA,
  cadPlanSchema,
  normalizeCadPlanOutput,
  validatePlanAgainstFeatureTree,
  type CadPlan
} from "@morassistant/cad-command-schema";
import {
  featureFingerprint,
  type FeatureDependencyNode,
  type PartStudioGeometrySummary,
  type PartStudioInspection
} from "@morassistant/onshape-client";

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const SAFE_CHILD_ENVIRONMENT = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy"
] as const;

function childEnvironment(codexHome: string, temporaryDirectory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: codexHome,
    CODEX_HOME: codexHome,
    TMPDIR: temporaryDirectory
  };
  for (const name of SAFE_CHILD_ENVIRONMENT) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function boundedJson(value: unknown, maximumLength: number): string | undefined {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  return serialized.length <= maximumLength ? serialized : undefined;
}

function repeatedExpressions(inspection: PartStudioInspection): Array<{
  expression: string;
  occurrences: Array<{ featureId: string; featureName: string; parameterId: string }>;
}> {
  const expressions = new Map<string, Array<{ featureId: string; featureName: string; parameterId: string }>>();
  for (const feature of inspection.featureTree.features) {
    for (const parameter of feature.parameters ?? []) {
      if (typeof parameter.expression !== "string" || !parameter.parameterId) continue;
      const expression = parameter.expression.trim();
      if (!expression || expression.startsWith("#")) continue;
      const occurrences = expressions.get(expression) ?? [];
      occurrences.push({
        featureId: feature.featureId,
        featureName: feature.name ?? feature.featureId,
        parameterId: parameter.parameterId
      });
      expressions.set(expression, occurrences);
    }
  }
  return [...expressions.entries()]
    .filter(([, occurrences]) => occurrences.length > 1)
    .slice(0, 30)
    .map(([expression, occurrences]) => ({ expression, occurrences }));
}

function dependencyWarnings(plan: CadPlan, dependencies: FeatureDependencyNode[]): CadPlan {
  const byId = new Map(dependencies.map((node) => [node.featureId, node]));
  const warnings = [...plan.warnings];
  for (const operation of plan.operations) {
    if (!["replace_feature", "delete_feature"].includes(operation.type)) continue;
    const node = "featureId" in operation ? byId.get(operation.featureId) : undefined;
    if (!node?.usedBy.length) continue;
    const downstreamNames = node.usedBy
      .map((id) => byId.get(id)?.name ?? id)
      .slice(0, 5)
      .join(", ");
    const warning = `${node.name} has ${node.usedBy.length} direct downstream dependent${node.usedBy.length === 1 ? "" : "s"}: ${downstreamNames}.`;
    if (!warnings.includes(warning) && warnings.length < 10) warnings.push(warning);
  }
  return cadPlanSchema.parse({ ...plan, warnings });
}

export interface DeviceCodeResponse {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface PlanningResult {
  plan: CadPlan;
  attempts: number;
  inspection: {
    featureCount: number;
    dependencyCount: number;
    geometry: PartStudioGeometrySummary;
    warnings: string[];
  };
}

export class CodexWorker {
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationWaiters = new Map<string, Set<(params: unknown) => void>>();
  private readonly notificationRejectors = new Set<(error: Error) => void>();
  private readonly recentNotifications: Array<{ method: string; params: unknown }> = [];
  private started: Promise<void> | undefined;

  constructor(
    readonly codexHome: string,
    private readonly model?: string,
    private readonly codexCommand = "codex"
  ) {}

  async start(): Promise<void> {
    if (this.started) return this.started;
    this.started = this.startProcess();
    return this.started;
  }

  private async startProcess(): Promise<void> {
    await mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    const workdir = join(this.codexHome, "workspace");
    await mkdir(workdir, { recursive: true, mode: 0o700 });
    const temporaryDirectory = join(this.codexHome, "tmp");
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    this.process = spawn(this.codexCommand, ["app-server", "--stdio"], {
      cwd: workdir,
      env: childEnvironment(this.codexHome, temporaryDirectory),
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdout = createInterface({ input: this.process.stdout });
    stdout.on("line", (line) => this.handleLine(line));
    this.process.stderr.on("data", (chunk) => {
      if (String(chunk).trim()) {
        console.warn("[codex-worker] app-server emitted diagnostic output; content suppressed to protect sign-in data.");
      }
    });
    this.process.once("exit", (code, signal) => {
      this.rejectPending(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"}).`));
      this.process = undefined;
      this.started = undefined;
    });
    this.process.once("error", (error) => {
      this.rejectPending(new Error(`Unable to start Codex app-server: ${error.message}`));
      this.process = undefined;
      this.started = undefined;
    });

    await new Promise<void>((resolvePromise, reject) => {
      this.process!.once("spawn", resolvePromise);
      this.process!.once("error", reject);
    });

    await this.request("initialize", {
      clientInfo: { name: "morassistant", title: "MorAssistant Onshape Copilot", version: "0.1.0" },
      capabilities: { requestAttestation: false }
    });
    this.notify("initialized");
  }

  private handleLine(line: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      console.warn(`[codex-worker] Ignoring non-JSON output: ${line}`);
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex app-server request failed."));
      else pending.resolve(message.result);
      return;
    }

    if (message.method) {
      this.recentNotifications.push({ method: message.method, params: message.params });
      if (this.recentNotifications.length > 100) this.recentNotifications.shift();
      for (const waiter of this.notificationWaiters.get(message.method) ?? []) waiter(message.params);
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const reject of this.notificationRejectors) reject(error);
    this.notificationRejectors.clear();
    this.notificationWaiters.clear();
  }

  private notify(method: string, params?: unknown): void {
    if (!this.process) throw new Error("Codex app-server is not running.");
    this.process.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
  }

  private async request(method: string, params?: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (!this.process) throw new Error("Codex app-server is not running.");
    const id = this.nextId++;
    const result = new Promise<unknown>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
    });
    this.process.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    return result;
  }

  private waitForNotification(method: string, predicate: (params: unknown) => boolean, timeoutMs = 180_000): Promise<unknown> {
    const existingIndex = this.recentNotifications.findIndex(
      (notification) => notification.method === method && predicate(notification.params)
    );
    if (existingIndex >= 0) {
      const [notification] = this.recentNotifications.splice(existingIndex, 1);
      return Promise.resolve(notification?.params);
    }
    return new Promise((resolvePromise, reject) => {
      const waiters = this.notificationWaiters.get(method) ?? new Set();
      this.notificationWaiters.set(method, waiters);
      let timer: NodeJS.Timeout;
      const rejectWaiter = (error: Error) => {
        clearTimeout(timer);
        waiters.delete(listener);
        if (waiters.size === 0) this.notificationWaiters.delete(method);
        this.notificationRejectors.delete(rejectWaiter);
        reject(error);
      };
      const listener = (params: unknown) => {
        if (!predicate(params)) return;
        clearTimeout(timer);
        waiters.delete(listener);
        if (waiters.size === 0) this.notificationWaiters.delete(method);
        this.notificationRejectors.delete(rejectWaiter);
        const historyIndex = this.recentNotifications.findIndex(
          (notification) => notification.method === method && notification.params === params
        );
        if (historyIndex >= 0) this.recentNotifications.splice(historyIndex, 1);
        resolvePromise(params);
      };
      timer = setTimeout(() => rejectWaiter(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
      waiters.add(listener);
      this.notificationRejectors.add(rejectWaiter);
    });
  }

  async accountStatus(): Promise<"connected" | "disconnected"> {
    await this.start();
    const response = await this.request("account/read", { refreshToken: false }) as {
      account?: unknown;
    };
    return response.account ? "connected" : "disconnected";
  }

  async startDeviceCodeLogin(): Promise<DeviceCodeResponse> {
    await this.start();
    const response = await this.request("account/login/start", { type: "chatgptDeviceCode" }) as DeviceCodeResponse;
    if (response.type !== "chatgptDeviceCode") throw new Error("Codex did not start a device-code login.");
    return response;
  }

  waitForLogin(loginId: string): Promise<boolean> {
    return this.waitForNotification("account/login/completed", (params) => {
      const result = params as { loginId?: string };
      return result.loginId === loginId;
    }, 10 * 60_000).then((params) => Boolean((params as { success?: boolean }).success));
  }

  private async runPlanningTurn(threadId: string, text: string): Promise<string> {
    const turnResponse = await this.request("turn/start", {
      threadId,
      cwd: join(this.codexHome, "workspace"),
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      input: [{ type: "text", text, text_elements: [] }],
      outputSchema: CAD_PLAN_JSON_SCHEMA
    }) as { turn: { id: string } };

    const completed = await this.waitForNotification("turn/completed", (params) => {
      const event = params as { threadId?: string; turn?: { id?: string } };
      return event.threadId === threadId && event.turn?.id === turnResponse.turn.id;
    }) as {
      turn: { status: string; error?: { message?: string } | null; items?: Array<{ type: string; text?: string }> };
    };
    if (completed.turn.status !== "completed") {
      throw new Error(completed.turn.error?.message ?? `Codex planning turn ${completed.turn.status}.`);
    }
    let message = [...(completed.turn.items ?? [])].reverse()
      .find((item) => item.type === "agentMessage" && item.text);
    if (!message) {
      const itemCompleted = await this.waitForNotification("item/completed", (params) => {
        const event = params as { threadId?: string; turnId?: string; item?: { type?: string; text?: string } };
        return event.threadId === threadId &&
          event.turnId === turnResponse.turn.id &&
          event.item?.type === "agentMessage" &&
          typeof event.item.text === "string";
      }, 5_000).catch(() => undefined) as { item?: { type?: string; text?: string } } | undefined;
      if (itemCompleted?.item?.type === "agentMessage" && itemCompleted.item.text) {
        message = { type: itemCompleted.item.type, text: itemCompleted.item.text };
      }
    }
    if (!message?.text) throw new Error("Codex completed without a CAD plan.");
    return message.text;
  }

  async createPlan(prompt: string, inspection: PartStudioInspection): Promise<PlanningResult> {
    await this.start();
    if (await this.accountStatus() !== "connected") throw new Error("Connect ChatGPT before creating a plan.");

    let featurePayloadBudget = 200_000;
    const dependencyById = new Map(inspection.dependencies.map((node) => [node.featureId, node]));
    const featureSnapshot = inspection.featureTree.features.map((feature) => {
      const serialized = JSON.stringify(feature);
      const includePayload = serialized.length <= 60_000 && serialized.length <= featurePayloadBudget;
      if (includePayload) featurePayloadBudget -= serialized.length;
      const dependency = dependencyById.get(feature.featureId);
      return {
        featureId: feature.featureId,
        name: feature.name,
        featureType: feature.featureType,
        status: dependency?.status ?? feature.featureStatus ?? "OK",
        index: dependency?.index,
        dependsOn: dependency?.dependsOn ?? [],
        usedBy: dependency?.usedBy ?? [],
        featureHash: featureFingerprint(feature),
        ...(includePayload ? { featureJson: serialized } : { featureJsonOmitted: "payload budget" }),
        parameters: feature.parameters?.filter((parameter) => typeof parameter.expression === "string")
          .map((parameter) => ({ parameterId: parameter.parameterId, expression: parameter.expression }))
      };
    });
    const modelSnapshot = {
      features: featureSnapshot,
      dependencyGraph: inspection.dependencies,
      repeatedExpressions: repeatedExpressions(inspection),
      geometry: inspection.geometry,
      geometryEvidence: {
        bodyDetailsJson: boundedJson(inspection.bodyDetails, 80_000),
        massPropertiesJson: boundedJson(inspection.massProperties, 40_000),
        topologyEvaluationJson: boundedJson(inspection.topologyEvaluation, 20_000)
      },
      inspectionWarnings: inspection.warnings
    };
    const threadResponse = await this.request("thread/start", {
      ...(this.model ? { model: this.model } : {}),
      cwd: join(this.codexHome, "workspace"),
      serviceName: "morassistant-onshape-cad-agent",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: [
        "You are a dependency-aware native Onshape Part Studio planning agent.",
        "Return only a structured plan matching the supplied schema.",
        "Reason from the feature payloads, dependency graph, regeneration states, repeated expressions, topology, and mass properties provided by the trusted host.",
        "Do not modify or remove a feature without considering its usedBy downstream dependents. Surface any material downstream risk in warnings.",
        "For rename_feature and update_dimension, use only feature IDs, parameter IDs, names, and current expressions present in the snapshot.",
        "You may create new axis-aligned rectangle or square sketches with create_rectangle_sketch; it needs no existing feature ID and currently supports only the Top plane.",
        "For squares, widthMm and heightMm must be equal. When dimensions are omitted, choose clear deterministic sizes and mention the choice in warnings.",
        "Give every new sketch a unique descriptive name. Separate multiple rectangles with centerXmm and centerYmm so they do not overlap.",
        "For any other standard Part Studio feature, use create_feature with an exact native Onshape BTMFeature-134 or BTMSketch-151 object serialized as minified featureJson.",
        "create_feature supports standard sketches, variables, extrude, revolve, sweep, loft, fillet, chamfer, shell, hole, draft, rib, boolean, split, transform, patterns, mate connectors, and other valid Part Studio featureType payloads.",
        "When the user asks to make a model parametric, use repeatedExpressions as evidence: create well-named native variable features only with a valid exact payload, then replace matching literal quantity expressions with #variable references.",
        "Use @feature:Exact Feature Name anywhere featureJson needs a featureId. Creation operations may reference features created earlier in the same ordered plan.",
        "For a blind new-body extrude, use BTMFeature-134 featureType extrude with enum parameters bodyType=SOLID, operationType=NEW, a BTMParameterQueryList-148 entities query containing BTMIndividualSketchRegionQuery-140 whose featureId is @feature:Sketch Name, endBound=BLIND, and a BTMParameterQuantity-147 depth expression with units.",
        "For a square pyramid, create or replace an extrude from the base square with hasDraft=true, draftAngle chosen from the base half-width and depth but slightly below the exact convergence angle, and draftPullDirection=false; include those as BTMParameterBoolean-144, BTMParameterQuantity-147 with degree units, and BTMParameterBoolean-144 parameters respectively.",
        "Use replace_feature with the exact featureHash from the snapshot to change a whole existing native feature, and preserve fields from featureJson that are not intentionally changed.",
        "Use delete_feature only when explicitly requested. Any delete plan must be high risk. create_feature and replace_feature must be at least medium risk.",
        "Do not invent existing IDs, payload fields, or unsupported references. Every change requires explicit user approval.",
        "Prefer the smallest set of reversible edits. Flag uncertainty in warnings."
      ].join("\n")
    }) as { thread: { id: string } };

    const featureTreeWithHashes = inspection.featureTree.features
      .map((feature) => ({ ...feature, featureHash: featureFingerprint(feature) }));
    let feedback = "";
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const text = [
        `User request:\n${prompt}`,
        feedback,
        `Current Part Studio model snapshot:\n${JSON.stringify(modelSnapshot)}`
      ].filter(Boolean).join("\n\n");
      try {
        const output = await this.runPlanningTurn(threadResponse.thread.id, text);
        let parsed: unknown;
        try {
          parsed = JSON.parse(output);
        } catch {
          throw new Error("The response was not valid JSON.");
        }
        const plan = dependencyWarnings(
          validatePlanAgainstFeatureTree(
            cadPlanSchema.parse(normalizeCadPlanOutput(parsed)),
            featureTreeWithHashes
          ),
          inspection.dependencies
        );
        return {
          plan,
          attempts: attempt,
          inspection: {
            featureCount: inspection.featureTree.features.length,
            dependencyCount: inspection.dependencies.reduce((count, node) => count + node.dependsOn.length, 0),
            geometry: inspection.geometry,
            warnings: inspection.warnings
          }
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Unknown plan validation failure.");
        feedback = [
          "Your previous proposed plan failed trusted-host validation.",
          `Validation feedback: ${lastError.message.slice(0, 2_000)}`,
          "Re-read the supplied model snapshot and return a corrected complete plan. Do not explain the failure outside the plan warnings."
        ].join("\n");
      }
    }
    throw new Error(`Codex could not produce a safe valid CAD plan after 3 attempts: ${lastError?.message ?? "validation failed"}`);
  }

  stop(): void {
    this.process?.kill("SIGTERM");
  }
}

export class CodexWorkerPool {
  private readonly workers = new Map<string, { worker: CodexWorker; idleTimer: NodeJS.Timeout }>();

  constructor(
    private readonly root: string,
    private readonly model?: string,
    private readonly command = "codex",
    private readonly maxWorkers = 4,
    private readonly idleTimeoutMs = 15 * 60_000
  ) {}

  forUser(userId: string): CodexWorker {
    const key = createHash("sha256").update(userId).digest("hex");
    let entry = this.workers.get(key);
    if (!entry) {
      if (this.workers.size >= this.maxWorkers) {
        throw new Error("Codex worker capacity is temporarily full. Try again in a few minutes.");
      }
      const worker = new CodexWorker(resolve(this.root, key), this.model, this.command);
      entry = { worker, idleTimer: this.idleTimer(key, worker) };
      this.workers.set(key, entry);
    } else {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = this.idleTimer(key, entry.worker);
    }
    return entry.worker;
  }

  stopAll(): void {
    for (const { worker, idleTimer } of this.workers.values()) {
      clearTimeout(idleTimer);
      worker.stop();
    }
    this.workers.clear();
  }

  stopForUser(userId: string): void {
    const key = createHash("sha256").update(userId).digest("hex");
    const entry = this.workers.get(key);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    entry.worker.stop();
    this.workers.delete(key);
  }

  private idleTimer(key: string, worker: CodexWorker): NodeJS.Timeout {
    const timer = setTimeout(() => {
      worker.stop();
      this.workers.delete(key);
    }, this.idleTimeoutMs);
    timer.unref();
    return timer;
  }
}
