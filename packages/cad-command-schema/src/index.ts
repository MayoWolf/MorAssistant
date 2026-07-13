import { z } from "zod";
import type { PartStudioContext } from "@morassistant/shared-types";

const safeId = z.string().min(1).max(200);

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

export const cadOperationSchema = z.discriminatedUnion("type", [
  renameFeatureOperationSchema,
  updateDimensionOperationSchema,
  createRectangleSketchOperationSchema
]);

export const cadPlanSchema = z.object({
  summary: z.string().min(1).max(500),
  risk: z.enum(["low", "medium", "high"]),
  operations: z.array(cadOperationSchema).min(1).max(25),
  warnings: z.array(z.string().max(500)).max(10),
  requiresApproval: z.literal(true)
}).strict().superRefine((plan, context) => {
  const targets = new Set<string>();
  for (const [index, operation] of plan.operations.entries()) {
    const target = operation.type === "rename_feature"
      ? `rename:${operation.featureId}`
      : operation.type === "update_dimension"
        ? `dimension:${operation.featureId}:${operation.parameterId}`
        : `new-sketch:${operation.sketchName.toLocaleLowerCase()}`;
    if (targets.has(target)) {
      context.addIssue({ code: "custom", path: ["operations", index], message: "A plan cannot modify the same target twice." });
    }
    targets.add(target);
    if (operation.type === "rename_feature" && operation.currentName === operation.newName) {
      context.addIssue({ code: "custom", path: ["operations", index, "newName"], message: "The new name must be different." });
    }
    if (operation.type === "update_dimension" && operation.currentExpression === operation.newExpression) {
      context.addIssue({ code: "custom", path: ["operations", index, "newExpression"], message: "The new expression must be different." });
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
  result?: PlanExecutionResult;
}

export interface OperationExecutionResult {
  index: number;
  operation: CadOperation;
  status: "applied" | "failed";
  message: string;
}

export interface PlanExecutionResult {
  status: "applied" | "failed";
  operations: OperationExecutionResult[];
  regenerationErrors: RegenerationError[];
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
          "centerXmm",
          "centerYmm",
          "reason"
        ],
        properties: {
          type: { type: "string", enum: ["rename_feature", "update_dimension", "create_rectangle_sketch"] },
          featureId: {
            type: ["string", "null"],
            description: "Existing feature ID for rename_feature or update_dimension; null for create_rectangle_sketch."
          },
          currentName: {
            type: ["string", "null"],
            description: "Current feature name for rename_feature; null for other operation types."
          },
          newName: {
            type: ["string", "null"],
            maxLength: 100,
            description: "New feature name for rename_feature; null for other operation types."
          },
          featureName: {
            type: ["string", "null"],
            description: "Current feature name for update_dimension; null for other operation types."
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
            description: "Unique new sketch name for create_rectangle_sketch; null for other operation types."
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
      return operation;
    })
  };
}

export function validatePlanAgainstFeatureTree(
  plan: CadPlan,
  features: Array<{ featureId: string; name?: string; parameters?: Array<Record<string, unknown>> }>
): CadPlan {
  const byId = new Map(features.map((feature) => [feature.featureId, feature]));
  const names = new Set(features.flatMap((feature) => feature.name ? [feature.name.toLocaleLowerCase()] : []));

  for (const operation of plan.operations) {
    if (operation.type === "create_rectangle_sketch") {
      if (names.has(operation.sketchName.toLocaleLowerCase())) {
        throw new Error(`A feature named ${operation.sketchName} already exists.`);
      }
      names.add(operation.sketchName.toLocaleLowerCase());
      continue;
    }

    const feature = byId.get(operation.featureId);
    if (!feature) throw new Error(`Feature ${operation.featureId} no longer exists.`);

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
