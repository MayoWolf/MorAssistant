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
let sketchCounter = 0;
let rateLimitFeatureReads = false;
const sketches = [];
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
    return json(response, 200, { feature, sketches, microversion });
  }
  if (request.method === "POST" && url.pathname === "/__feature-rate-limit") {
    rateLimitFeatureReads = url.searchParams.get("enabled") !== "false";
    return json(response, 200, { enabled: rateLimitFeatureReads });
  }
  if (!request.headers.authorization?.startsWith("Bearer mock-")) {
    return json(response, 401, { message: "missing mock bearer token" });
  }
  if (request.method === "GET" && /\/api\/v13\/partstudios\/d\/[^/]+\/w\/[^/]+\/e\/[^/]+\/features$/.test(url.pathname)) {
    if (rateLimitFeatureReads) {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "3600",
        "x-rate-limit-remaining": "0"
      });
      return response.end(JSON.stringify({ message: "mock feature-list rate limit" }));
    }
    return json(response, 200, {
      btType: "BTFeatureListResponse-2457",
      serializationVersion: "1.2.4",
      sourceMicroversion: `m${microversion}`,
      features: [feature, ...sketches],
      featureStates: Object.fromEntries([feature, ...sketches].map((item) => [item.featureId, item.name === "Broken Base"
        ? { featureStatus: "ERROR", message: "Deterministic regeneration fixture failure" }
        : { featureStatus: "OK" }
      ]))
    });
  }
  if (request.method === "GET" && /\/api\/v13\/partstudios\/d\/[^/]+\/w\/[^/]+\/e\/[^/]+\/bodydetails$/.test(url.pathname)) {
    return json(response, 200, {
      bodies: [{
        id: "part-1",
        bodyType: "solid",
        faces: new Array(6).fill(null).map((_, index) => ({ id: `face-${index + 1}` })),
        edges: new Array(12).fill(null).map((_, index) => ({ id: `edge-${index + 1}` })),
        vertices: new Array(8).fill(null).map((_, index) => ({ id: `vertex-${index + 1}` }))
      }]
    });
  }
  if (request.method === "GET" && /\/api\/v13\/partstudios\/d\/[^/]+\/w\/[^/]+\/e\/[^/]+\/massproperties$/.test(url.pathname)) {
    const aggregate = { mass: [0.01], volume: [0.000001], centroid: [0, 0, 0], hasMass: true };
    return json(response, 200, { microversionId: `m${microversion}`, bodies: { "-all-": aggregate, "part-1": aggregate } });
  }
  if (request.method === "POST" && /\/api\/v13\/partstudios\/d\/[^/]+\/w\/[^/]+\/e\/[^/]+\/featurescript$/.test(url.pathname)) {
    return json(response, 200, {
      result: { solidBodyCount: 1, faceCount: 6, edgeCount: 12, vertexCount: 8 }
    });
  }
  if (request.method === "POST" && /\/api\/v13\/partstudios\/d\/[^/]+\/w\/[^/]+\/e\/[^/]+\/features\/featureid\/f1$/.test(url.pathname)) {
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
      featureState: feature.name === "Broken Base"
        ? { featureStatus: "ERROR", message: "Deterministic regeneration fixture failure", inactive: false }
        : { featureStatus: "OK", inactive: false },
      serializationVersion: "1.2.4",
      sourceMicroversion: `m${microversion}`,
      microversionSkew: false
    });
  }
  if (request.method === "POST" && /\/api\/v13\/partstudios\/d\/[^/]+\/w\/[^/]+\/e\/[^/]+\/features$/.test(url.pathname)) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.sourceMicroversion !== `m${microversion}` || body.rejectMicroversionSkew !== true) {
      return json(response, 409, { message: "missing or stale microversion guard" });
    }
    const isSketch = body.feature?.btType === "BTMSketch-151" && body.feature?.featureType === "newSketch";
    const isNativeFeature = body.feature?.btType === "BTMFeature-134" && typeof body.feature?.featureType === "string";
    if (!isSketch && !isNativeFeature) {
      return json(response, 400, { message: "invalid native feature fixture" });
    }
    if (body.feature?.featureType === "extrude") {
      const parameters = new Map((body.feature.parameters ?? []).map((parameter) => [parameter.parameterId, parameter]));
      const region = parameters.get("entities")?.queries?.[0];
      const canonicalExtrude = body.feature.suppressed === false
        && body.feature.returnAfterSubfeatures === false
        && parameters.get("bodyType")?.enumName === "ExtendedToolBodyType"
        && parameters.get("operationType")?.enumName === "NewBodyOperationType"
        && parameters.get("endBound")?.enumName === "BoundingType"
        && parameters.get("oppositeDirection")?.value === false
        && parameters.get("symmetric")?.value === false
        && region?.btType === "BTMIndividualSketchRegionQuery-140"
        && region?.deterministicIds?.[0] === "JOC"
        && typeof region?.queryString === "string";
      if (!canonicalExtrude) return json(response, 400, { message: "non-canonical extrude fixture" });
    }
    const sketch = { ...structuredClone(body.feature), featureId: `feature-${++sketchCounter}` };
    sketches.push(sketch);
    microversion += 1;
    return json(response, 200, {
      feature: sketch,
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
    INSTALLATION_TOKEN: process.env.MOR_MOCK_INSTALLATION_TOKEN,
    ONSHAPE_CLIENT_ID: "mock-client",
    ONSHAPE_CLIENT_SECRET: "mock-secret",
    ONSHAPE_REDIRECT_URI: `${appOrigin}/oauth/onshape/callback`,
    ONSHAPE_AUTHORIZATION_URL: `${onshapeOrigin}/oauth/authorize`,
    ONSHAPE_TOKEN_URL: `${onshapeOrigin}/oauth/token`,
    ONSHAPE_BASE_URL: onshapeOrigin,
    ONSHAPE_API_VERSION: "v13",
    ONSHAPE_SNAPSHOT_FRESH_MS: "0",
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
