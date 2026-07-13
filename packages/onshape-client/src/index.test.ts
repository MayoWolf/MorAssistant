import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOnshapeAuthorizationUrl,
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
        parameters: [{
          btType: "BTMParameterQueryList-148",
          parameterId: "entities",
          queries: [{ btType: "BTMIndividualSketchRegionQuery-140", featureId: "@feature:Profile" }]
        }]
      }),
      reason: "Create a solid"
    });
    const body = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(body.feature.parameters[0].queries[0].featureId).toBe("sketch-1");
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
});
