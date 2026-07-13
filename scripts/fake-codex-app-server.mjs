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
  const marker = "Current Part Studio feature snapshot:\n";
  const markerIndex = text.indexOf(marker);
  const snapshot = markerIndex >= 0 ? JSON.parse(text.slice(markerIndex + marker.length)) : [];
  const feature = snapshot[0];
  if (!feature?.featureId || !feature?.name) throw new Error("The fake planner needs one named feature.");
  const parameter = feature.parameters?.[0];
  const userRequest = markerIndex >= 0 ? text.slice(0, markerIndex) : text;
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
            ? { account: { type: "chatgpt", email: "test@example.com", planType: "plus" }, requiresOpenaiAuth: false }
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
      case "thread/start": {
        const id = `thread-${++threadCounter}`;
        send({ id: request.id, result: { thread: { id } } });
        break;
      }
      case "turn/start": {
        const id = `turn-${++turnCounter}`;
        const plan = planFromInput(request.params);
        send({ id: request.id, result: { turn: { id, status: "inProgress", items: [], error: null } } });
        send({
          method: "turn/completed",
          params: {
            threadId: request.params.threadId,
            turn: {
              id,
              status: "completed",
              items: [{ type: "agentMessage", id: `message-${id}`, text: JSON.stringify(plan), phase: "final_answer", memoryCitation: null }],
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
