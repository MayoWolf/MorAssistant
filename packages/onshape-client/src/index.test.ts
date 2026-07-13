import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOnshapeAuthorizationUrl, exchangeOnshapeCode, OnshapeClient } from "./index.js";

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
});
