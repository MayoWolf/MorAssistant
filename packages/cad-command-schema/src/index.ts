import { z } from "zod";
import type { PartStudioContext } from "@morassistant/shared-types";

const safeId = z.string().min(1).max(200);
const featureJson = z.string().min(2).max(100_000);

function inspectJsonValue(value: unknown, depth: number, counter: { nodes: number }): void {
  counter.nodes += 1;
  if (counter.nodes > 10_000) throw new Error("Feature payload is too complex.");
  if (depth > 30) throw new Error("Feature payload is nested too deeply.");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Feature payload contains a non-finite number.");
  if (typeof value === "string" && value.length > 20_000) throw new Error("Feature payload contains an oversized string.");
  if (Array.isArray(value)) {
    if (value.length > 2_000) throw new Error("Feature payload contains an oversized array.");
    for (const item of value) inspectJsonValue(item, depth + 1, counter);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 1_000) throw new Error("Feature payload contains an oversized object.");
    for (const [key, item] of entries) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Feature payload contains a forbidden key.");
      inspectJsonValue(item, depth + 1, counter);
    }
  }
}

export function parseFeatureJson(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Feature payload must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Feature payload must be a JSON object.");
  }
  inspectJsonValue(parsed, 0, { nodes: 0 });
  const feature = parsed as Record<string, unknown>;
  if (!["BTMFeature-134", "BTMSketch-151"].includes(String(feature.btType))) {
    throw new Error("Feature payload must use BTMFeature-134 or BTMSketch-151.");
  }
  if (typeof feature.featureType !== "string" || feature.featureType.length < 1 || feature.featureType.length > 200) {
    throw new Error("Feature payload must include a valid featureType.");
  }
  if (typeof feature.name !== "string" || feature.name.length < 1 || feature.name.length > 100) {
    throw new Error("Feature payload must include a valid name.");
  }
  if (!Array.isArray(feature.parameters)) throw new Error("Feature payload must include a parameters array.");
  return feature;
}

export function featureReferences(feature: unknown): string[] {
  const references = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string" && value.startsWith("@feature:")) {
      const name = value.slice("@feature:".length).trim();
      if (name) references.add(name);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(feature);
  return [...references];
}

export const renameFeatureOperationSchema = z.object({
  type: z.literal("rename_feature"),
  featureId: safeId,
  currentName: z.string().min(1).max(200),
  newName: z.string().trim().min(1).max(100),
  reason: z.string().min(1).max(500)
}).strict();

export const updateDimensionOperationSchema = z.object({
  type: z.literal("update_dimension"),
  featureId: safeId,
  featureName: z.string().min(1).max(200),
  parameterId: safeId,
  currentExpression: z.string().min(1).max(100),
  newExpression: z.string().trim().min(1).max(100),
  reason: z.string().min(1).max(500)
}).strict();

export const createRectangleSketchOperationSchema = z.object({
  type: z.literal("create_rectangle_sketch"),
  sketchName: z.string().trim().min(1).max(100),
  plane: z.literal("Top"),
  widthMm: z.number().finite().min(0.1).max(10_000),
  heightMm: z.number().finite().min(0.1).max(10_000),
  centerXmm: z.number().finite().min(-100_000).max(100_000),
  centerYmm: z.number().finite().min(-100_000).max(100_000),
  reason: z.string().min(1).max(500)
}).strict();

export const createCircleSketchOperationSchema = z.object({
  type: z.literal("create_circle_sketch"),
  sketchName: z.string().trim().min(1).max(100),
  plane: z.literal("Top"),
  radiusMm: z.number().finite().min(0.05).max(10_000),
  centerXmm: z.number().finite().min(-100_000).max(100_000),
  centerYmm: z.number().finite().min(-100_000).max(100_000),
  reason: z.string().min(1).max(500)
}).strict();

export const extrudeSketchOperationSchema = z.object({
  type: z.literal("extrude_sketch"),
  featureName: z.string().trim().min(1).max(100),
  sourceFeatureName: z.string().trim().min(1).max(100),
  depthMm: z.number().finite().min(0.05).max(100_000),
  operation: z.enum(["NEW", "ADD", "REMOVE", "INTERSECT"]),
  oppositeDirection: z.boolean(),
  symmetric: z.boolean(),
  reason: z.string().min(1).max(500)
}).strict();

export const filletFeatureEdgesOperationSchema = z.object({
  type: z.literal("fillet_feature_edges"),
  featureName: z.string().trim().min(1).max(100),
  targetFeatureName: z.string().trim().min(1).max(100),
  radiusMm: z.number().finite().min(0.01).max(10_000),
  tangentPropagation: z.boolean(),
  reason: z.string().min(1).max(500)
}).strict();

export const createFeatureOperationSchema = z.object({
  type: z.literal("create_feature"),
  featureName: z.string().trim().min(1).max(100),
  featureType: z.string().trim().min(1).max(200),
  featureJson,
  reason: z.string().min(1).max(500)
}).strict().superRefine((operation, context) => {
  try {
    const feature = parseFeatureJson(operation.featureJson);
    if (feature.name !== operation.featureName) {
      context.addIssue({ code: "custom", path: ["featureJson"], message: "Feature payload name must match featureName." });
    }
    if (feature.featureType !== operation.featureType) {
      context.addIssue({ code: "custom", path: ["featureJson"], message: "Feature payload featureType must match featureType." });
    }
    if ("featureId" in feature) {
      context.addIssue({ code: "custom", path: ["featureJson"], message: "A new feature payload cannot contain featureId." });
    }
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["featureJson"],
      message: error instanceof Error ? error.message : "Feature payload is invalid."
    });
  }
});

export const replaceFeatureOperationSchema = z.object({
  type: z.literal("replace_feature"),
  featureId: safeId,
  currentName: z.string().min(1).max(200),
  currentFeatureHash: z.string().regex(/^[a-f0-9]{64}$/u),
  featureType: z.string().trim().min(1).max(200),
  featureJson,
  reason: z.string().min(1).max(500)
}).strict().superRefine((operation, context) => {
  try {
    const feature = parseFeatureJson(operation.featureJson);
    if (feature.featureType !== operation.featureType) {
      context.addIssue({ code: "custom", path: ["featureJson"], message: "Feature payload featureType must match featureType." });
    }
    if (feature.featureId !== undefined && feature.featureId !== operation.featureId) {
      context.addIssue({ code: "custom", path: ["featureJson"], message: "Feature payload featureId must match the target feature." });
    }
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["featureJson"],
      message: error instanceof Error ? error.message : "Feature payload is invalid."
    });
  }
});

export const deleteFeatureOperationSchema = z.object({
  type: z.literal("delete_feature"),
  featureId: safeId,
  currentName: z.string().min(1).max(200),
  reason: z.string().min(1).max(500)
}).strict();

export const cadOperationSchema = z.discriminatedUnion("type", [
  renameFeatureOperationSchema,
  updateDimensionOperationSchema,
  createRectangleSketchOperationSchema,
  createCircleSketchOperationSchema,
  extrudeSketchOperationSchema,
  filletFeatureEdgesOperationSchema,
  createFeatureOperationSchema,
  replaceFeatureOperationSchema,
  deleteFeatureOperationSchema
]);

export const cadPlanSchema = z.object({
  summary: z.string().min(1).max(500),
  risk: z.enum(["low", "medium", "high"]),
  operations: z.array(cadOperationSchema).min(1).max(25),
  warnings: z.array(z.string().max(500)).max(10),
  requiresApproval: z.literal(true)
}).strict().superRefine((plan, context) => {
  const targets = new Set<string>();
  const wholeFeatureTargets = new Set<string>();
  const touchedFeatureTargets = new Set<string>();
  for (const [index, operation] of plan.operations.entries()) {
    const target = operation.type === "rename_feature"
      ? `rename:${operation.featureId}`
      : operation.type === "update_dimension"
        ? `dimension:${operation.featureId}:${operation.parameterId}`
        : operation.type === "create_rectangle_sketch" || operation.type === "create_circle_sketch"
          ? `new-feature:${operation.sketchName.toLocaleLowerCase()}`
          : operation.type === "create_feature" || operation.type === "extrude_sketch" || operation.type === "fillet_feature_edges"
            ? `new-feature:${operation.featureName.toLocaleLowerCase()}`
            : `whole-feature:${operation.featureId}`;
    if (targets.has(target)) {
      context.addIssue({ code: "custom", path: ["operations", index], message: "A plan cannot modify the same target twice." });
    }
    targets.add(target);
    if ("featureId" in operation) {
      if (wholeFeatureTargets.has(operation.featureId) ||
        (["replace_feature", "delete_feature"].includes(operation.type) && touchedFeatureTargets.has(operation.featureId))) {
        context.addIssue({ code: "custom", path: ["operations", index], message: "A plan cannot combine whole-feature and partial edits on the same feature." });
      }
      touchedFeatureTargets.add(operation.featureId);
      if (["replace_feature", "delete_feature"].includes(operation.type)) wholeFeatureTargets.add(operation.featureId);
    }
    if (operation.type === "rename_feature" && operation.currentName === operation.newName) {
      context.addIssue({ code: "custom", path: ["operations", index, "newName"], message: "The new name must be different." });
    }
    if (operation.type === "update_dimension" && operation.currentExpression === operation.newExpression) {
      context.addIssue({ code: "custom", path: ["operations", index, "newExpression"], message: "The new expression must be different." });
    }
    if (operation.type === "delete_feature" && plan.risk !== "high") {
      context.addIssue({ code: "custom", path: ["risk"], message: "Plans that delete features must be high risk." });
    }
    if (["create_feature", "replace_feature", "extrude_sketch", "fillet_feature_edges"].includes(operation.type) && plan.risk === "low") {
      context.addIssue({ code: "custom", path: ["risk"], message: "Native feature payload plans must be at least medium risk." });
    }
  }
});

export type CadOperation = z.infer<typeof cadOperationSchema>;
export type CadPlan = z.infer<typeof cadPlanSchema>;

export interface StoredCadPlan extends CadPlan {
  id: string;
  context: PartStudioContext;
  prompt: string;
  status: "pending" | "applying" | "applied" | "failed";
  createdAt: string;
  agentTrace?: {
    planningAttempts: number;
    runtime?: {
      configuredModel?: string;
      model: string;
      modelProvider?: string;
      reasoningEffort?: string;
      serviceTier?: string;
    };
    featureCount: number;
    dependencyCount: number;
    geometry: {
      bodyCount?: number;
      solidBodyCount?: number;
      faceCount?: number;
      edgeCount?: number;
      vertexCount?: number;
      partCount?: number;
      volumeM3?: number;
      massKg?: number;
      centroidM?: [number, number, number];
    };
    inspectionWarnings: string[];
  };
  sourceMicroversion?: string;
  recoveryForPlanId?: string;
  result?: PlanExecutionResult;
}

export interface OperationExecutionResult {
  index: number;
  operation: CadOperation;
  status: "applied" | "failed";
  message: string;
  verification: "passed" | "failed" | "not_run";
}

export interface PlanExecutionResult {
  status: "applied" | "failed";
  operations: OperationExecutionResult[];
  regenerationErrors: RegenerationError[];
  preexistingRegenerationErrors?: RegenerationError[];
}

export interface RegenerationError {
  featureId: string;
  featureName: string;
  status: string;
  message?: string;
}

// Kept explicit because app-server outputSchema accepts plain JSON Schema and
// strict, closed objects produce the most reliable structured plan output.
export const CAD_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "risk", "operations", "warnings", "requiresApproval"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 500 },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 25,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "featureId",
          "currentName",
          "newName",
          "featureName",
          "parameterId",
          "currentExpression",
          "newExpression",
          "sketchName",
          "plane",
          "widthMm",
          "heightMm",
          "radiusMm",
          "centerXmm",
          "centerYmm",
          "sourceFeatureName",
          "depthMm",
          "operation",
          "oppositeDirection",
          "symmetric",
          "targetFeatureName",
          "tangentPropagation",
          "currentFeatureHash",
          "featureType",
          "featureJson",
          "reason"
        ],
        properties: {
          type: {
            type: "string",
            enum: [
              "rename_feature",
              "update_dimension",
              "create_rectangle_sketch",
              "create_circle_sketch",
              "extrude_sketch",
              "fillet_feature_edges",
              "create_feature",
              "replace_feature",
              "delete_feature"
            ]
          },
          featureId: {
            type: ["string", "null"],
            description: "Existing feature ID for rename_feature, update_dimension, replace_feature, or delete_feature; null for creation operations."
          },
          currentName: {
            type: ["string", "null"],
            description: "Current feature name for rename_feature, replace_feature, or delete_feature; null for other operation types."
          },
          newName: {
            type: ["string", "null"],
            maxLength: 100,
            description: "New feature name for rename_feature; null for other operation types."
          },
          featureName: {
            type: ["string", "null"],
            description: "Current feature name for update_dimension, or new feature name for create_feature; null for other operation types."
          },
          parameterId: {
            type: ["string", "null"],
            description: "Parameter ID for update_dimension; null for other operation types."
          },
          currentExpression: {
            type: ["string", "null"],
            description: "Current expression for update_dimension; null for other operation types."
          },
          newExpression: {
            type: ["string", "null"],
            maxLength: 100,
            description: "New expression for update_dimension; null for other operation types."
          },
          sketchName: {
            type: ["string", "null"],
            maxLength: 100,
            description: "Unique new sketch name for create_rectangle_sketch or create_circle_sketch; null for other operation types."
          },
          plane: {
            type: ["string", "null"],
            enum: ["Top", null],
            description: "Top for create_rectangle_sketch; null for other operation types."
          },
          widthMm: {
            type: ["number", "null"],
            minimum: 0.1,
            maximum: 10_000,
            description: "Rectangle width in millimeters for create_rectangle_sketch; null otherwise."
          },
          heightMm: {
            type: ["number", "null"],
            minimum: 0.1,
            maximum: 10_000,
            description: "Rectangle height in millimeters for create_rectangle_sketch; null otherwise."
          },
          radiusMm: {
            type: ["number", "null"],
            minimum: 0.01,
            maximum: 10_000,
            description: "Circle radius for create_circle_sketch or edge radius for fillet_feature_edges, in millimeters; null otherwise."
          },
          centerXmm: {
            type: ["number", "null"],
            minimum: -100_000,
            maximum: 100_000,
            description: "Rectangle center X in millimeters for create_rectangle_sketch; null otherwise."
          },
          centerYmm: {
            type: ["number", "null"],
            minimum: -100_000,
            maximum: 100_000,
            description: "Rectangle center Y in millimeters for create_rectangle_sketch; null otherwise."
          },
          sourceFeatureName: {
            type: ["string", "null"],
            maxLength: 100,
            description: "Existing or earlier-created sketch name for extrude_sketch; null otherwise."
          },
          depthMm: {
            type: ["number", "null"],
            minimum: 0.05,
            maximum: 100_000,
            description: "Positive blind extrude distance in millimeters for extrude_sketch; null otherwise."
          },
          operation: {
            type: ["string", "null"],
            enum: ["NEW", "ADD", "REMOVE", "INTERSECT", null],
            description: "Solid operation for extrude_sketch; null otherwise."
          },
          oppositeDirection: {
            type: ["boolean", "null"],
            description: "Whether extrude_sketch runs opposite the sketch normal; null otherwise."
          },
          symmetric: {
            type: ["boolean", "null"],
            description: "Whether extrude_sketch is symmetric about the sketch plane; null otherwise."
          },
          targetFeatureName: {
            type: ["string", "null"],
            maxLength: 100,
            description: "Existing or earlier-created solid feature whose created edges are filleted; null otherwise."
          },
          tangentPropagation: {
            type: ["boolean", "null"],
            description: "Tangent propagation for fillet_feature_edges; null otherwise."
          },
          currentFeatureHash: {
            type: ["string", "null"],
            pattern: "^[a-f0-9]{64}$",
            description: "Exact snapshot hash for replace_feature; null for other operation types."
          },
          featureType: {
            type: ["string", "null"],
            maxLength: 200,
            description: "Onshape featureType for create_feature or replace_feature; null for other operation types."
          },
          featureJson: {
            type: ["string", "null"],
            maxLength: 100000,
            description: "Minified JSON for one BTMFeature-134 or BTMSketch-151 payload for create_feature or replace_feature; null otherwise."
          },
          reason: { type: "string", minLength: 1, maxLength: 500 }
        }
      }
    },
    warnings: { type: "array", maxItems: 10, items: { type: "string", maxLength: 500 } },
    requiresApproval: { type: "boolean", const: true }
  }
} as const;

/**
 * Structured Outputs does not support a oneOf discriminated union. The wire
 * schema therefore uses one closed object with nullable operation-specific
 * fields; this converts it back to the strict domain union before validation.
 */
export function normalizeCadPlanOutput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const plan = input as Record<string, unknown>;
  if (!Array.isArray(plan.operations)) return input;
  return {
    ...plan,
    operations: plan.operations.map((operation) => {
      if (!operation || typeof operation !== "object") return operation;
      const value = operation as Record<string, unknown>;
      if (value.type === "rename_feature") {
        return {
          type: value.type,
          featureId: value.featureId,
          currentName: value.currentName,
          newName: value.newName,
          reason: value.reason
        };
      }
      if (value.type === "update_dimension") {
        return {
          type: value.type,
          featureId: value.featureId,
          featureName: value.featureName,
          parameterId: value.parameterId,
          currentExpression: value.currentExpression,
          newExpression: value.newExpression,
          reason: value.reason
        };
      }
      if (value.type === "create_rectangle_sketch") {
        return {
          type: value.type,
          sketchName: value.sketchName,
          plane: value.plane,
          widthMm: value.widthMm,
          heightMm: value.heightMm,
          centerXmm: value.centerXmm,
          centerYmm: value.centerYmm,
          reason: value.reason
        };
      }
      if (value.type === "create_circle_sketch") {
        return {
          type: value.type,
          sketchName: value.sketchName,
          plane: value.plane,
          radiusMm: value.radiusMm,
          centerXmm: value.centerXmm,
          centerYmm: value.centerYmm,
          reason: value.reason
        };
      }
      if (value.type === "extrude_sketch") {
        return {
          type: value.type,
          featureName: value.featureName,
          sourceFeatureName: value.sourceFeatureName,
          depthMm: value.depthMm,
          operation: value.operation,
          oppositeDirection: value.oppositeDirection,
          symmetric: value.symmetric,
          reason: value.reason
        };
      }
      if (value.type === "fillet_feature_edges") {
        return {
          type: value.type,
          featureName: value.featureName,
          targetFeatureName: value.targetFeatureName,
          radiusMm: value.radiusMm,
          tangentPropagation: value.tangentPropagation,
          reason: value.reason
        };
      }
      if (value.type === "create_feature") {
        return {
          type: value.type,
          featureName: value.featureName,
          featureType: value.featureType,
          featureJson: value.featureJson,
          reason: value.reason
        };
      }
      if (value.type === "replace_feature") {
        return {
          type: value.type,
          featureId: value.featureId,
          currentName: value.currentName,
          currentFeatureHash: value.currentFeatureHash,
          featureType: value.featureType,
          featureJson: value.featureJson,
          reason: value.reason
        };
      }
      if (value.type === "delete_feature") {
        return {
          type: value.type,
          featureId: value.featureId,
          currentName: value.currentName,
          reason: value.reason
        };
      }
      return operation;
    })
  };
}

export function validatePlanAgainstFeatureTree(
  plan: CadPlan,
  features: Array<{ featureId: string; name?: string; featureHash?: string; parameters?: Array<Record<string, unknown>> }>
): CadPlan {
  const byId = new Map(features.map((feature) => [feature.featureId, feature]));
  const names = new Set(features.flatMap((feature) => feature.name ? [feature.name.toLocaleLowerCase()] : []));

  for (const operation of plan.operations) {
    if (operation.type === "create_rectangle_sketch" ||
      operation.type === "create_circle_sketch" ||
      operation.type === "extrude_sketch" ||
      operation.type === "fillet_feature_edges" ||
      operation.type === "create_feature") {
      const name = operation.type === "create_rectangle_sketch" || operation.type === "create_circle_sketch"
        ? operation.sketchName
        : operation.featureName;
      if (operation.type === "create_feature") {
        for (const reference of featureReferences(parseFeatureJson(operation.featureJson))) {
          if (!names.has(reference.toLocaleLowerCase())) {
            throw new Error(`Feature payload references unavailable feature ${reference}. Put its creation earlier in the plan.`);
          }
        }
      }
      if (operation.type === "extrude_sketch" && !names.has(operation.sourceFeatureName.toLocaleLowerCase())) {
        throw new Error(`Extrude source ${operation.sourceFeatureName} is unavailable. Put its sketch creation earlier in the plan.`);
      }
      if (operation.type === "fillet_feature_edges" && !names.has(operation.targetFeatureName.toLocaleLowerCase())) {
        throw new Error(`Fillet target ${operation.targetFeatureName} is unavailable. Put its solid feature creation earlier in the plan.`);
      }
      if (names.has(name.toLocaleLowerCase())) {
        throw new Error(`A feature named ${name} already exists.`);
      }
      names.add(name.toLocaleLowerCase());
      continue;
    }

    const feature = byId.get(operation.featureId);
    if (!feature) throw new Error(`Feature ${operation.featureId} no longer exists.`);

    if (operation.type === "replace_feature") {
      if (feature.name !== operation.currentName || feature.featureHash !== operation.currentFeatureHash) {
        throw new Error(`Feature ${operation.featureId} changed after the plan was created.`);
      }
      continue;
    }

    if (operation.type === "delete_feature") {
      if (feature.name !== operation.currentName) {
        throw new Error(`Feature ${operation.featureId} changed after the plan was created.`);
      }
      continue;
    }

    if (operation.type === "rename_feature") {
      if (feature.name !== operation.currentName) {
        throw new Error(`Feature ${operation.featureId} changed after the plan was created.`);
      }
      continue;
    }

    const parameter = feature.parameters?.find((candidate) => candidate.parameterId === operation.parameterId);
    if (feature.name !== operation.featureName) {
      throw new Error(`Feature ${operation.featureId} changed after the plan was created.`);
    }
    if (!parameter) throw new Error(`Parameter ${operation.parameterId} no longer exists on ${operation.featureId}.`);
    if (parameter.expression !== operation.currentExpression) {
      throw new Error(`Parameter ${operation.parameterId} changed after the plan was created.`);
    }
  }

  return plan;
}
