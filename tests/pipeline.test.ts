import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const seed = Math.floor(Math.random() * 1000);
const appPort = 34_000 + seed * 2;
const onshapePort = appPort + 1;
const appOrigin = `http://127.0.0.1:${appPort}`;
const onshapeOrigin = `http://127.0.0.1:${onshapePort}`;
const installationToken = "mock-personal-installation-token-with-at-least-32-characters";
let pipeline: ChildProcessWithoutNullStreams;
let cookie = "";

async function waitUntilReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Mock pipeline did not start in time.")), 15_000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("MOCK_PIPELINE_READY")) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.stderr.on("data", (chunk) => {
      const message = String(chunk);
      if (message) process.stderr.write(message);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Mock pipeline exited early (${code}).`));
    });
  });
}

function sessionHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-mor-installation": installationToken, ...(cookie ? { cookie } : {}), ...extra };
}

async function grantOnshapeAccess(): Promise<void> {
  const start = await fetch(`${appOrigin}/oauth/onshape/start?companyId=beta-company&installationToken=${installationToken}`, { redirect: "manual" });
  expect(start.status).toBe(302);
  cookie = start.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  expect(cookie).toBe("");
  const authorizationLocation = start.headers.get("location")!;
  expect(new URL(authorizationLocation).searchParams.get("company_id")).toBe("beta-company");
  const authorize = await fetch(authorizationLocation, { redirect: "manual" });
  expect(authorize.status).toBe(302);
  const callback = await fetch(authorize.headers.get("location")!, { headers: sessionHeaders(), redirect: "manual" });
  expect(callback.status).toBe(200);
}

async function waitForCodex(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${appOrigin}/api/status`, { headers: sessionHeaders() });
    const status = await response.json() as { codex: string };
    if (status.codex === "connected") return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Codex did not become connected.");
}

beforeAll(async () => {
  pipeline = spawn(process.execPath, [resolve("scripts/run-mock-pipeline.mjs")], {
    cwd: resolve("."),
    env: {
      ...process.env,
      MOR_MOCK_APP_PORT: String(appPort),
      MOR_MOCK_ONSHAPE_PORT: String(onshapePort),
      MOR_MOCK_INSTALLATION_TOKEN: installationToken,
      MOR_MOCK_PLANNING_TIMEOUT_MS: "1400",
      MOR_MOCK_PLANNING_IDLE_MS: "500"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  await waitUntilReady(pipeline);
}, 20_000);

afterAll(async () => {
  if (!pipeline || pipeline.killed) return;
  pipeline.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 3_000);
    pipeline.once("exit", () => { clearTimeout(timer); resolvePromise(); });
  });
});

describe("installed Onshape extension pipeline", () => {
  it("serves an iframe-compatible panel with secure headers", async () => {
    const response = await fetch(`${appOrigin}/?documentId=d&workspaceOrVersion=w&workspaceId=w&elementId=e&server=${encodeURIComponent(onshapeOrigin)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(response.headers.get("content-security-policy")).toContain("https://*.onshape.com");
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(await response.text()).toContain("MorAssistant");

    const invalidCallback = await fetch(`${appOrigin}/oauth/onshape/callback?code=bad&state=bad`);
    expect(invalidCallback.status).toBe(400);
    expect(invalidCallback.headers.get("cache-control")).toBe("no-store");

    const missingInstallation = await fetch(`${appOrigin}/api/status`);
    expect(missingInstallation.status).toBe(401);

    const installationPreflight = await fetch(`${appOrigin}/api/status`, {
      method: "OPTIONS",
      headers: {
        origin: appOrigin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-mor-installation",
        "access-control-request-private-network": "true"
      }
    });
    expect(installationPreflight.status).toBe(204);
    expect(installationPreflight.headers.get("access-control-allow-headers")).toContain("x-mor-installation");
    expect(installationPreflight.headers.get("access-control-allow-private-network")).toBe("true");

    const untrustedPrivateNetworkPreflight = await fetch(`${appOrigin}/api/status`, {
      method: "OPTIONS",
      headers: {
        origin: "https://untrusted.example",
        "access-control-request-method": "GET",
        "access-control-request-private-network": "true"
      }
    });
    expect(untrustedPrivateNetworkPreflight.headers.get("access-control-allow-private-network")).toBeNull();

    const deniedStart = await fetch(`${appOrigin}/oauth/onshape/start?installationToken=${installationToken}`, { redirect: "manual" });
    const deniedState = new URL(deniedStart.headers.get("location")!).searchParams.get("state");
    const deniedCallback = await fetch(`${appOrigin}/oauth/onshape/callback?error=access_denied&state=${deniedState}`);
    expect(deniedCallback.status).toBe(400);
    expect(await deniedCallback.text()).toContain("access was not granted");
  });

  it("completes Onshape OAuth, Codex OAuth, planning, approval, and mutation", async () => {
    await grantOnshapeAccess();

    const initialStatus = await fetch(`${appOrigin}/api/status`, { headers: sessionHeaders() }).then((response) => response.json());
    expect(initialStatus).toEqual({ onshape: "connected", codex: "disconnected" });

    const csrf = await fetch(`${appOrigin}/api/codex/connect`, { method: "POST", headers: sessionHeaders() });
    expect(csrf.status).toBe(403);

    const loginResponse = await fetch(`${appOrigin}/api/codex/connect`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    });
    expect(loginResponse.status).toBe(200);
    expect(await loginResponse.json()).toMatchObject({ type: "chatgptDeviceCode", userCode: "MOR-TEST" });
    await waitForCodex();
    const connected = await fetch(`${appOrigin}/api/status`, { headers: sessionHeaders() }).then((response) => response.json());
    expect(connected).toMatchObject({
      codexRuntime: { model: "gpt-6.2-sol", reasoningEffort: "high", available: true },
      codexModels: expect.arrayContaining([{ model: "gpt-6.2-astra", label: "GPT-6.2 Astra", defaultEffort: "medium", efforts: ["medium"] }])
    });

    const context = {
      documentId: "document",
      workspaceOrVersion: "w",
      workspaceId: "workspace",
      elementId: "element",
      server: onshapeOrigin
    };
    const repairedPlanResponse = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Exercise self-correcting plan validation and inspect geometry", context })
    });
    expect(repairedPlanResponse.status).toBe(201);
    expect(await repairedPlanResponse.json()).toMatchObject({
      status: "pending",
      agentTrace: {
        planningAttempts: 2,
        usage: { totalTokens: 6420, cachedInputTokens: 1800, limitTokens: 24000 },
        featureCount: 1,
        dependencyCount: 0,
        geometry: { solidBodyCount: 1, faceCount: 6, edgeCount: 12, vertexCount: 8 }
      }
    });

    const targets = await fetch(`${appOrigin}/api/context/targets?${new URLSearchParams(context)}`, { headers: sessionHeaders() });
    expect(await targets.json()).toMatchObject({ targets: [{ id: "f1", name: "Extrude 1" }] });

    const jobStart = await fetch(`${appOrigin}/api/plan-jobs`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Preview a clearer feature name", context, model: "gpt-6.2-astra", effort: "medium", targetIds: ["f1"] })
    });
    expect(jobStart.status).toBe(202);
    const { id: jobId } = await jobStart.json() as { id: string };
    let completedJob: {
      status?: string;
      progress?: Array<{ kind?: string; message?: string }>;
      plan?: { status?: string; operations?: unknown[]; sources?: unknown[] };
    } = {};
    for (let attempt = 0; attempt < 30; attempt += 1) {
      completedJob = await fetch(`${appOrigin}/api/plan-jobs/${jobId}`, {
        headers: sessionHeaders()
      }).then((response) => response.json());
      if (completedJob.status !== "planning") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    expect(completedJob).toMatchObject({
      status: "completed",
      progress: expect.arrayContaining([
        expect.objectContaining({ kind: "reasoning" }),
        expect.objectContaining({ kind: "inspection", message: "Checked Onshape target: f1" }),
        expect.objectContaining({ kind: "research", message: expect.stringContaining("Research complete") }),
        expect.objectContaining({ kind: "validation" })
      ]),
      plan: {
        status: "pending", sources: [], message: "Read the attached Extrude 1 payload.",
        agentTrace: { planningAttempts: 1, featureCount: 1, continuedConversation: true,
          runtime: { model: "gpt-6.2-astra", reasoningEffort: "medium" } }
      }
    });

    const planResponse = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Rename unclear features", context })
    });
    expect(planResponse.status).toBe(201);
    const plan = await planResponse.json() as { id: string; status: string; operations: Array<{ newName: string }> };
    expect(plan).toMatchObject({ status: "pending" });
    expect(plan.operations[0]?.newName).toBe("Base Extrusion");

    const applyResponse = await fetch(`${appOrigin}/api/plans/${plan.id}/apply`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    });
    expect(applyResponse.status).toBe(200);
    const applied = await applyResponse.json();
    expect(applied).toMatchObject({
      status: "applied",
      result: {
        status: "applied",
        regenerationErrors: [],
        preexistingRegenerationErrors: [],
        operations: [{ status: "applied", verification: "passed" }]
      }
    });

    const state = await fetch(`${onshapeOrigin}/__state`).then((response) => response.json()) as { feature: { name: string }; microversion: number };
    expect(state.feature.name).toBe("Base Extrusion");
    expect(state.microversion).toBe(2);

    const replay = await fetch(`${appOrigin}/api/plans/${plan.id}/apply`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    });
    expect(replay.status).toBe(409);

    const conversationAnswerResponse = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "What did we just change?", context })
    });
    expect(conversationAnswerResponse.status).toBe(201);
    expect(await conversationAnswerResponse.json()).toMatchObject({
      status: "applied",
      operations: [],
      message: expect.stringMatching(/retained \d+ earlier turns/i),
      agentTrace: { continuedConversation: true }
    });

    const conversationQuery = new URLSearchParams({
      documentId: context.documentId,
      workspaceId: context.workspaceId,
      elementId: context.elementId,
      workspaceOrVersion: context.workspaceOrVersion,
      server: context.server
    });
    const conversation = await fetch(`${appOrigin}/api/conversation?${conversationQuery}`, {
      headers: sessionHeaders()
    }).then((response) => response.json()) as { hasPersistentContext?: boolean; plans?: Array<{ prompt?: string }> };
    expect(conversation.hasPersistentContext).toBe(true);
    expect(conversation.plans?.some((entry) => entry.prompt === "What did we just change?")).toBe(true);

    const secondPlanResponse = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Clarify the renamed feature", context })
    });
    expect(secondPlanResponse.status).toBe(201);
    const secondPlan = await secondPlanResponse.json() as { id: string };
    const concurrentResults = await Promise.all([1, 2].map(() => fetch(`${appOrigin}/api/plans/${secondPlan.id}/apply`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    })));
    expect(concurrentResults.map((response) => response.status).sort()).toEqual([200, 409]);

    const concurrentState = await fetch(`${onshapeOrigin}/__state`).then((response) => response.json()) as {
      feature: { name: string };
      microversion: number;
    };
    expect(concurrentState.feature.name).toBe("Base Extrusion refined");
    expect(concurrentState.microversion).toBe(3);

    const dimensionPlanResponse = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Change the depth dimension to 6 mm", context })
    });
    expect(dimensionPlanResponse.status).toBe(201);
    const dimensionPlan = await dimensionPlanResponse.json() as {
      id: string;
      operations: Array<{ type: string; newExpression?: string }>;
    };
    expect(dimensionPlan.operations[0]).toMatchObject({ type: "update_dimension", newExpression: "6 mm" });
    const dimensionApply = await fetch(`${appOrigin}/api/plans/${dimensionPlan.id}/apply`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    });
    expect(dimensionApply.status).toBe(200);
    expect(await dimensionApply.json()).toMatchObject({ status: "applied" });
    const dimensionState = await fetch(`${onshapeOrigin}/__state`).then((response) => response.json()) as {
      feature: { parameters: Array<{ parameterId: string; expression: string }> };
      microversion: number;
    };
    expect(dimensionState.feature.parameters[0]).toMatchObject({ parameterId: "depth", expression: "6 mm" });
    expect(dimensionState.microversion).toBe(4);

    const sketchPlanResponse = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Create five sketches, all of different size squares on the top plane.", context })
    });
    expect(sketchPlanResponse.status).toBe(201);
    const sketchPlan = await sketchPlanResponse.json() as {
      id: string;
      operations: Array<{ type: string; widthMm?: number; heightMm?: number }>;
    };
    expect(sketchPlan.operations).toHaveLength(5);
    expect(sketchPlan.operations.every((operation) =>
      operation.type === "create_rectangle_sketch" && operation.widthMm === operation.heightMm
    )).toBe(true);

    const sketchApply = await fetch(`${appOrigin}/api/plans/${sketchPlan.id}/apply`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    });
    expect(sketchApply.status).toBe(200);
    expect(await sketchApply.json()).toMatchObject({
      status: "applied",
      result: { status: "applied", regenerationErrors: [], operations: new Array(5).fill({ status: "applied" }) }
    });
    const sketchState = await fetch(`${onshapeOrigin}/__state`).then((response) => response.json()) as {
      sketches: Array<{ name: string; entities: unknown[] }>;
      microversion: number;
    };
    expect(sketchState.sketches.map((sketch) => sketch.name)).toEqual([
      "Square 10 mm",
      "Square 20 mm",
      "Square 30 mm",
      "Square 40 mm",
      "Square 50 mm"
    ]);
    expect(sketchState.sketches.every((sketch) => sketch.entities.length === 4)).toBe(true);
    expect(sketchState.microversion).toBe(9);

    const extrudePlanResponse = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Extrude the first square 15 mm as a new solid", context })
    });
    expect(extrudePlanResponse.status).toBe(201);
    const extrudePlan = await extrudePlanResponse.json() as {
      id: string;
      operations: Array<{ type: string; featureType?: string }>;
    };
    expect(extrudePlan.operations[0]).toMatchObject({ type: "create_feature", featureType: "extrude" });
    const extrudeApply = await fetch(`${appOrigin}/api/plans/${extrudePlan.id}/apply`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    });
    expect(extrudeApply.status).toBe(200);
    expect(await extrudeApply.json()).toMatchObject({ status: "applied", result: { regenerationErrors: [] } });
    const extrudeState = await fetch(`${onshapeOrigin}/__state`).then((response) => response.json()) as {
      sketches: Array<{ featureType: string; name: string; parameters: Array<Record<string, unknown>> }>;
      microversion: number;
    };
    const createdExtrude = extrudeState.sketches.find((item) => item.featureType === "extrude");
    expect(createdExtrude).toMatchObject({ name: "Square 10 mm Extrude" });
    expect(createdExtrude?.parameters.find((parameter) => parameter.parameterId === "depth"))
      .toMatchObject({ expression: "15 mm" });
    expect(extrudeState.microversion).toBe(10);

    const failurePlanResponse = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Trigger regeneration recovery", context })
    });
    expect(failurePlanResponse.status).toBe(201);
    const failurePlan = await failurePlanResponse.json() as { id: string };
    const failureApply = await fetch(`${appOrigin}/api/plans/${failurePlan.id}/apply`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    });
    expect(failureApply.status).toBe(200);
    expect(await failureApply.json()).toMatchObject({
      status: "failed",
      result: {
        operations: [{ status: "failed", verification: "failed" }],
        regenerationErrors: [{ featureName: "Broken Base", status: "ERROR" }]
      }
    });

    const recoveryStart = await fetch(`${appOrigin}/api/plans/${failurePlan.id}/recovery-jobs`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    });
    expect(recoveryStart.status).toBe(202);
    const { id: recoveryJobId } = await recoveryStart.json() as { id: string };
    let recoveryJob: { status?: string; plan?: { id: string; recoveryForPlanId?: string } } = {};
    for (let attempt = 0; attempt < 30; attempt += 1) {
      recoveryJob = await fetch(`${appOrigin}/api/plan-jobs/${recoveryJobId}`, {
        headers: sessionHeaders()
      }).then((response) => response.json());
      if (recoveryJob.status !== "planning") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    expect(recoveryJob).toMatchObject({
      status: "completed",
      plan: { recoveryForPlanId: failurePlan.id }
    });
    const recoveryApply = await fetch(`${appOrigin}/api/plans/${recoveryJob.plan!.id}/apply`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    });
    expect(recoveryApply.status).toBe(200);
    expect(await recoveryApply.json()).toMatchObject({
      status: "applied",
      result: {
        regenerationErrors: [],
        preexistingRegenerationErrors: [{ featureName: "Broken Base", status: "ERROR" }]
      }
    });
    const recoveredState = await fetch(`${onshapeOrigin}/__state`).then((response) => response.json()) as {
      feature: { name: string };
      microversion: number;
    };
    expect(recoveredState.feature.name).toBe("Recovered Base");
    expect(recoveredState.microversion).toBe(12);

    const enableFeatureRateLimit = await fetch(`${onshapeOrigin}/__feature-rate-limit`, { method: "POST" });
    expect(enableFeatureRateLimit.status).toBe(200);
    const throttledPlanResponse = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Rename through the rate limit fallback", context })
    });
    expect(throttledPlanResponse.status).toBe(201);
    const throttledPlan = await throttledPlanResponse.json() as {
      id: string;
      sourceMicroversion?: string;
      agentTrace?: { inspectionWarnings: string[] };
    };
    expect(throttledPlan.sourceMicroversion).toBe("m12");
    expect(throttledPlan.agentTrace?.inspectionWarnings.join(" ")).toMatch(/rate-limited/i);

    const throttledApply = await fetch(`${appOrigin}/api/plans/${throttledPlan.id}/apply`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    });
    expect(throttledApply.status).toBe(200);
    expect(await throttledApply.json()).toMatchObject({
      status: "applied",
      result: {
        regenerationErrors: [],
        operations: [{ status: "applied", verification: "passed" }]
      }
    });
    const throttledState = await fetch(`${onshapeOrigin}/__state`).then((response) => response.json()) as {
      feature: { name: string };
      microversion: number;
    };
    expect(throttledState.feature.name).toBe("Recovered Base refined");
    expect(throttledState.microversion).toBe(13);
    const disableFeatureRateLimit = await fetch(`${onshapeOrigin}/__feature-rate-limit?enabled=false`, { method: "POST" });
    expect(disableFeatureRateLimit.status).toBe(200);

    const chamferPlanResponse = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Use the chamfer curriculum to bevel the base edges", context })
    });
    expect(chamferPlanResponse.status).toBe(201);
    const chamferPlan = await chamferPlanResponse.json() as {
      id: string;
      operations: Array<{ type: string; distanceMm?: number }>;
      agentTrace?: { capabilityCount?: number; nativeFeatureTypeCount?: number };
    };
    expect(chamferPlan.operations[0]).toMatchObject({ type: "chamfer_feature_edges", distanceMm: 1 });
    expect(chamferPlan.agentTrace).toMatchObject({ capabilityCount: 177, nativeFeatureTypeCount: 5 });
    const chamferApply = await fetch(`${appOrigin}/api/plans/${chamferPlan.id}/apply`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    });
    expect(chamferApply.status).toBe(200);
    expect(await chamferApply.json()).toMatchObject({
      status: "applied",
      result: { regenerationErrors: [], operations: [{ status: "applied", verification: "passed" }] }
    });

    const spatialPlanResponse = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Run the toy car spatial regression with four real wheels", context })
    });
    expect(spatialPlanResponse.status).toBe(201);
    const spatialPlan = await spatialPlanResponse.json() as {
      id: string;
      operations: Array<{
        type: string;
        plane?: string;
        startOffsetMm?: number;
        oppositeDirection?: boolean;
        startOffsetOppositeDirection?: boolean;
      }>;
    };
    expect(spatialPlan.operations).toHaveLength(6);
    expect(spatialPlan.operations.filter((operation) => operation.type === "create_circle_sketch"))
      .toHaveLength(2);
    expect(spatialPlan.operations.filter((operation) => operation.type === "create_circle_sketch")
      .every((operation) => operation.plane === "Front")).toBe(true);
    expect(spatialPlan.operations.filter((operation) => operation.type === "extrude_sketch")
      .every((operation) => operation.startOffsetMm === 22
        && operation.oppositeDirection === operation.startOffsetOppositeDirection)).toBe(true);

    const spatialApply = await fetch(`${appOrigin}/api/plans/${spatialPlan.id}/apply`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    });
    expect(spatialApply.status).toBe(200);
    expect(await spatialApply.json()).toMatchObject({
      status: "applied",
      result: { regenerationErrors: [], operations: new Array(6).fill({ status: "applied", verification: "passed" }) }
    });
    const spatialState = await fetch(`${onshapeOrigin}/__state`).then((response) => response.json()) as {
      sketches: Array<{ name: string; featureType: string; parameters: Array<Record<string, any>> }>;
    };
    const spatialFeatures = spatialState.sketches.filter((feature) => feature.name.startsWith("Spatial "));
    expect(spatialFeatures).toHaveLength(6);
    expect(spatialFeatures.filter((feature) => feature.featureType === "newSketch")
      .every((feature) => feature.parameters.find((parameter) => parameter.parameterId === "sketchPlane")
        ?.queries?.[0]?.deterministicIds?.[0] === "JCC")).toBe(true);
    expect(spatialFeatures.filter((feature) => feature.featureType === "extrude")
      .every((feature) => feature.parameters.find((parameter) => parameter.parameterId === "startOffset")?.value === true
        && feature.parameters.find((parameter) => parameter.parameterId === "startOffsetDistance")?.expression === "22 mm"))
      .toBe(true);

    const assemblyContext = {
      documentId: "document",
      workspaceOrVersion: "w",
      workspaceId: "workspace",
      elementId: "assembly",
      server: onshapeOrigin
    };
    const assemblyContextQuery = new URLSearchParams(assemblyContext);
    const detectedAssembly = await fetch(`${appOrigin}/api/context?${assemblyContextQuery}`, {
      headers: sessionHeaders()
    });
    expect(detectedAssembly.status).toBe(200);
    expect(await detectedAssembly.json()).toMatchObject({ name: "Assembly 1", elementType: "ASSEMBLY" });

    const inventoryResponse = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "What is in this assembly? Run the assembly inventory.", context: assemblyContext })
    });
    expect(inventoryResponse.status).toBe(201);
    expect(await inventoryResponse.json()).toMatchObject({
      status: "applied",
      operations: [],
      agentTrace: { elementType: "ASSEMBLY", instanceCount: 1 }
    });

    await fetch(`${onshapeOrigin}/__assembly-rate-limit?enabled=true`, { method: "POST" });
    const throttledAssemblyResponse = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "What is in this assembly? Run the assembly inventory during throttling.", context: assemblyContext })
    });
    expect(throttledAssemblyResponse.status).toBe(201);
    expect(await throttledAssemblyResponse.json()).toMatchObject({
      status: "applied",
      operations: [],
      agentTrace: {
        elementType: "ASSEMBLY",
        inspectionWarnings: [expect.stringMatching(/rate-limited.*encrypted, verified snapshot/i)]
      }
    });
    await fetch(`${onshapeOrigin}/__assembly-rate-limit?enabled=false`, { method: "POST" });

    const wheelPlanResponse = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Import one wheel from FRCDesignLib. This is the insert assembly wheel fixture.", context: assemblyContext })
    });
    expect(wheelPlanResponse.status).toBe(201);
    const wheelPlan = await wheelPlanResponse.json() as {
      id: string;
      status: string;
      operations: Array<{ type: string; sourceDocumentId?: string; sourceVersionId?: string; partId?: string }>;
    };
    expect(wheelPlan).toMatchObject({
      status: "pending",
      operations: [{
        type: "insert_assembly_component",
        sourceDocumentId: "wheels",
        sourceVersionId: "wheel-version-1",
        partId: "WHEEL"
      }]
    });
    const wheelApply = await fetch(`${appOrigin}/api/plans/${wheelPlan.id}/apply`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    });
    expect(wheelApply.status).toBe(200);
    expect(await wheelApply.json()).toMatchObject({
      status: "applied",
      result: { operations: [{ status: "applied", verification: "passed" }], regenerationErrors: [] }
    });
    const assemblyState = await fetch(`${onshapeOrigin}/__state`).then((response) => response.json()) as {
      assembly: { instances: Array<{ id: string; partId: string }>; occurrences: Array<{ path: string[]; transform: number[] }> };
    };
    const insertedWheel = assemblyState.assembly.instances.find((instance) => instance.partId === "WHEEL");
    expect(insertedWheel).toBeTruthy();
    expect(assemblyState.assembly.occurrences.find((occurrence) => occurrence.path[0] === insertedWheel?.id)?.transform[3]).toBe(0.05);
  }, 20_000);

  it("rejects version contexts and unexpected Onshape stacks", async () => {
    const base = { documentId: "d", workspaceId: "w", elementId: "e" };
    const version = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Rename features", context: { ...base, workspaceOrVersion: "v" } })
    });
    expect(version.status).toBe(400);

    const wrongStack = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Rename features", context: { ...base, workspaceOrVersion: "w", server: "https://evil.example" } })
    });
    expect(wrongStack.status).toBe(400);

    const defaultConfiguration = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({
        prompt: "Change the depth dimension",
        context: { ...base, workspaceOrVersion: "w", server: onshapeOrigin, configuration: "default" }
      })
    });
    expect(defaultConfiguration.status).toBe(201);

    const unsubstitutedDefaultConfiguration = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({
        prompt: "Change the depth dimension",
        context: { ...base, workspaceOrVersion: "w", server: onshapeOrigin, configuration: "{$configuration}" }
      })
    });
    expect(unsubstitutedDefaultConfiguration.status).toBe(201);

    const configuredDimension = await fetch(`${appOrigin}/api/plans`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({
        prompt: "Change the depth dimension",
        context: { ...base, workspaceOrVersion: "w", server: onshapeOrigin, configuration: "Size=Large" }
      })
    });
    expect(configuredDimension.status).toBe(409);
  });

  it("stops stalled or over-budget planning runs, reports usage, and releases the session for a new turn", async () => {
    const context = { documentId: "d", workspaceId: "w", elementId: "e", server: onshapeOrigin };
    const headers = sessionHeaders({ origin: appOrigin, "content-type": "application/json" });
    const readJob = async (id: string) => fetch(`${appOrigin}/api/plan-jobs/${id}`, { headers }).then((r) => r.json()) as Promise<{
      status: string; usage?: { totalTokens: number; cachedInputTokens: number }; error?: string; plan?: unknown;
    }>;
    const start = async (prompt: string) => {
      const response = await fetch(`${appOrigin}/api/plan-jobs`, { method: "POST", headers, body: JSON.stringify({ prompt, context }) });
      expect(response.status).toBe(202);
      return await response.json() as { id: string; deadlineAt: number; createdAt: number };
    };
    const stop = async (id: string) => fetch(`${appOrigin}/api/plan-jobs/${id}/cancel`, {
      method: "POST", headers: sessionHeaders({ origin: appOrigin })
    });
    const finished = async (id: string, status: string) => {
      await expect.poll(async () => (await readJob(id)).status, { timeout: 7_000, interval: 100 }).toBe(status);
      return readJob(id);
    };
    const before = await fetch(`${onshapeOrigin}/__state`).then((r) => r.json());
    const manual = await start("Hold the silent planning fixture for me to stop");
    expect(manual.deadlineAt - manual.createdAt).toBe(1400);
    await expect.poll(async () => (await readJob(manual.id)).usage?.totalTokens, { timeout: 1_000, interval: 20 }).toBe(3210);
    const active = await fetch(`${appOrigin}/api/plan-jobs/latest?${new URLSearchParams(context)}`, { headers });
    expect(await active.json()).toMatchObject({ job: { id: manual.id, status: "planning" } });
    const unauthorized = await fetch(`${appOrigin}/api/plan-jobs/${manual.id}/cancel`, { method: "POST", headers: { origin: appOrigin } });
    expect(unauthorized.status).toBe(401);
    expect(await (await stop(manual.id)).json()).toMatchObject({ status: "stopping" });
    const cancelled = await finished(manual.id, "cancelled");
    expect(cancelled.error).toContain("Codex confirmed the turn ended");
    expect(cancelled.plan).toBeUndefined();

    const silent = await start("Hold the silent planning fixture until it stalls");
    expect((await finished(silent.id, "timed_out")).error).toContain("Codex sent no updates");
    const busy = await start("Hold the busy planning fixture past the request deadline");
    expect((await finished(busy.id, "timed_out")).error).toContain("reached its");
    const unresponsive = await start("Hold the unresponsive planning fixture past the stop request");
    expect((await finished(unresponsive.id, "timed_out")).error).toContain("terminated its local Codex worker");

    const budget = await start("Hold the over-budget planning fixture until stopped");
    const stopped = await finished(budget.id, "token_limit");
    expect(stopped.usage).toMatchObject({ totalTokens: 25000, cachedInputTokens: 900 });
    expect(stopped.error).toMatch(/24,000-token.*Codex confirmed/);
    expect(stopped.plan).toBeUndefined();

    const tooExpensiveToRepair = await start("Exercise self-correcting plan validation and the high-usage repair guard");
    const uncorrected = await finished(tooExpensiveToRepair.id, "failed");
    expect(uncorrected.usage?.totalTokens).toBe(21000);
    expect(uncorrected.error).toContain("after 1 attempt");

    const next = await start("What did we just change?");
    expect((await finished(next.id, "completed")).plan).toBeTruthy();
    const after = await fetch(`${onshapeOrigin}/__state`).then((r) => r.json());
    expect(after).toEqual(before);
  }, 12_000);

  it("keeps a large snapshot compact and ranks the named target into the model prompt", async () => {
    const response = await fetch(`${appOrigin}/api/plans`, {
      method: "POST", headers: sessionHeaders({ origin: appOrigin, "content-type": "application/json" }),
      body: JSON.stringify({ prompt: "Measure compact payload for Named Budget Target", context: {
        documentId: "large-budget-doc", workspaceId: "workspace", elementId: "element", server: onshapeOrigin
      } })
    });
    const plan = await response.json();
    expect(response.status, JSON.stringify(plan)).toBe(201);
    expect(plan.agentTrace.featureCount).toBeGreaterThan(250);
    const [, bytes, snippets] = plan.summary.match(/^Compact test: (\d+) bytes; (\d+) of \d+ features$/) ?? [];
    expect(Number(bytes)).toBeLessThan(14_000);
    expect(Number(snippets)).toBeLessThanOrEqual(32);
    expect(plan.operations).toHaveLength(0);
  });

  it("repairs a blank keychain proposal and verifies the exact editable text before engraving", async () => {
    const context = { documentId: "lettering-doc", workspaceId: "workspace", elementId: "element", server: onshapeOrigin };
    const headers = sessionHeaders({ origin: appOrigin, "content-type": "application/json" });
    const readState = () => fetch(`${onshapeOrigin}/__state`).then((r) => r.json());
    const before = await readState();
    const response = await fetch(`${appOrigin}/api/plans`, {
      method: "POST", headers, body: JSON.stringify({ prompt: 'CAD from scratch, a mortorq keychain. Engrave "MORTORQ".', context })
    });
    const plan = await response.json();
    expect(response.status, JSON.stringify(plan)).toBe(201);
    expect(plan).toMatchObject({ status: "pending", agentTrace: { planningAttempts: 2, runtime: { model: "gpt-6.2-sol" } } });
    expect(plan.operations).toHaveLength(6);
    expect(plan.operations[4]).toMatchObject({ type: "create_text_sketch", text: "MORTORQ", heightMm: 6 });
    expect(plan.operations[5]).toMatchObject({ type: "extrude_sketch", sourceFeatureName: "Tag lettering", operation: "REMOVE", startOffsetMm: 4 });
    expect(await readState()).toEqual(before);
    const apply = await fetch(`${appOrigin}/api/plans/${plan.id}/apply`, { method: "POST", headers: sessionHeaders({ origin: appOrigin }) });
    expect(apply.status).toBe(200);
    expect(await apply.json()).toMatchObject({ status: "applied", result: {
      operations: Array.from({ length: 6 }, () => ({ status: "applied", verification: "passed" })), regenerationErrors: []
    } });
    const after = await readState();
    const text = after.sketches.find((feature: { name: string }) => feature.name === "Tag lettering");
    expect(text.entities).toEqual([expect.objectContaining({ btType: "BTMSketchTextEntity-1761", text: "MORTORQ", ascent: 0.006 })]);
    const engraving = after.sketches.find((feature: { name: string }) => feature.name === "Engraved lettering");
    expect(engraving.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ parameterId: "entities", queries: [expect.objectContaining({ featureId: text.featureId })] }),
      expect.objectContaining({ parameterId: "operationType", value: "REMOVE" })
    ]));
  });
});
