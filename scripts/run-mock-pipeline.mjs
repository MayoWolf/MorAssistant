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
let rateLimitAssemblyReads = false;
const sketches = [];
let assemblyMicroversion = 1;
let assemblyCounter = 0;
const identityTransform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
let assemblyInstances = [{
  id: "shaft-1",
  name: "1/2 in Hex Shaft <1>",
  type: "Part",
  suppressed: false,
  documentId: "frc-shafts",
  elementId: "hex-shafts",
  documentMicroversion: "shaft-m1",
  partId: "SHAFT",
  fullConfiguration: "Length=0.3 meter"
}];
let assemblyOccurrences = [{ path: ["shaft-1"], transform: identityTransform }];
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
    return json(response, 200, {
      feature,
      sketches,
      microversion,
      assembly: { instances: assemblyInstances, occurrences: assemblyOccurrences, microversion: assemblyMicroversion }
    });
  }
  if (request.method === "POST" && url.pathname === "/__feature-rate-limit") {
    rateLimitFeatureReads = url.searchParams.get("enabled") !== "false";
    return json(response, 200, { enabled: rateLimitFeatureReads });
  }
  if (request.method === "POST" && url.pathname === "/__assembly-rate-limit") {
    rateLimitAssemblyReads = url.searchParams.get("enabled") !== "false";
    return json(response, 200, { enabled: rateLimitAssemblyReads });
  }
  if (request.method === "GET" && url.pathname === "/api/library/frc-design-lib") {
    return json(response, 200, {
      documents: {
        wheels: { id: "wheels", name: "Wheels", path: { instanceId: "wheel-version-1", instanceType: "v" } }
      },
      elements: {
        compliant: {
          id: "compliant-wheels",
          documentId: "wheels",
          name: "Compliant Wheel (AM)",
          microversionId: "wheel-element-m1",
          elementType: "PARTSTUDIO",
          vendors: ["AndyMark"]
        }
      }
    });
  }
  if (!request.headers.authorization?.startsWith("Bearer mock-")) {
    return json(response, 401, { message: "missing mock bearer token" });
  }
  if (request.method === "GET" && /\/api\/v13\/documents\/d\/[^/]+\/w\/[^/]+\/elements$/.test(url.pathname)) {
    return json(response, 200, [
      { id: "element", name: "Part Studio 1", elementType: "PARTSTUDIO" },
      { id: "e", name: "Part Studio 1", elementType: "PARTSTUDIO" },
      { id: "assembly", name: "Assembly 1", elementType: "ASSEMBLY" }
    ]);
  }
  if (request.method === "GET" && /\/api\/v13\/parts\/d\/wheels\/v\/wheel-version-1\/e\/compliant-wheels$/.test(url.pathname)) {
    return json(response, 200, [{
      name: "4 in Compliant Wheel (35A, 1 in Wide, 1/2 in Hex Bore)",
      partId: "WHEEL",
      microversionId: "wheel-part-m1"
    }]);
  }
  if (request.method === "GET" && /\/api\/v13\/elements\/d\/[^/]+\/[vm]\/[^/]+\/e\/[^/]+\/configuration$/.test(url.pathname)) {
    return json(response, 200, {
      configurationParameters: [{
        parameterId: "Length",
        parameterName: "Length",
        defaultValue: "0.3 meter"
      }, {
        parameterId: "Durometer",
        parameterName: "Durometer",
        options: [
          { optionName: "35A", option: "_40A" },
          { optionName: "40A", option: "_50A" }
        ]
      }]
    });
  }
  if (request.method === "GET" && /\/api\/v13\/assemblies\/d\/[^/]+\/w\/[^/]+\/e\/assembly$/.test(url.pathname)) {
    if (rateLimitAssemblyReads) {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "3600",
        "x-rate-limit-remaining": "0"
      });
      return response.end(JSON.stringify({ message: "mock assembly rate limit" }));
    }
    return json(response, 200, {
      rootAssembly: {
        documentMicroversion: `assembly-m${assemblyMicroversion}`,
        instances: assemblyInstances,
        occurrences: assemblyOccurrences,
        features: [{
          id: "shaft-mate",
          featureType: "mate",
          suppressed: false,
          featureData: { name: "Hex shaft axis", mateType: "REVOLUTE", matedEntities: [{ matedOccurrence: ["shaft-1"] }] }
        }]
      }
    });
  }
  if (request.method === "POST" && /\/api\/v13\/assemblies\/d\/[^/]+\/w\/[^/]+\/e\/assembly\/instances$/.test(url.pathname)) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.documentId !== "wheels" || body.elementId !== "compliant-wheels" || body.versionId !== "wheel-version-1" || body.partId !== "WHEEL") {
      return json(response, 400, { message: "unexpected library source" });
    }
    const id = `wheel-${++assemblyCounter}`;
    assemblyInstances = [...assemblyInstances, {
      id,
      name: `4 in Compliant Wheel <${assemblyCounter}>`,
      type: "Part",
      suppressed: false,
      documentId: body.documentId,
      elementId: body.elementId,
      documentVersion: body.versionId,
      documentMicroversion: "wheel-part-m1",
      partId: body.partId,
      fullConfiguration: body.configuration ?? ""
    }];
    assemblyOccurrences = [...assemblyOccurrences, { path: [id], transform: identityTransform }];
    assemblyMicroversion += 1;
    return json(response, 200, { id });
  }
  if (request.method === "POST" && /\/api\/v13\/assemblies\/d\/[^/]+\/w\/[^/]+\/e\/assembly\/modify$/.test(url.pathname)) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    for (const definition of body.transformDefinitions ?? []) {
      for (const occurrence of definition.occurrences ?? []) {
        assemblyOccurrences = assemblyOccurrences.map((candidate) =>
          JSON.stringify(candidate.path) === JSON.stringify(occurrence.path)
            ? { ...candidate, transform: definition.transform }
            : candidate
        );
      }
    }
    const deleted = new Set(body.deleteInstances ?? []);
    assemblyInstances = assemblyInstances.filter((instance) => !deleted.has(instance.id));
    assemblyOccurrences = assemblyOccurrences.filter((occurrence) => !deleted.has(occurrence.path[0]));
    const suppressed = new Set(body.suppressInstances ?? []);
    const unsuppressed = new Set(body.unsuppressInstances ?? []);
    assemblyInstances = assemblyInstances.map((instance) => ({
      ...instance,
      suppressed: suppressed.has(instance.id) ? true : unsuppressed.has(instance.id) ? false : instance.suppressed
    }));
    assemblyMicroversion += 1;
    return json(response, 200, { ok: true });
  }
  if (request.method === "GET" && /\/api\/v13\/partstudios\/d\/[^/]+\/w\/[^/]+\/e\/[^/]+\/featurespecs$/.test(url.pathname)) {
    return json(response, 200, {
      btType: "BTFeatureSpecsResponse-2000",
      featureSpecs: [{
        btType: "BTFeatureSpec-129",
        featureType: "newSketch",
        featureName: "Sketch",
        parameters: [{ btType: "BTMParameterSpecQuery-202", parameterId: "sketchPlane", parameterName: "Sketch plane" }]
      }, {
        btType: "BTFeatureSpec-129",
        featureType: "extrude",
        featureName: "Extrude",
        parameters: [
          { btType: "BTMParameterSpecEnum-200", parameterId: "operationType", parameterName: "Operation", enumName: "NewBodyOperationType" },
          { btType: "BTMParameterSpecQuantity-201", parameterId: "depth", parameterName: "Depth" }
        ]
      }, {
        btType: "BTFeatureSpec-129",
        featureType: "chamfer",
        featureName: "Chamfer",
        parameters: [
          { btType: "BTMParameterSpecQuery-202", parameterId: "entities", parameterName: "Entities" },
          { btType: "BTMParameterSpecQuantity-201", parameterId: "width", parameterName: "Distance" }
        ]
      }, {
        btType: "BTFeatureSpec-129",
        featureType: "sweep",
        featureName: "Sweep",
        parameters: [
          { btType: "BTMParameterSpecQuery-202", parameterId: "profiles", parameterName: "Profiles" },
          { btType: "BTMParameterSpecQuery-202", parameterId: "path", parameterName: "Path" }
        ]
      }, {
        btType: "BTFeatureSpec-129",
        featureType: "loft",
        featureName: "Loft",
        parameters: [{ btType: "BTMParameterSpecQuery-202", parameterId: "profileSubqueries", parameterName: "Profiles" }]
      }]
    });
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
      libraryVersion: 3000,
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
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (String(body.script).includes("edge.transientId")) {
      return json(response, 200, {
        result: {
          btType: "com.belmonttech.serialize.fsvalue.BTFSValueArray",
          value: [
            { btType: "com.belmonttech.serialize.fsvalue.BTFSValueString", value: "JEDGE1" },
            { btType: "com.belmonttech.serialize.fsvalue.BTFSValueString", value: "JEDGE2" }
          ]
        }
      });
    }
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
        && typeof parameters.get("oppositeDirection")?.value === "boolean"
        && parameters.get("symmetric")?.value === false
        && region?.btType === "BTMIndividualSketchRegionQuery-140"
        && typeof region?.deterministicIds?.[0] === "string"
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
    FRC_DESIGN_BASE_URL: onshapeOrigin,
    ONSHAPE_SNAPSHOT_FRESH_MS: "0",
    CODEX_MODEL: "gpt-5.6-sol",
    CODEX_REASONING_EFFORT: "high",
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
