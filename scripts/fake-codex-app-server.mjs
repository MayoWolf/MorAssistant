#!/usr/bin/env node
import { createInterface } from "node:readline";

if (process.env.ONSHAPE_CLIENT_SECRET || process.env.SESSION_SECRET || process.env.SESSION_ENCRYPTION_KEY) {
  throw new Error("The Codex worker inherited a backend secret.");
}

let connected = false;
let threadCounter = 0;
let turnCounter = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function planFromInput(params) {
  const text = params?.input?.find((item) => item?.type === "text")?.text ?? "";
  const marker = "Current Part Studio model snapshot:\n";
  const markerIndex = text.indexOf(marker);
  const model = markerIndex >= 0 ? JSON.parse(text.slice(markerIndex + marker.length)) : { features: [] };
  const snapshot = model.features ?? [];
  const userRequest = markerIndex >= 0 ? text.slice(0, markerIndex) : text;
  if (/self-correct/i.test(userRequest) && !/previous proposed plan failed trusted-host validation/i.test(userRequest)) {
    const feature = snapshot[0];
    return {
      summary: "Deliberately invalid first attempt",
      risk: "low",
      operations: [{
        type: "rename_feature",
        featureId: "invented-feature-id",
        currentName: feature?.name ?? "Unknown",
        newName: "Corrected Feature",
        reason: "Exercises trusted-host repair feedback"
      }],
      warnings: [],
      requiresApproval: true
    };
  }
  if (/Create a recovery plan for a partially executed Onshape request/i.test(userRequest)) {
    const feature = snapshot[0];
    return {
      summary: "Recover the failed base feature without repeating successful work",
      risk: "low",
      operations: [{
        type: "rename_feature",
        featureId: feature.featureId,
        currentName: feature.name,
        newName: "Recovered Base",
        reason: "Uses the refreshed model state to remove the regeneration fixture condition"
      }],
      warnings: ["This is a separately approval-gated recovery plan."],
      requiresApproval: true
    };
  }
  if (/trigger regeneration recovery/i.test(userRequest)) {
    const feature = snapshot[0];
    return {
      summary: "Trigger the deterministic regeneration recovery fixture",
      risk: "low",
      operations: [{
        type: "rename_feature",
        featureId: feature.featureId,
        currentName: feature.name,
        newName: "Broken Base",
        reason: "Exercises per-operation regeneration verification"
      }],
      warnings: [],
      requiresApproval: true
    };
  }
  if (/extrude/i.test(userRequest)) {
    const sketch = snapshot.find((item) => item?.featureType === "newSketch");
    if (!sketch?.name) throw new Error("The fake planner needs a sketch to extrude.");
    const featureName = `${sketch.name} Extrude`;
    return {
      summary: `Extrude ${sketch.name} by 15 mm as a new solid`,
      risk: "medium",
      operations: [{
        type: "create_feature",
        featureName,
        featureType: "extrude",
        featureJson: JSON.stringify({
          btType: "BTMFeature-134",
          featureType: "extrude",
          name: featureName,
          suppressed: false,
          parameters: [
            { btType: "BTMParameterEnum-145", value: "SOLID", enumName: "ExtendedToolBodyType", parameterId: "bodyType" },
            { btType: "BTMParameterEnum-145", value: "NEW", enumName: "NewBodyOperationType", parameterId: "operationType" },
            {
              btType: "BTMParameterQueryList-148",
              queries: [{ btType: "BTMIndividualSketchRegionQuery-140", featureId: `@feature:${sketch.name}` }],
              parameterId: "entities"
            },
            { btType: "BTMParameterEnum-145", value: "BLIND", enumName: "BoundingType", parameterId: "endBound" },
            { btType: "BTMParameterQuantity-147", expression: "15 mm", parameterId: "depth" }
          ],
          returnAfterSubfeatures: false
        }),
        reason: "Creates the requested solid from the sketch region"
      }],
      warnings: [],
      requiresApproval: true
    };
  }
  if (/sketch|square|rectangle/i.test(userRequest)) {
    const sizes = /five|\b5\b/i.test(userRequest) ? [10, 20, 30, 40, 50] : [20];
    const centers = [-100, -65, -20, 35, 105];
    return {
      summary: `Create ${sizes.length} square sketch${sizes.length === 1 ? "" : "es"} on the Top plane`,
      risk: "medium",
      operations: sizes.map((size, index) => ({
        type: "create_rectangle_sketch",
        sketchName: `Square ${size} mm`,
        plane: "Top",
        widthMm: size,
        heightMm: size,
        centerXmm: centers[index] ?? index * 60,
        centerYmm: 0,
        reason: "Creates a distinct, non-overlapping square profile"
      })),
      warnings: ["Deterministic 10 mm increments were chosen because the prompt did not specify dimensions."],
      requiresApproval: true
    };
  }
  const feature = snapshot[0];
  if (!feature?.featureId || !feature?.name) throw new Error("The fake planner needs one named feature.");
  const parameter = feature.parameters?.[0];
  if (/depth|dimension/i.test(userRequest) && parameter?.parameterId && parameter?.expression) {
    const newExpression = parameter.expression === "6 mm" ? "8 mm" : "6 mm";
    return {
      summary: `Change ${feature.name}.${parameter.parameterId} to ${newExpression}`,
      risk: "medium",
      operations: [{
        type: "update_dimension",
        featureId: feature.featureId,
        featureName: feature.name,
        parameterId: parameter.parameterId,
        currentExpression: parameter.expression,
        newExpression,
        reason: "Exercises a guarded quantity-expression update"
      }],
      warnings: [],
      requiresApproval: true
    };
  }
  const newName = feature.name === "Extrude 1" ? "Base Extrusion" : `${feature.name} refined`;
  return {
    summary: `Rename ${feature.name} to ${newName}`,
    risk: "low",
    operations: [{
      type: "rename_feature",
      featureId: feature.featureId,
      currentName: feature.name,
      newName,
      reason: "Makes the feature tree easier to understand"
    }],
    warnings: [],
    requiresApproval: true
  };
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method === "initialized") return;

  try {
    switch (request.method) {
      case "initialize":
        send({ id: request.id, result: { userAgent: "fake-codex/0.1", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "test" } });
        break;
      case "account/read":
        send({
          id: request.id,
          result: connected
            ? { account: { type: "chatgpt", email: "test@example.com", planType: "plus" }, requiresOpenaiAuth: true }
            : { account: null, requiresOpenaiAuth: true }
        });
        break;
      case "account/login/start": {
        const loginId = "login-test";
        send({ id: request.id, result: { type: "chatgptDeviceCode", loginId, verificationUrl: "https://auth.openai.com/device", userCode: "MOR-TEST" } });
        connected = true;
        // Deliberately emit immediately to exercise the worker's event-race handling.
        send({ method: "account/login/completed", params: { loginId, success: true, error: null } });
        break;
      }
      case "model/list":
        send({
          id: request.id,
          result: {
            data: [{
              id: "gpt-5.6-sol",
              model: "gpt-5.6-sol",
              displayName: "GPT-5.6 Sol",
              description: "Fake deterministic pipeline model",
              isDefault: true,
              hidden: false,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }))
            }],
            nextCursor: null
          }
        });
        break;
      case "thread/start": {
        if (request.params?.sandbox !== "read-only") {
          throw new Error("thread/start must use the Codex SandboxMode spelling read-only");
        }
        const id = `thread-${++threadCounter}`;
        send({
          id: request.id,
          result: {
            thread: { id },
            model: request.params?.model ?? "gpt-5.6-sol",
            modelProvider: "openai",
            reasoningEffort: null,
            serviceTier: null,
            approvalPolicy: "never",
            sandbox: { type: "readOnly", networkAccess: false },
            cwd: request.params?.cwd ?? process.cwd()
          }
        });
        break;
      }
      case "turn/start": {
        if (request.params?.sandboxPolicy?.type !== "readOnly" || request.params.sandboxPolicy.networkAccess !== false) {
          throw new Error("turn/start must use the no-network readOnly Codex sandbox policy");
        }
        if ("access" in request.params.sandboxPolicy) {
          throw new Error("turn/start must not send the removed readOnly.access field");
        }
        if (request.params?.effort !== "high") throw new Error("turn/start must pin high reasoning effort");
        const id = `turn-${++turnCounter}`;
        const plan = planFromInput(request.params);
        const item = { type: "agentMessage", id: `message-${id}`, text: JSON.stringify(plan), phase: "final_answer", memoryCitation: null };
        send({ id: request.id, result: { turn: { id, status: "inProgress", items: [], error: null } } });
        send({
          method: "item/completed",
          params: { threadId: request.params.threadId, turnId: id, item, completedAtMs: Date.now() }
        });
        send({
          method: "turn/completed",
          params: {
            threadId: request.params.threadId,
            turn: {
              id,
              status: "completed",
              items: [],
              error: null
            }
          }
        });
        break;
      }
      default:
        if (request.id !== undefined) send({ id: request.id, error: { code: -32601, message: `Unsupported fake method ${request.method}` } });
    }
  } catch (error) {
    if (request.id !== undefined) send({ id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : "Fake app-server failure" } });
  }
});
