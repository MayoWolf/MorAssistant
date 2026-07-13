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

export const cadOperationSchema = z.discriminatedUnion("type", [
  renameFeatureOperationSchema,
  updateDimensionOperationSchema
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
      : `dimension:${operation.featureId}:${operation.parameterId}`;
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
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "featureId", "currentName", "newName", "reason"],
            properties: {
              type: { const: "rename_feature" },
              featureId: { type: "string", minLength: 1 },
              currentName: { type: "string", minLength: 1 },
              newName: { type: "string", minLength: 1, maxLength: 100 },
              reason: { type: "string", minLength: 1, maxLength: 500 }
            }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "featureId", "featureName", "parameterId", "currentExpression", "newExpression", "reason"],
            properties: {
              type: { const: "update_dimension" },
              featureId: { type: "string", minLength: 1 },
              featureName: { type: "string", minLength: 1 },
              parameterId: { type: "string", minLength: 1 },
              currentExpression: { type: "string", minLength: 1 },
              newExpression: { type: "string", minLength: 1, maxLength: 100 },
              reason: { type: "string", minLength: 1, maxLength: 500 }
            }
          }
        ]
      }
    },
    warnings: { type: "array", maxItems: 10, items: { type: "string", maxLength: 500 } },
    requiresApproval: { const: true }
  }
} as const;

export function validatePlanAgainstFeatureTree(
  plan: CadPlan,
  features: Array<{ featureId: string; name?: string; parameters?: Array<Record<string, unknown>> }>
): CadPlan {
  const byId = new Map(features.map((feature) => [feature.featureId, feature]));

  for (const operation of plan.operations) {
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
