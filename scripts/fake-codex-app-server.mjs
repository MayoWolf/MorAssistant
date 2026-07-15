#!/usr/bin/env node
import { createInterface } from "node:readline";

if (process.env.ONSHAPE_CLIENT_SECRET || process.env.SESSION_SECRET || process.env.SESSION_ENCRYPTION_KEY) {
  throw new Error("The Codex worker inherited a backend secret.");
}

let connected = false;
let threadCounter = 0;
let turnCounter = 0;
const threads = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function planFromInput(params, earlierTurns = []) {
  const text = params?.input?.find((item) => item?.type === "text")?.text ?? "";
  const assemblyMarker = "Current Assembly model snapshot:\n";
  const partStudioMarker = "Current Part Studio model snapshot:\n";
  const marker = text.includes(assemblyMarker) ? assemblyMarker : partStudioMarker;
  const markerIndex = text.indexOf(marker);
  const model = markerIndex >= 0 ? JSON.parse(text.slice(markerIndex + marker.length)) : { features: [] };
  const snapshot = model.features ?? [];
  const userRequest = markerIndex >= 0 ? text.slice(0, markerIndex) : text;
  if (marker === assemblyMarker) {
    if (/what did we just|what have we done|summarize (?:our|the) conversation/i.test(userRequest)) {
      return {
        summary: "Answer the Assembly conversation follow-up",
        message: `I retained ${earlierTurns.length} earlier turn${earlierTurns.length === 1 ? "" : "s"} in this Assembly conversation.`,
        risk: "low",
        operations: [],
        warnings: [],
        requiresApproval: true
      };
    }
    if (/assembly inventory|what is in this assembly/i.test(userRequest)) {
      return {
        summary: "Describe the current assembly",
        message: `This assembly contains ${model.instances?.length ?? 0} top-level instance(s), including ${model.instances?.map((instance) => instance.name).join(", ") || "none"}.`,
        risk: "low",
        operations: [],
        warnings: [],
        requiresApproval: true
      };
    }
    if (/insert assembly wheel|import.*wheel/i.test(userRequest)) {
      const candidate = model.frcDesignLibCandidates?.find((item) => /wheel/i.test(item.name));
      if (!candidate) throw new Error("The fake Assembly planner needs an FRCDesignLib wheel candidate.");
      return {
        summary: `Import and place ${candidate.name}`,
        message: `I found the exact versioned ${candidate.name} in FRCDesignLib and prepared one absolute Assembly placement.`,
        risk: "medium",
        operations: [{
          type: "insert_assembly_component",
          componentName: candidate.name,
          sourceDocumentId: candidate.documentId,
          sourceElementId: candidate.elementId,
          sourceVersionId: candidate.versionId ?? null,
          sourceMicroversionId: candidate.microversionId ?? null,
          partId: candidate.partId ?? null,
          configuration: candidate.configuration ?? "",
          isAssembly: candidate.isAssembly ?? false,
          isWholePartStudio: candidate.isWholePartStudio ?? false,
          transform: [1, 0, 0, 0.05, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          reason: "Insert the trusted catalog part and align it to the fixture shaft axis"
        }],
        warnings: [],
        requiresApproval: true
      };
    }
    return {
      summary: "No Assembly change requested",
      message: "I inspected the current Assembly and no mutation is needed.",
      risk: "low",
      operations: [],
      warnings: [],
      requiresApproval: true
    };
  }
  if (!model.capabilityCatalog?.completeInventory?.includes("sketch_geometry:") ||
      !model.capabilityCatalog?.relevantCurriculum?.includes("requires:") ||
      !model.liveNativeFeatures?.availableFeatureTypes?.some((entry) => entry.featureType === "chamfer") ||
      !model.liveNativeFeatures?.relevantFeatureSpecs?.some((entry) => ["extrude", "newSketch"].includes(entry.featureType))) {
    throw new Error("The fake planner did not receive the complete Onshape curriculum and live feature specifications.");
  }
  if (/what did we just|what have we done|summarize (?:our|the) conversation/i.test(userRequest)) {
    return {
      summary: "Answer the conversation follow-up",
      message: `I retained ${earlierTurns.length} earlier turn${earlierTurns.length === 1 ? "" : "s"} in this Part Studio conversation.`,
      risk: "low",
      operations: [],
      warnings: [],
      requiresApproval: true
    };
  }
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
  if (/chamfer curriculum/i.test(userRequest)) {
    const target = snapshot[0];
    return {
      summary: `Chamfer edges created by ${target.name}`,
      risk: "medium",
      operations: [{
        type: "chamfer_feature_edges",
        featureName: "Base edge chamfers",
        targetFeatureName: target.name,
        distanceMm: 1,
        tangentPropagation: false,
        reason: "Exercises the typed chamfer tool learned by the capability curriculum"
      }],
      warnings: [],
      requiresApproval: true
    };
  }
  if (/toy car spatial regression/i.test(userRequest)) {
    const wheelSketches = [-35, 35].map((centerXmm, index) => ({
      type: "create_circle_sketch",
      sketchName: index === 0 ? "Spatial Rear Wheel Profile" : "Spatial Front Wheel Profile",
      plane: "Front",
      radiusMm: 12,
      centerXmm,
      centerYmm: 12,
      reason: "Orient the wheel profile normal to the Y axle direction"
    }));
    const wheelExtrudes = wheelSketches.flatMap((sketch) => [false, true].map((oppositeDirection) => ({
      type: "extrude_sketch",
      featureName: `${sketch.sketchName} ${oppositeDirection ? "Left" : "Right"}`,
      sourceFeatureName: sketch.sketchName,
      depthMm: 6,
      operation: "NEW",
      oppositeDirection,
      symmetric: false,
      startOffsetMm: 22,
      startOffsetOppositeDirection: oppositeDirection,
      reason: "Create a separate wheel outside the matching chassis side"
    })));
    return {
      summary: "Create four correctly oriented and offset toy-car wheels",
      risk: "medium",
      operations: [...wheelSketches, ...wheelExtrudes],
      warnings: ["The test uses X longitudinal, Y axle direction, and Z up."],
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
        if (request.params?.config?.web_search !== "live") {
          throw new Error("thread/start must enable live first-party web search");
        }
        const instructions = String(request.params?.baseInstructions);
        if (!instructions.includes("Wheel circles therefore belong on the Front plane") &&
            !instructions.includes("insert_assembly_component creates one new top-level instance")) {
          throw new Error("thread/start must teach the active Part Studio or Assembly coordinate model");
        }
        if (request.params?.ephemeral !== false) {
          throw new Error("thread/start must persist the conversation rollout");
        }
        const id = `thread-${++threadCounter}`;
        threads.set(id, { turns: [] });
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
      case "thread/resume": {
        const id = request.params?.threadId;
        if (!threads.has(id)) throw new Error(`Unknown saved thread ${id}`);
        if (request.params?.config?.web_search !== "live") throw new Error("thread/resume must preserve live web search");
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
        if (request.params?.summary !== "detailed") throw new Error("turn/start must request detailed reasoning summaries");
        const thread = threads.get(request.params?.threadId);
        if (!thread) throw new Error("turn/start must target a started or resumed persistent thread");
        const id = `turn-${++turnCounter}`;
        const planned = planFromInput(request.params, thread.turns);
        const plan = { ...planned, message: planned.message ?? planned.summary, sources: [] };
        const userText = request.params?.input?.find((entry) => entry?.type === "text")?.text ?? "";
        thread.turns.push(userText);
        const item = { type: "agentMessage", id: `message-${id}`, text: JSON.stringify(plan), phase: "final_answer", memoryCitation: null };
        send({ id: request.id, result: { turn: { id, status: "inProgress", items: [], error: null } } });
        send({
          method: "item/reasoning/summaryTextDelta",
          params: {
            threadId: request.params.threadId,
            turnId: id,
            itemId: `reasoning-${id}`,
            delta: "Checking the current feature tree, physical constraints, and relevant real-world dimensions.",
            summaryIndex: 0
          }
        });
        const searchItem = {
          type: "webSearch",
          id: `search-${id}`,
          query: "official engineering dimensions",
          action: { type: "search", query: "official engineering dimensions", queries: null }
        };
        send({
          method: "item/started",
          params: { threadId: request.params.threadId, turnId: id, item: searchItem, startedAtMs: Date.now() }
        });
        send({
          method: "item/completed",
          params: { threadId: request.params.threadId, turnId: id, item: searchItem, completedAtMs: Date.now() }
        });
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
