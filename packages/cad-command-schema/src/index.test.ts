import { describe, expect, it } from "vitest";
import {
  CAD_PLAN_JSON_SCHEMA,
  assemblyTransformFingerprint,
  cadPlanSchema,
  compilePlanSpatialIntent,
  normalizeCadPlanOutput,
  parseFeatureJson,
  validatePlanAgainstIntent,
  validatePlanAgainstAssembly,
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
    expect(CAD_PLAN_JSON_SCHEMA.properties.operations.items.properties.type.enum).toContain("fillet_feature_edges");
    expect(CAD_PLAN_JSON_SCHEMA.properties.operations.items.properties.type.enum).toContain("chamfer_feature_edges");
    expect(CAD_PLAN_JSON_SCHEMA.properties.operations.items.properties.type.enum).toContain("insert_assembly_component");
    expect(CAD_PLAN_JSON_SCHEMA.required).toContain("sources");
    expect(CAD_PLAN_JSON_SCHEMA.required).toContain("message");
    expect(CAD_PLAN_JSON_SCHEMA.properties.operations.minItems).toBe(0);
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
        currentFeatureHash: null,
        featureType: null,
        featureJson: null,
        reason: "Clarifies design intent"
      }],
      warnings: [],
      requiresApproval: true
    };
    expect(cadPlanSchema.parse(normalizeCadPlanOutput(wirePlan))).toEqual(plan);
  });

  it("accepts a conversational answer with no CAD mutation", () => {
    const answer = cadPlanSchema.parse({
      summary: "Answer the follow-up",
      message: "The previous turn used a 6 mm depth.",
      risk: "low",
      operations: [],
      warnings: [],
      sources: [],
      requiresApproval: true
    });
    expect(answer.operations).toEqual([]);
  });

  it("accepts only browser-safe research source URLs", () => {
    expect(cadPlanSchema.parse({
      ...plan,
      sources: [{ title: "Official rulebook", url: "https://example.com/rules.pdf" }]
    }).sources).toHaveLength(1);
    expect(cadPlanSchema.safeParse({
      ...plan,
      sources: [{ title: "Unsafe link", url: "javascript:alert(1)" }]
    }).success).toBe(false);
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

  it("accepts a bounded native feature payload with ordered feature references", () => {
    const featureJson = JSON.stringify({
      btType: "BTMFeature-134",
      featureType: "extrude",
      name: "Profile Extrude",
      parameters: [{
        btType: "BTMParameterQueryList-148",
        parameterId: "entities",
        queries: [{ btType: "BTMIndividualSketchRegionQuery-140", featureId: "@feature:Profile" }]
      }]
    });
    expect(parseFeatureJson(featureJson)).toMatchObject({ featureType: "extrude", name: "Profile Extrude" });
    const nativePlan = cadPlanSchema.parse(normalizeCadPlanOutput({
      summary: "Extrude the profile",
      risk: "medium",
      operations: [{
        type: "create_feature",
        featureId: null,
        currentName: null,
        newName: null,
        featureName: "Profile Extrude",
        parameterId: null,
        currentExpression: null,
        newExpression: null,
        sketchName: null,
        plane: null,
        widthMm: null,
        heightMm: null,
        centerXmm: null,
        centerYmm: null,
        currentFeatureHash: null,
        featureType: "extrude",
        featureJson,
        reason: "Create the requested solid"
      }],
      warnings: [],
      requiresApproval: true
    }));
    expect(validatePlanAgainstFeatureTree(nativePlan, [{ featureId: "s1", name: "Profile" }])).toBe(nativePlan);
    expect(() => validatePlanAgainstFeatureTree(nativePlan, [])).toThrow("unavailable feature Profile");
    const embeddedReferencePlan = {
      ...nativePlan,
      operations: [{
        ...nativePlan.operations[0],
        featureJson: JSON.stringify({
          btType: "BTMFeature-134",
          featureType: "chamfer",
          name: "Invalid chamfer",
          parameters: [{
            btType: "BTMParameterQueryList-148",
            parameterId: "entities",
            queries: [{ queryString: 'query=qCreatedBy(id + "@feature:Profile", EntityType.EDGE);' }]
          }]
        }),
        featureName: "Invalid chamfer",
        featureType: "chamfer"
      }]
    } as typeof nativePlan;
    expect(() => validatePlanAgainstFeatureTree(embeddedReferencePlan, [{ featureId: "s1", name: "Profile" }]))
      .toThrow("must be the complete JSON string value");
  });

  it("validates a typed cylinder and fillet recipe in dependency order", () => {
    const typedPlan = cadPlanSchema.parse(normalizeCadPlanOutput({
      summary: "Create and round a cylinder",
      risk: "medium",
      operations: [{
        type: "create_circle_sketch",
        sketchName: "Cylinder profile",
        plane: "Top",
        radiusMm: 12,
        centerXmm: 40,
        centerYmm: 0,
        reason: "Create the circular profile"
      }, {
        type: "extrude_sketch",
        featureName: "Cylinder body",
        sourceFeatureName: "Cylinder profile",
        depthMm: 30,
        operation: "NEW",
        oppositeDirection: false,
        symmetric: false,
        startOffsetMm: 0,
        startOffsetOppositeDirection: false,
        reason: "Create the solid cylinder"
      }, {
        type: "fillet_feature_edges",
        featureName: "Rounded cylinder",
        targetFeatureName: "Cylinder body",
        radiusMm: 2,
        tangentPropagation: true,
        reason: "Round the edges created by the extrude"
      }],
      warnings: [],
      requiresApproval: true
    }));
    expect(validatePlanAgainstFeatureTree(typedPlan, [])).toBe(typedPlan);
    expect(cadPlanSchema.safeParse({ ...typedPlan, risk: "low" }).success).toBe(false);
    expect(() => validatePlanAgainstFeatureTree({
      ...typedPlan,
      operations: typedPlan.operations.slice(1)
    }, [])).toThrow("Extrude source Cylinder profile is unavailable");
  });

  it("normalizes and validates a typed cylinder chamfer recipe", () => {
    const chamferPlan = cadPlanSchema.parse(normalizeCadPlanOutput({
      summary: "Bevel a cylinder",
      risk: "medium",
      operations: [{
        type: "chamfer_feature_edges",
        featureName: "Cylinder bevels",
        targetFeatureName: "Cylinder body",
        distanceMm: 1,
        tangentPropagation: false,
        reason: "Break the end edges"
      }],
      warnings: [],
      requiresApproval: true
    }));
    expect(validatePlanAgainstFeatureTree(chamferPlan, [{ featureId: "e1", name: "Cylinder body" }])).toBe(chamferPlan);
    expect(cadPlanSchema.safeParse({ ...chamferPlan, risk: "low" }).success).toBe(false);
  });

  it("rejects vertical or axle-roller toy-car wheels and accepts four offset Y-axis wheels", () => {
    const wheelSketches = [-35, 35].map((centerXmm, index) => ({
      type: "create_circle_sketch" as const,
      sketchName: index === 0 ? "Rear Wheel Profile" : "Front Wheel Profile",
      plane: "Front" as const,
      radiusMm: 12,
      centerXmm,
      centerYmm: 12,
      reason: "Create a wheel profile normal to the Y axle direction"
    }));
    const wheelExtrudes = wheelSketches.flatMap((sketch) => [false, true].map((oppositeDirection) => ({
      type: "extrude_sketch" as const,
      featureName: `${sketch.sketchName} ${oppositeDirection ? "Left" : "Right"}`,
      sourceFeatureName: sketch.sketchName,
      depthMm: 6,
      operation: "NEW" as const,
      oppositeDirection,
      symmetric: false,
      startOffsetMm: 22,
      startOffsetOppositeDirection: oppositeDirection,
      reason: "Create one separate wheel outside the chassis side"
    })));
    const vehiclePlan = cadPlanSchema.parse({
      summary: "Create four properly oriented toy-car wheels",
      risk: "medium",
      operations: [...wheelSketches, ...wheelExtrudes],
      warnings: [],
      requiresApproval: true
    });
    expect(validatePlanAgainstIntent("Make a toy car", vehiclePlan)).toBe(vehiclePlan);
    expect(() => validatePlanAgainstIntent("Make a toy car", {
      ...vehiclePlan,
      operations: vehiclePlan.operations.map((operation) => operation.type === "create_circle_sketch"
        ? { ...operation, plane: "Top" as const }
        : operation)
    })).toThrow("Top-plane circles create vertical wheels");
    expect(() => validatePlanAgainstIntent("Make a toy car", {
      ...vehiclePlan,
      operations: vehiclePlan.operations.map((operation) => operation.type === "extrude_sketch"
        ? { ...operation, startOffsetMm: 0 }
        : operation)
    })).toThrow("positive start offsets");

    const oneSided = {
      ...vehiclePlan,
      operations: vehiclePlan.operations.map((operation) => operation.type === "extrude_sketch"
        ? {
            ...operation,
            oppositeDirection: false,
            startOffsetOppositeDirection: false,
            startOffsetMm: 1
          }
        : operation)
    } as typeof vehiclePlan;
    const translatedPlan = cadPlanSchema.parse({
      ...vehiclePlan,
      operations: [{
        type: "create_rectangle_sketch",
        sketchName: "Translated Chassis Sketch",
        plane: "Top",
        widthMm: 90,
        heightMm: 45,
        centerXmm: 0,
        centerYmm: 250,
        reason: "Create the translated vehicle chassis"
      }, ...oneSided.operations]
    });
    const translatedCompiled = compilePlanSpatialIntent("Make a toy car", translatedPlan);
    expect(validatePlanAgainstIntent("Make a toy car", translatedCompiled)).toBe(translatedCompiled);
    expect(translatedCompiled.warnings).toContain("MorAssistant deterministically paired the vehicle wheel extrudes around the chassis center and outside both lateral sides.");
    const translatedExtrudes = translatedCompiled.operations.filter((operation) => operation.type === "extrude_sketch");
    expect(translatedExtrudes.map((operation) => [
      operation.startOffsetMm,
      operation.startOffsetOppositeDirection,
      operation.oppositeDirection
    ])).toEqual([
      [273, true, true],
      [227, true, false],
      [273, true, true],
      [227, true, false]
    ]);
  });

  it("requires high risk for deletion and an exact hash for whole-feature replacement", () => {
    const deletion = {
      summary: "Delete obsolete feature",
      risk: "high",
      operations: [{ type: "delete_feature", featureId: "f1", currentName: "Old feature", reason: "Explicitly requested" }],
      warnings: [],
      requiresApproval: true
    } as const;
    expect(cadPlanSchema.safeParse({ ...deletion, risk: "medium" }).success).toBe(false);
    expect(validatePlanAgainstFeatureTree(cadPlanSchema.parse(deletion), [{ featureId: "f1", name: "Old feature" }]))
      .toMatchObject({ risk: "high" });

    const hash = "a".repeat(64);
    const replacement = cadPlanSchema.parse({
      summary: "Suppress a feature",
      risk: "medium",
      operations: [{
        type: "replace_feature",
        featureId: "f1",
        currentName: "Feature 1",
        currentFeatureHash: hash,
        featureType: "extrude",
        featureJson: JSON.stringify({
          btType: "BTMFeature-134",
          featureId: "f1",
          featureType: "extrude",
          name: "Feature 1",
          parameters: []
        }),
        reason: "Update the complete native definition"
      }],
      warnings: [],
      requiresApproval: true
    });
    expect(validatePlanAgainstFeatureTree(replacement, [{ featureId: "f1", name: "Feature 1", featureHash: hash }]))
      .toBe(replacement);
    expect(() => validatePlanAgainstFeatureTree(replacement, [{ featureId: "f1", name: "Feature 1", featureHash: "b".repeat(64) }]))
      .toThrow("changed after the plan");
  });

  it("validates trusted FRCDesignLib insertion and guarded Assembly placement", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const source = {
      documentId: "frc-wheels",
      elementId: "compliant-wheels",
      versionId: "v1",
      microversionId: "m1",
      partId: "JHD",
      configuration: "",
      isAssembly: false,
      isWholePartStudio: false
    };
    const insertion = cadPlanSchema.parse({
      summary: "Insert one compliant wheel",
      risk: "medium",
      operations: [{
        type: "insert_assembly_component",
        componentName: "4 inch compliant wheel",
        sourceDocumentId: source.documentId,
        sourceElementId: source.elementId,
        sourceVersionId: source.versionId,
        sourceMicroversionId: source.microversionId,
        partId: source.partId,
        configuration: source.configuration,
        isAssembly: false,
        isWholePartStudio: false,
        transform: identity,
        reason: "Import the exact catalog part"
      }],
      warnings: [],
      requiresApproval: true
    });
    const snapshot = {
      instances: [{ id: "shaft-1", name: "Hex Shaft <1>", suppressed: false }],
      occurrences: [{ path: ["shaft-1"], transform: identity }],
      trustedSources: [source]
    };
    expect(validatePlanAgainstAssembly(insertion, snapshot)).toBe(insertion);
    expect(() => validatePlanAgainstAssembly(insertion, { ...snapshot, trustedSources: [] }))
      .toThrow("not present in the inspected assembly or trusted FRCDesignLib results");

    const placement = cadPlanSchema.parse({
      summary: "Move the shaft",
      risk: "medium",
      operations: [{
        type: "transform_assembly_instance",
        instanceId: "shaft-1",
        instanceName: "Hex Shaft <1>",
        occurrencePath: ["shaft-1"],
        currentTransformHash: assemblyTransformFingerprint(identity),
        transform: [1, 0, 0, 0.1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        reason: "Place it at the approved location"
      }],
      warnings: [],
      requiresApproval: true
    });
    expect(validatePlanAgainstAssembly(placement, snapshot)).toBe(placement);
    expect(() => validatePlanAgainstAssembly(placement, {
      ...snapshot,
      occurrences: [{ path: ["shaft-1"], transform: [1, 0, 0, 0.01, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1] }]
    })).toThrow("moved after the plan");
    expect(() => validatePlanAgainstAssembly(plan, snapshot)).toThrow("can only run in a Part Studio");
  });
});
