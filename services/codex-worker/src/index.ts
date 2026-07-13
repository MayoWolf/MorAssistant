import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { CAD_PLAN_JSON_SCHEMA, cadPlanSchema, type CadPlan } from "@morassistant/cad-command-schema";
import type { FeatureListResponse } from "@morassistant/onshape-client";

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

export interface DeviceCodeResponse {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
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
    this.process = spawn(this.codexCommand, ["app-server", "--stdio"], {
      cwd: workdir,
      env: { ...process.env, CODEX_HOME: this.codexHome },
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

    await this.request("initialize", {
      clientInfo: { name: "morassistant", title: "MorAssistant Onshape Copilot", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
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
      requiresOpenaiAuth?: boolean;
    };
    return response.account && !response.requiresOpenaiAuth ? "connected" : "disconnected";
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

  async createPlan(prompt: string, features: FeatureListResponse): Promise<CadPlan> {
    await this.start();
    if (await this.accountStatus() !== "connected") throw new Error("Connect ChatGPT before creating a plan.");

    const featureSnapshot = features.features.map((feature) => ({
      featureId: feature.featureId,
      name: feature.name,
      featureType: feature.featureType,
      parameters: feature.parameters?.filter((parameter) => typeof parameter.expression === "string")
        .map((parameter) => ({ parameterId: parameter.parameterId, expression: parameter.expression }))
    }));
    const threadResponse = await this.request("thread/start", {
      ...(this.model ? { model: this.model } : {}),
      serviceName: "morassistant-onshape-cad-agent",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: [
        "You are a conservative CAD planning component.",
        "Return only a structured plan matching the supplied schema.",
        "Use only feature IDs, parameter IDs, names, and current expressions present in the snapshot.",
        "Do not invent geometry or references. Every change requires explicit user approval.",
        "Prefer the smallest set of reversible edits. Flag uncertainty in warnings."
      ].join("\n")
    }) as { thread: { id: string } };

    const turnResponse = await this.request("turn/start", {
      threadId: threadResponse.thread.id,
      input: [{
        type: "text",
        text: `User request:\n${prompt}\n\nCurrent Part Studio feature snapshot:\n${JSON.stringify(featureSnapshot)}`,
        text_elements: []
      }],
      outputSchema: CAD_PLAN_JSON_SCHEMA
    }) as { turn: { id: string } };

    const completed = await this.waitForNotification("turn/completed", (params) => {
      const event = params as { threadId?: string; turn?: { id?: string } };
      return event.threadId === threadResponse.thread.id && event.turn?.id === turnResponse.turn.id;
    }) as {
      turn: { status: string; error?: { message?: string } | null; items: Array<{ type: string; text?: string }> };
    };
    if (completed.turn.status !== "completed") {
      throw new Error(completed.turn.error?.message ?? `Codex planning turn ${completed.turn.status}.`);
    }
    const message = [...completed.turn.items].reverse().find((item) => item.type === "agentMessage" && item.text);
    if (!message?.text) throw new Error("Codex completed without a CAD plan.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.text);
    } catch {
      throw new Error("Codex returned a plan that was not valid JSON.");
    }
    return cadPlanSchema.parse(parsed);
  }

  stop(): void {
    this.process?.kill("SIGTERM");
  }
}

export class CodexWorkerPool {
  private readonly workers = new Map<string, CodexWorker>();

  constructor(
    private readonly root: string,
    private readonly model?: string,
    private readonly command = "codex"
  ) {}

  forUser(userId: string): CodexWorker {
    const key = createHash("sha256").update(userId).digest("hex");
    let worker = this.workers.get(key);
    if (!worker) {
      worker = new CodexWorker(resolve(this.root, key), this.model, this.command);
      this.workers.set(key, worker);
    }
    return worker;
  }

  stopAll(): void {
    for (const worker of this.workers.values()) worker.stop();
    this.workers.clear();
  }
}
