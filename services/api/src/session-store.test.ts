import { readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredCadPlan } from "@morassistant/cad-command-schema";
import { SessionStore } from "./session-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "morassistant-sessions-"));
  temporaryDirectories.push(directory);
  return join(directory, "sessions.sqlite");
}

function pendingPlan(status: StoredCadPlan["status"] = "pending"): StoredCadPlan {
  return {
    id: "019f5a6b-357c-7b7e-98e9-df31016b2144",
    summary: "Rename one feature",
    risk: "low",
    operations: [{
      type: "rename_feature",
      featureId: "feature-1",
      currentName: "Extrude 1",
      newName: "Base Extrusion",
      reason: "Clarify intent"
    }],
    warnings: [],
    requiresApproval: true,
    context: { documentId: "doc", workspaceId: "workspace", elementId: "element" },
    prompt: "Rename the base feature",
    status,
    createdAt: "2026-07-12T00:00:00.000Z"
  };
}

describe("encrypted persistent session store", () => {
  it("survives a restart without writing tokens or plan text in plaintext", async () => {
    const path = await databasePath();
    const secret = "test-encryption-key-that-is-at-least-32-characters";
    const first = new SessionStore(path, secret);
    const session = first.create("session-1");
    session.onshapeTokens = {
      accessToken: "sensitive-access-token",
      refreshToken: "sensitive-refresh-token",
      expiresAt: 123456789,
      tokenType: "Bearer"
    };
    session.codexConnected = true;
    const plan = pendingPlan();
    session.plans.set(plan.id, plan);
    first.save(session);
    first.close();

    const databaseBytes = readFileSync(path).toString("utf8");
    expect(databaseBytes).not.toContain("sensitive-access-token");
    expect(databaseBytes).not.toContain("Rename one feature");

    const second = new SessionStore(path, secret);
    const restored = second.get("session-1");
    expect(restored?.onshapeTokens?.refreshToken).toBe("sensitive-refresh-token");
    expect(restored?.codexConnected).toBe(true);
    expect(restored?.plans.get(plan.id)).toMatchObject({ summary: "Rename one feature", status: "pending" });
    second.close();
  });

  it("fails an interrupted apply closed so it cannot be replayed after a restart", async () => {
    const path = await databasePath();
    const secret = "another-test-encryption-key-at-least-32-characters";
    const first = new SessionStore(path, secret);
    const session = first.create("session-2");
    const plan = pendingPlan("applying");
    session.plans.set(plan.id, plan);
    first.save(session);
    first.close();

    const second = new SessionStore(path, secret);
    expect(second.get("session-2")?.plans.get(plan.id)).toMatchObject({
      status: "failed",
      result: { regenerationErrors: [{ status: "INTERRUPTED" }] }
    });
    second.close();
  });

  it("rejects an incorrect encryption key at startup", async () => {
    const path = await databasePath();
    const first = new SessionStore(path, "correct-test-encryption-key-at-least-32-characters");
    first.close();
    expect(() => new SessionStore(path, "incorrect-test-encryption-key-at-least-32-characters"))
      .toThrow(/encryption|authenticate|bad decrypt/i);
  });
});
