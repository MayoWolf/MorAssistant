import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOnshapeAuthorizationUrl,
  buildFeatureDependencyGraph,
  buildChamferFeature,
  buildCircleSketchFeature,
  buildExtrudeFeature,
  buildFilletFeature,
  buildRectangleSketchFeature,
  exchangeOnshapeCode,
  featureFingerprint,
  OnshapeClient
} from "./index.js";

afterEach(() => vi.unstubAllGlobals());

describe("Onshape OAuth", () => {
  it("builds an authorization URL with state", () => {
    const url = new URL(buildOnshapeAuthorizationUrl({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://example.test/callback"
    }, "state-value", "company-id"));
    expect(url.searchParams.get("client_id")).toBe("client");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("company_id")).toBe("company-id");
  });

  it("rejects malformed token responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: "3600"
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(exchangeOnshapeCode({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://example.test/callback"
    }, "code")).rejects.toThrow("token exchange failed");
  });
});

describe("Onshape feature edits", () => {
  it("honors a short Retry-After response and retries a throttled endpoint", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "slow down" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0", "x-rate-limit-remaining": "0" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OnshapeClient({ accessToken: () => "token" });
    await expect(client.listFeatures({ documentId: "d", workspaceId: "w", elementId: "e" }))
      .resolves.toMatchObject({ features: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports Onshape's wait time when the rate-limit window is too long for an inline retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "slow down" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "450", "x-rate-limit-remaining": "0" }
    })));
    const client = new OnshapeClient({ accessToken: () => "token" });
    await expect(client.listFeatures({ documentId: "d", workspaceId: "w", elementId: "e" }))
      .rejects.toThrow("retry in 450 seconds");
  });

  it("surfaces a bounded Onshape validation message for rejected native payloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: "Missing enumName for operationType\nwith control detail"
    }), {
      status: 400,
      headers: { "content-type": "application/json" }
    })));
    const client = new OnshapeClient({ accessToken: () => "token" });
    await expect(client.listFeatures({ documentId: "d", workspaceId: "w", elementId: "e" }))
      .rejects.toThrow("Onshape API request failed (400). Missing enumName for operationType with control detail");
  });

  it("builds explicit upstream and downstream feature dependencies", () => {
    const graph = buildFeatureDependencyGraph({
      features: [{
        featureId: "sketch-1",
        featureType: "newSketch",
        name: "Base profile",
        parameters: []
      }, {
        featureId: "extrude-1",
        featureType: "extrude",
        name: "Base extrusion",
        parameters: [{
          parameterId: "entities",
          queries: [{ featureId: "sketch-1" }]
        }]
      }],
      featureStates: {
        "sketch-1": { featureStatus: "OK" },
        "extrude-1": { featureStatus: "WARNING" }
      }
    });
    expect(graph[0]).toMatchObject({ featureId: "sketch-1", dependsOn: [], usedBy: ["extrude-1"], status: "OK" });
    expect(graph[1]).toMatchObject({ featureId: "extrude-1", dependsOn: ["sketch-1"], usedBy: [], status: "WARNING" });
  });

  it("combines feature, topology, FeatureScript, and mass-property inspection", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        libraryVersion: 3000,
        features: [{ featureId: "f1", featureType: "extrude", name: "Base", parameters: [] }],
        featureStates: { f1: { featureStatus: "OK" } }
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        bodies: [{ faces: new Array(6).fill({}), edges: new Array(12).fill({}), vertices: new Array(8).fill({}) }]
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        bodies: {
          "-all-": { volume: [0.000001], mass: [0.01], centroid: [0.1, 0.2, 0.3] },
          p1: { volume: [0.000001] }
        }
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: { solidBodyCount: 1, faceCount: 6, edgeCount: 12, vertexCount: 8 }
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OnshapeClient({ accessToken: () => "token" });
    const inspection = await client.inspectPartStudio({ documentId: "d", workspaceId: "w", elementId: "e" });
    expect(inspection.warnings).toEqual([]);
    expect(inspection.geometry).toEqual({
      bodyCount: 1,
      solidBodyCount: 1,
      faceCount: 6,
      edgeCount: 12,
      vertexCount: 8,
      partCount: 1,
      volumeM3: 0.000001,
      massKg: 0.01,
      centroidM: [0.1, 0.2, 0.3]
    });
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain("/featurescript?rollbackBarIndex=-1");
    expect(JSON.parse(String((fetchMock.mock.calls[3]?.[1] as RequestInit).body))).toMatchObject({ libraryVersion: 3000 });
  });

  it("reads the active Part Studio configuration", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ features: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OnshapeClient({ accessToken: () => "token" });
    await client.listFeatures({
      documentId: "d",
      workspaceId: "w",
      elementId: "e",
      configuration: "Length=0.1 meter"
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("configuration=Length%3D0.1+meter");
  });

  it("reads the live feature specification catalog for the active Part Studio", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      featureSpecs: [{ featureType: "sweep", featureName: "Sweep" }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OnshapeClient({ accessToken: () => "token" });
    await expect(client.getFeatureSpecs({
      documentId: "d",
      workspaceId: "w",
      elementId: "e",
      configuration: "Size=Large"
    })).resolves.toMatchObject({ featureSpecs: [{ featureType: "sweep" }] });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/featurespecs?rollbackBarIndex=-1&configuration=Size%3DLarge");
  });

  it("preserves the full feature payload when renaming", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        serializationVersion: "1.2.4",
        sourceMicroversion: "m1",
        features: [{
        btType: "BTMFeature-134",
        featureId: "f1",
        featureType: "extrude",
        name: "Extrude 1",
        namespace: "",
        parameters: []
        }]
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OnshapeClient({ accessToken: () => "token" });
    await client.applyOperation({ documentId: "d", workspaceId: "w", elementId: "e" }, {
      type: "rename_feature",
      featureId: "f1",
      currentName: "Extrude 1",
      newName: "Base extrusion",
      reason: "Clearer"
    });

    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.feature).toMatchObject({ featureId: "f1", featureType: "extrude", name: "Base extrusion", namespace: "" });
    expect(body).toMatchObject({ serializationVersion: "1.2.4", sourceMicroversion: "m1", rejectMicroversionSkew: true });
  });

  it("builds a closed rectangle sketch in Onshape's meter-based feature format", () => {
    const feature = buildRectangleSketchFeature({
      name: "20 mm square",
      plane: "Top",
      widthMm: 20,
      heightMm: 20,
      centerXmm: 30,
      centerYmm: -10
    }) as {
      name: string;
      featureType: string;
      entities: Array<{ geometry: { pntX: number; pntY: number }; startParam: number; endParam: number; nodeId: string }>;
      constraints: unknown[];
      parameters: Array<{ parameterId: string; queries?: Array<{ deterministicIds: string[] }> }>;
    };
    expect(feature).toMatchObject({ name: "20 mm square", featureType: "newSketch" });
    expect(feature.entities).toHaveLength(4);
    expect(feature.entities[0]).toMatchObject({ geometry: { pntX: 0.03, pntY: -0.02 }, startParam: -0.01, endParam: 0.01 });
    expect(feature.constraints).toHaveLength(8);
    expect(feature.parameters[0]).toMatchObject({ parameterId: "sketchPlane", queries: [{ deterministicIds: ["JDC"] }] });
    expect(feature.entities.every((entity) => !/[-_]/u.test(entity.nodeId))).toBe(true);
  });

  it("builds native circle, blind extrude, fillet, and chamfer payloads", () => {
    const circle = buildCircleSketchFeature({
      name: "Cylinder profile",
      plane: "Front",
      radiusMm: 12,
      centerXmm: 40,
      centerYmm: -5
    }) as Record<string, unknown> & { entities: Array<Record<string, unknown>>; parameters: Array<Record<string, unknown>> };
    expect(circle).toMatchObject({ btType: "BTMSketch-151", name: "Cylinder profile", featureType: "newSketch" });
    expect(circle.entities[0]).toMatchObject({
      btType: "BTMSketchCurve-4",
      geometry: { btType: "BTCurveGeometryCircle-115", radius: 0.012, xCenter: 0.04, yCenter: -0.005 }
    });

    const extrude = buildExtrudeFeature({
      name: "Cylinder body",
      sketchFeatureId: "sketch1",
      depthMm: 30,
      operation: "NEW",
      oppositeDirection: false,
      symmetric: false,
      startOffsetMm: 20,
      startOffsetOppositeDirection: false
    }) as Record<string, unknown> & { parameters: Array<Record<string, unknown>> };
    expect(extrude).toMatchObject({ btType: "BTMFeature-134", name: "Cylinder body", featureType: "extrude" });
    expect(extrude.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ parameterId: "operationType", enumName: "NewBodyOperationType", value: "NEW" }),
      expect.objectContaining({ parameterId: "depth", expression: "30 mm" }),
      expect.objectContaining({ parameterId: "startOffset", value: true }),
      expect.objectContaining({ parameterId: "startOffsetDistance", expression: "20 mm" }),
      expect.objectContaining({ parameterId: "defaultScope", value: false })
    ]));
    expect(JSON.stringify(extrude)).toContain('qSketchRegion(id + \\"sketch1\\", true)');

    const fillet = buildFilletFeature({
      name: "Rounded cylinder",
      edgeTransientIds: ["JLB", "JLF"],
      radiusMm: 2,
      tangentPropagation: true
    }) as Record<string, unknown> & { parameters: Array<Record<string, unknown>> };
    expect(fillet).toMatchObject({ btType: "BTMFeature-134", name: "Rounded cylinder", featureType: "fillet" });
    expect(fillet.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ parameterId: "filletType", enumName: "FilletType", value: "EDGE" }),
      expect.objectContaining({ parameterId: "radius", expression: "2 mm" }),
      expect.objectContaining({ parameterId: "tangentPropagation", value: true })
    ]));
    expect(JSON.stringify(fillet)).toContain('qTransient(\\"JLB\\")');

    const chamfer = buildChamferFeature({
      name: "Beveled cylinder",
      edgeTransientIds: ["JLB", "JLF"],
      distanceMm: 1,
      tangentPropagation: false
    }) as Record<string, unknown> & { parameters: Array<Record<string, unknown>> };
    expect(chamfer).toMatchObject({ btType: "BTMFeature-134", name: "Beveled cylinder", featureType: "chamfer" });
    expect(chamfer.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ parameterId: "chamferMethod", enumName: "ChamferMethod", value: "FACE_OFFSET" }),
      expect.objectContaining({ parameterId: "chamferType", enumName: "ChamferType", value: "EQUAL_OFFSETS" }),
      expect.objectContaining({ parameterId: "width", expression: "1 mm" }),
      expect.objectContaining({ parameterId: "tangentPropagation", value: false })
    ]));
    expect(JSON.stringify(chamfer)).toContain('qTransient(\\"JLF\\")');
  });

  it("executes typed circle, extrude, fillet, and chamfer operations with guarded mutations", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ feature: { featureId: "sketch1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ feature: { featureId: "extrude1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: {
          btType: "com.belmonttech.serialize.fsvalue.BTFSValueArray",
          value: [
            { btType: "com.belmonttech.serialize.fsvalue.BTFSValueString", value: "JLB" },
            { btType: "com.belmonttech.serialize.fsvalue.BTFSValueString", value: "JLF" }
          ]
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ feature: { featureId: "fillet1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: {
          btType: "com.belmonttech.serialize.fsvalue.BTFSValueArray",
          value: [
            { btType: "com.belmonttech.serialize.fsvalue.BTFSValueString", value: "JLB" },
            { btType: "com.belmonttech.serialize.fsvalue.BTFSValueString", value: "JLF" }
          ]
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ feature: { featureId: "chamfer1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OnshapeClient({ accessToken: () => "token" });
    const context = { documentId: "d", workspaceId: "w", elementId: "e" };
    const concurrency = { serializationVersion: "1.2.30", sourceMicroversion: "m1" };

    await client.applyOperationDetailed(context, {
      type: "create_circle_sketch",
      sketchName: "Cylinder profile",
      plane: "Top",
      radiusMm: 12,
      centerXmm: 0,
      centerYmm: 0,
      reason: "Profile"
    }, { ...concurrency, features: [] });
    await client.applyOperationDetailed(context, {
      type: "extrude_sketch",
      featureName: "Cylinder body",
      sourceFeatureName: "Cylinder profile",
      depthMm: 30,
      operation: "NEW",
      oppositeDirection: false,
      symmetric: false,
      startOffsetMm: 0,
      startOffsetOppositeDirection: false,
      reason: "Solid"
    }, { ...concurrency, features: [{ featureId: "sketch1", name: "Cylinder profile", featureType: "newSketch" }] });
    await client.applyOperationDetailed(context, {
      type: "fillet_feature_edges",
      featureName: "Rounded cylinder",
      targetFeatureName: "Cylinder body",
      radiusMm: 2,
      tangentPropagation: true,
      reason: "Round"
    }, { ...concurrency, features: [{ featureId: "extrude1", name: "Cylinder body", featureType: "extrude" }] });
    await client.applyOperationDetailed(context, {
      type: "chamfer_feature_edges",
      featureName: "Beveled cylinder",
      targetFeatureName: "Cylinder body",
      distanceMm: 1,
      tangentPropagation: false,
      reason: "Bevel"
    }, { ...concurrency, features: [{ featureId: "extrude1", name: "Cylinder body", featureType: "extrude" }] });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const call of [fetchMock.mock.calls[0], fetchMock.mock.calls[1], fetchMock.mock.calls[3], fetchMock.mock.calls[5]]) {
      if (!call) throw new Error("Expected mutation request");
      const body = JSON.parse(String((call[1] as RequestInit).body));
      expect(body).toMatchObject({ serializationVersion: "1.2.30", sourceMicroversion: "m1", rejectMicroversionSkew: true });
    }
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/featurescript?rollbackBarIndex=-1");
    expect(String(fetchMock.mock.calls[4]?.[0])).toContain("/featurescript?rollbackBarIndex=-1");
  });

  it("creates a rectangle sketch with a microversion guard", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        serializationVersion: "1.2.20",
        sourceMicroversion: "m7",
        features: []
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ feature: { featureId: "new1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OnshapeClient({ accessToken: () => "token" });
    const message = await client.applyOperation({ documentId: "d", workspaceId: "w", elementId: "e" }, {
      type: "create_rectangle_sketch",
      sketchName: "Square 1",
      plane: "Top",
      widthMm: 10,
      heightMm: 10,
      centerXmm: 0,
      centerYmm: 0,
      reason: "Requested profile"
    });

    expect(message).toContain("Created Square 1");
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/features$/u);
    const body = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      btType: "BTFeatureDefinitionCall-1406",
      serializationVersion: "1.2.20",
      sourceMicroversion: "m7",
      rejectMicroversionSkew: true,
      feature: { btType: "BTMSketch-151", name: "Square 1", featureType: "newSketch" }
    });
  });

  it("creates arbitrary native features and resolves feature-name references", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        serializationVersion: "1.2.20",
        sourceMicroversion: "m8",
        features: [{ featureId: "sketch-1", name: "Profile", featureType: "newSketch", parameters: [] }]
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ feature: { featureId: "extrude-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OnshapeClient({ accessToken: () => "token" });
    await client.applyOperation({ documentId: "d", workspaceId: "w", elementId: "e" }, {
      type: "create_feature",
      featureName: "Profile Extrude",
      featureType: "extrude",
      featureJson: JSON.stringify({
        btType: "BTMFeature-134",
        featureType: "extrude",
        name: "Profile Extrude",
        parameters: [
          {
            btType: "BTMParameterEnum-145",
            parameterId: "bodyType",
            enumName: "ToolBodyType",
            value: "SOLID"
          },
          {
            btType: "BTMParameterEnum-145",
            parameterId: "operationType",
            value: "NEW"
          },
          {
            btType: "BTMParameterQueryList-148",
            parameterId: "entities",
            queries: [{ btType: "BTMIndividualSketchRegionQuery-140", featureId: "@feature:Profile" }]
          },
          {
            btType: "BTMParameterEnum-145",
            parameterId: "endBound",
            value: "BLIND"
          },
          {
            btType: "BTMParameterQuantity-147",
            parameterId: "depth",
            expression: "12 mm"
          }
        ]
      }),
      reason: "Create a solid"
    });
    const body = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(body.feature.parameters.find((parameter: { parameterId: string }) => parameter.parameterId === "entities").queries[0].featureId)
      .toBe("sketch-1");
    expect(body.feature.parameters.find((parameter: { parameterId: string }) => parameter.parameterId === "bodyType").enumName)
      .toBe("ExtendedToolBodyType");
    expect(body.feature).toMatchObject({
      namespace: "",
      suppressed: false,
      returnAfterSubfeatures: false,
      subFeatures: [],
      parameterLibraries: [],
      suppressionState: null
    });
    const byId = new Map(body.feature.parameters.map((parameter: { parameterId: string }) => [parameter.parameterId, parameter]));
    expect(byId.get("operationType")).toMatchObject({ enumName: "NewBodyOperationType", libraryRelationType: "DEFAULT" });
    expect(byId.get("endBound")).toMatchObject({ enumName: "BoundingType", libraryRelationType: "DEFAULT" });
    expect(byId.get("depth")).toMatchObject({ isInteger: false, value: 0, units: "", libraryRelationType: "DEFAULT" });
    expect(byId.get("oppositeDirection")).toMatchObject({ btType: "BTMParameterBoolean-144", value: false });
    expect(byId.get("symmetric")).toMatchObject({ btType: "BTMParameterBoolean-144", value: false });
    expect((byId.get("entities") as { queries: Array<Record<string, unknown>> }).queries[0]).toMatchObject({
      featureId: "sketch-1",
      deterministicIds: ["JOC"],
      filterInnerLoops: false,
      queryString: 'query = qSketchRegion(id + "Fsketch-1", false);'
    });
  });

  it("guards whole-feature replacement with a fingerprint", async () => {
    const original = {
      btType: "BTMFeature-134",
      featureId: "f1",
      featureType: "extrude",
      name: "Extrude 1",
      suppressed: false,
      parameters: []
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        serializationVersion: "1.2.20",
        sourceMicroversion: "m9",
        features: [original]
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ feature: { featureId: "f1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OnshapeClient({ accessToken: () => "token" });
    await client.applyOperation({ documentId: "d", workspaceId: "w", elementId: "e" }, {
      type: "replace_feature",
      featureId: "f1",
      currentName: "Extrude 1",
      currentFeatureHash: featureFingerprint(original),
      featureType: "extrude",
      featureJson: JSON.stringify({ ...original, suppressed: true }),
      reason: "Suppress the feature"
    });
    const body = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(body.feature).toMatchObject({ featureId: "f1", suppressed: true });
  });

  it("deletes only the exact previewed feature", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        features: [{ featureId: "f1", featureType: "fillet", name: "Fillet 1", parameters: [] }]
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OnshapeClient({ accessToken: () => "token" });
    await client.applyOperation({ documentId: "d", workspaceId: "w", elementId: "e" }, {
      type: "delete_feature",
      featureId: "f1",
      currentName: "Fillet 1",
      reason: "Explicitly requested"
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/features\/featureid\/f1$/u);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe("DELETE");
  });

  it("inspects Assembly instances, mates, sources, and absolute occurrence transforms", async () => {
    const client = new OnshapeClient({ accessToken: () => "token" });
    const transform = [1, 0, 0, 0.1, 0, 1, 0, 0.2, 0, 0, 1, 0.3, 0, 0, 0, 1];
    const inspection = await client.inspectAssembly(
      { documentId: "d", workspaceId: "w", elementId: "assembly" },
      {
        rootAssembly: {
          documentMicroversion: "assembly-m1",
          instances: [{
            id: "shaft-1",
            name: "1/2 in Hex Shaft <1>",
            type: "Part",
            suppressed: false,
            documentId: "frc-shafts",
            elementId: "hex-shafts",
            documentMicroversion: "shaft-m1",
            partId: "JHD",
            fullConfiguration: "Length=0.3 meter"
          }],
          occurrences: [{ path: ["shaft-1"], transform, fixed: false }],
          features: [{
            id: "mate-1",
            featureType: "mate",
            suppressed: false,
            featureData: {
              name: "Hex shaft revolute",
              mateType: "REVOLUTE",
              matedEntities: [{ matedOccurrence: ["shaft-1"] }]
            }
          }]
        }
      }
    );
    expect(inspection).toMatchObject({
      elementType: "ASSEMBLY",
      documentMicroversion: "assembly-m1",
      instances: [{ id: "shaft-1", partId: "JHD", configuration: "Length=0.3 meter" }],
      occurrences: [{ path: ["shaft-1"], transform }],
      features: [{ id: "mate-1", name: "Hex shaft revolute", mateType: "REVOLUTE" }]
    });
    expect(inspection.occurrences[0]?.transformHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(inspection.trustedSources[0]).toMatchObject({ documentId: "frc-shafts", elementId: "hex-shafts", partId: "JHD" });
  });

  it("searches the FRCDesignApp catalog and resolves exact versioned wheel part IDs", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://frc.test/api/library/")) {
        return new Response(JSON.stringify({
          documents: {
            wheels: { id: "wheels", name: "Wheels", path: { instanceId: "version-1", instanceType: "v" } }
          },
          elements: {
            compliant: {
              id: "compliant",
              documentId: "wheels",
              name: "Compliant Wheel (AM)",
              microversionId: "element-m1",
              elementType: "PARTSTUDIO",
              vendors: ["AndyMark"]
            }
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify([{
        name: "4 in Compliant Wheel (35A, 1 in Wide, 1/2 in Hex Bore)",
        partId: "JHD",
        microversionId: "part-m1"
      }]), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OnshapeClient({ accessToken: () => "token", frcDesignBaseUrl: "https://frc.test" });
    await expect(client.searchFrcDesignLibrary("import a compliant wheel", 4)).resolves.toEqual([
      expect.objectContaining({
        source: "FRCDesignLib",
        documentId: "wheels",
        elementId: "compliant",
        versionId: "version-1",
        microversionId: "part-m1",
        partId: "JHD",
        name: "4 in Compliant Wheel (35A, 1 in Wide, 1/2 in Hex Bore)"
      })
    ]);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/parts/d/wheels/v/version-1/e/compliant");
  });

  it("inserts a versioned component and places its new occurrence with an absolute transform", async () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        rootAssembly: {
          documentMicroversion: "m2",
          instances: [{ id: "wheel-1", name: "Compliant Wheel <1>", type: "Part", documentId: "wheels", elementId: "compliant", documentVersion: "v1", partId: "JHD" }],
          occurrences: [{ path: ["wheel-1"], transform: identity }],
          features: []
        }
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OnshapeClient({ accessToken: () => "token" });
    const context = { documentId: "target", workspaceId: "workspace", elementId: "assembly" };
    const before = await client.inspectAssembly(context, { rootAssembly: { documentMicroversion: "m1", instances: [], occurrences: [], features: [] } });
    const result = await client.applyAssemblyOperationDetailed(context, {
      type: "insert_assembly_component",
      componentName: "Compliant Wheel",
      sourceDocumentId: "wheels",
      sourceElementId: "compliant",
      sourceVersionId: "v1",
      sourceMicroversionId: "part-m1",
      partId: "JHD",
      configuration: "",
      isAssembly: false,
      isWholePartStudio: false,
      transform: identity,
      reason: "Place the requested wheel"
    }, before);
    expect(result.message).toContain("Inserted and placed Compliant Wheel");
    const insertBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(insertBody).toMatchObject({ documentId: "wheels", elementId: "compliant", versionId: "v1", partId: "JHD" });
    const transformBody = JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body));
    expect(transformBody.transformDefinitions[0]).toEqual({ isRelative: false, occurrences: [{ path: ["wheel-1"] }], transform: identity });
  });
});
