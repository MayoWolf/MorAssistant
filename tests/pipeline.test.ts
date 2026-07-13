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
      MOR_MOCK_INSTALLATION_TOKEN: installationToken
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
        "access-control-request-headers": "x-mor-installation"
      }
    });
    expect(installationPreflight.status).toBe(204);
    expect(installationPreflight.headers.get("access-control-allow-headers")).toContain("x-mor-installation");

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

    const context = {
      documentId: "document",
      workspaceOrVersion: "w",
      workspaceId: "workspace",
      elementId: "element",
      server: onshapeOrigin
    };
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
    expect(applied).toMatchObject({ status: "applied", result: { status: "applied", regenerationErrors: [] } });

    const state = await fetch(`${onshapeOrigin}/__state`).then((response) => response.json()) as { feature: { name: string }; microversion: number };
    expect(state.feature.name).toBe("Base Extrusion");
    expect(state.microversion).toBe(2);

    const replay = await fetch(`${appOrigin}/api/plans/${plan.id}/apply`, {
      method: "POST",
      headers: sessionHeaders({ origin: appOrigin })
    });
    expect(replay.status).toBe(409);

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
});
