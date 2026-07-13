#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const appPort = Number(process.env.MOR_MOCK_APP_PORT ?? 33107);
const onshapePort = Number(process.env.MOR_MOCK_ONSHAPE_PORT ?? 33108);
const appOrigin = `http://127.0.0.1:${appPort}`;
const onshapeOrigin = `http://127.0.0.1:${onshapePort}`;
const root = resolve(import.meta.dirname, "..");
const codexHome = await mkdtemp(`${tmpdir()}/morassistant-e2e-`);

let microversion = 1;
let feature = {
  btType: "BTMFeature-134",
  featureId: "f1",
  featureType: "extrude",
  name: "Extrude 1",
  namespace: "",
  suppressed: false,
  parameters: [{
    btType: "BTMParameterQuantity-147",
    parameterId: "depth",
    expression: "4 mm",
    isInteger: false
  }]
};

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const onshape = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", onshapeOrigin);
  if (request.method === "GET" && url.pathname === "/oauth/authorize") {
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (!redirectUri || !state) return json(response, 400, { error: "missing OAuth parameters" });
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", "mock-authorization-code");
    callback.searchParams.set("state", state);
    response.writeHead(302, { location: callback.toString() });
    return response.end();
  }
  if (request.method === "POST" && url.pathname === "/oauth/token") {
    return json(response, 200, {
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      expires_in: 3600,
      token_type: "Bearer"
    });
  }
  if (request.method === "GET" && url.pathname === "/__state") {
    return json(response, 200, { feature, microversion });
  }
  if (!request.headers.authorization?.startsWith("Bearer mock-")) {
    return json(response, 401, { message: "missing mock bearer token" });
  }
  if (request.method === "GET" && /\/api\/v15\/partstudios\/d\/[^/]+\/w\/[^/]+\/e\/[^/]+\/features$/.test(url.pathname)) {
    return json(response, 200, {
      btType: "BTFeatureListResponse-2457",
      serializationVersion: "1.2.4",
      sourceMicroversion: `m${microversion}`,
      features: [feature],
      featureStates: { f1: { featureStatus: "OK" } }
    });
  }
  if (request.method === "POST" && /\/api\/v15\/partstudios\/d\/[^/]+\/w\/[^/]+\/e\/[^/]+\/features\/featureid\/f1$/.test(url.pathname)) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.sourceMicroversion !== `m${microversion}` || body.rejectMicroversionSkew !== true) {
      return json(response, 409, { message: "missing or stale microversion guard" });
    }
    feature = structuredClone(body.feature);
    microversion += 1;
    return json(response, 200, {
      feature,
      featureState: { featureStatus: "OK", inactive: false },
      serializationVersion: "1.2.4",
      sourceMicroversion: `m${microversion}`,
      microversionSkew: false
    });
  }
  return json(response, 404, { message: `No mock route for ${request.method} ${url.pathname}` });
});

await new Promise((resolvePromise, reject) => {
  onshape.once("error", reject);
  onshape.listen(onshapePort, "127.0.0.1", resolvePromise);
});

const api = spawn(process.execPath, [resolve(root, "services/api/dist/server.js")], {
  // Match `npm run start -w @morassistant/api`, which starts in the workspace.
  cwd: resolve(root, "services/api"),
  env: {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(appPort),
    APP_ORIGIN: appOrigin,
    SESSION_SECRET: "mock-session-secret-with-at-least-thirty-two-characters",
    ONSHAPE_CLIENT_ID: "mock-client",
    ONSHAPE_CLIENT_SECRET: "mock-secret",
    ONSHAPE_REDIRECT_URI: `${appOrigin}/oauth/onshape/callback`,
    ONSHAPE_AUTHORIZATION_URL: `${onshapeOrigin}/oauth/authorize`,
    ONSHAPE_TOKEN_URL: `${onshapeOrigin}/oauth/token`,
    ONSHAPE_BASE_URL: onshapeOrigin,
    ONSHAPE_API_VERSION: "v15",
    CODEX_COMMAND: resolve(root, "scripts/fake-codex-app-server.mjs"),
    CODEX_USERS_ROOT: codexHome
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let ready = false;
api.stdout.on("data", (chunk) => {
  const output = String(chunk);
  if (process.env.MOR_MOCK_VERBOSE === "1") process.stderr.write(output);
  if (!ready && output.includes("Server listening")) {
    ready = true;
    process.stdout.write(`MOCK_PIPELINE_READY ${appOrigin} ${onshapeOrigin}\n`);
  }
});
api.stderr.on("data", (chunk) => process.stderr.write(chunk));
api.once("exit", (code) => {
  if (!shuttingDown) {
    process.stderr.write(`Mock API exited unexpectedly with code ${code}.\n`);
    void shutdown(code ?? 1);
  }
});

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  api.kill("SIGTERM");
  await new Promise((resolvePromise) => onshape.close(resolvePromise));
  await rm(codexHome, { recursive: true, force: true });
  process.exitCode = code;
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
