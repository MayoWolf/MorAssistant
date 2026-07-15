import { describe, expect, it } from "vitest";
import {
  ONSHAPE_CAPABILITY_CATALOG,
  assertCapabilityCatalogIntegrity,
  capabilityCategoryCounts,
  capabilityCurriculumText,
  capabilityInventoryText,
  compactFeatureSpecContext,
  selectOnshapeCapabilities
} from "./capability-catalog.js";

describe("Onshape capability curriculum", () => {
  it("covers every major Onshape modeling surface and validates unique entries", () => {
    expect(() => assertCapabilityCatalogIntegrity()).not.toThrow();
    expect(ONSHAPE_CAPABILITY_CATALOG.length).toBeGreaterThanOrEqual(140);
    const counts = capabilityCategoryCounts();
    expect(counts).toMatchObject({
      sketch_geometry: expect.any(Number),
      sketch_constraint: expect.any(Number),
      sketch_edit: expect.any(Number),
      solid_feature: expect.any(Number),
      surface_feature: expect.any(Number),
      curve_feature: expect.any(Number),
      sheet_metal: expect.any(Number),
      frame: expect.any(Number),
      assembly_mate: expect.any(Number),
      assembly_relation: expect.any(Number)
    });
    expect(counts.sketch_geometry).toBeGreaterThanOrEqual(20);
    expect(counts.solid_feature).toBeGreaterThanOrEqual(20);
    expect(ONSHAPE_CAPABILITY_CATALOG.find((capability) => capability.id === "chamfer")?.execution).toBe("typed");
  });

  it("routes natural language to detailed relevant tool lessons", () => {
    const capabilities = selectOnshapeCapabilities("Sweep a tube along a 3D spline, bevel the ends, then circular pattern it");
    expect(capabilities.map((capability) => capability.id)).toEqual(expect.arrayContaining([
      "sweep",
      "fit-spline-3d",
      "chamfer",
      "circular-pattern"
    ]));
    const curriculum = capabilityCurriculumText("Create a sheet metal flange with a hem and corner relief");
    expect(curriculum).toContain("Flange");
    expect(curriculum).toContain("Hem");
    expect(curriculum).toContain("Sheet metal corner");
  });

  it("keeps a complete compact inventory available even for shape-level prompts", () => {
    const inventory = capabilityInventoryText();
    expect(inventory).toContain("sketch_geometry: Line");
    expect(inventory).toContain("solid_feature: Extrude");
    expect(inventory).toContain("assembly_mate: Fastened mate");
    expect(inventory).toContain("sheet_metal: Sheet metal model");
  });

  it("combines the curriculum with exact live feature specs", () => {
    const selected = selectOnshapeCapabilities("Chamfer and sweep this part");
    const context = compactFeatureSpecContext({
      featureSpecs: [{ featureType: "chamfer", featureName: "Chamfer", parameters: [{ parameterId: "width" }] },
        { featureType: "sweep", featureName: "Sweep", parameters: [{ parameterId: "path" }] },
        { featureType: "customGear", featureName: "Custom gear", parameters: [{ parameterId: "teeth" }] }]
    }, selected);
    expect(context.availableFeatureTypes).toHaveLength(3);
    expect(context.relevantFeatureSpecs).toEqual(expect.arrayContaining([
      expect.objectContaining({ featureType: "chamfer" }),
      expect.objectContaining({ featureType: "sweep" })
    ]));
    expect(context.relevantFeatureSpecs).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ featureType: "customGear" })
    ]));
  });
});
