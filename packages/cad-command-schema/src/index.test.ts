import { describe, expect, it } from "vitest";
import { cadPlanSchema, validatePlanAgainstFeatureTree } from "./index.js";

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
});
