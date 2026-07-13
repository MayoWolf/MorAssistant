import { describe, expect, it } from "vitest";
import {
  CAD_PLAN_JSON_SCHEMA,
  cadPlanSchema,
  normalizeCadPlanOutput,
  validatePlanAgainstFeatureTree
} from "./index.js";

const plan = cadPlanSchema.parse({
  summary: "Rename the base sketch",
  risk: "low",
  operations: [{
    type: "rename_feature",
    featureId: "f1",
    currentName: "Sketch 1",
    newName: "Base profile",
    reason: "Clarifies design intent"
  }],
  warnings: [],
  requiresApproval: true
});

describe("CAD plan validation", () => {
  it("accepts an unchanged feature tree", () => {
    expect(validatePlanAgainstFeatureTree(plan, [{ featureId: "f1", name: "Sketch 1" }])).toBe(plan);
  });

  it("rejects a stale rename", () => {
    expect(() => validatePlanAgainstFeatureTree(plan, [{ featureId: "f1", name: "Already changed" }]))
      .toThrow("changed after the plan was created");
  });

  it("rejects no-op and duplicate targets", () => {
    const rename = plan.operations[0];
    if (!rename || rename.type !== "rename_feature") throw new Error("Test fixture must be a rename operation.");
    const duplicate = {
      ...plan,
      operations: [rename, rename]
    };
    expect(cadPlanSchema.safeParse(duplicate).success).toBe(false);
    expect(cadPlanSchema.safeParse({
      ...plan,
      operations: [{ ...rename, newName: rename.currentName }]
    }).success).toBe(false);
  });

  it("normalizes the Structured Outputs wire shape without unsupported unions", () => {
    expect(JSON.stringify(CAD_PLAN_JSON_SCHEMA)).not.toContain("oneOf");
    expect(CAD_PLAN_JSON_SCHEMA.properties.requiresApproval).toEqual({ type: "boolean", const: true });
    expect(CAD_PLAN_JSON_SCHEMA.properties.operations.items.properties.type.enum).toContain("create_rectangle_sketch");
    const wirePlan = {
      summary: "Rename the base sketch",
      risk: "low",
      operations: [{
        type: "rename_feature",
        featureId: "f1",
        currentName: "Sketch 1",
        newName: "Base profile",
        featureName: null,
        parameterId: null,
        currentExpression: null,
        newExpression: null,
        sketchName: null,
        plane: null,
        widthMm: null,
        heightMm: null,
        centerXmm: null,
        centerYmm: null,
        reason: "Clarifies design intent"
      }],
      warnings: [],
      requiresApproval: true
    };
    expect(cadPlanSchema.parse(normalizeCadPlanOutput(wirePlan))).toEqual(plan);
  });

  it("normalizes and validates rectangle sketch creation", () => {
    const wirePlan = {
      summary: "Create two square sketches",
      risk: "medium",
      operations: [10, 20].map((size, index) => ({
        type: "create_rectangle_sketch",
        featureId: null,
        currentName: null,
        newName: null,
        featureName: null,
        parameterId: null,
        currentExpression: null,
        newExpression: null,
        sketchName: `Square ${index + 1}`,
        plane: "Top",
        widthMm: size,
        heightMm: size,
        centerXmm: index * 30,
        centerYmm: 0,
        reason: "Create distinct square profiles"
      })),
      warnings: ["Sizes were selected because none were specified."],
      requiresApproval: true
    };
    const parsed = cadPlanSchema.parse(normalizeCadPlanOutput(wirePlan));
    expect(parsed.operations).toHaveLength(2);
    expect(validatePlanAgainstFeatureTree(parsed, [])).toBe(parsed);
    expect(() => validatePlanAgainstFeatureTree(parsed, [{ featureId: "f2", name: "Square 1" }]))
      .toThrow("already exists");
  });
});
