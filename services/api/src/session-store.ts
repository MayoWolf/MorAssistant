import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { StoredCadPlan } from "@morassistant/cad-command-schema";
import type { OnshapeTokens } from "@morassistant/onshape-client";

export interface UserSession {
  id: string;
  lastTouchedAt: number;
  onshapeTokens?: OnshapeTokens;
  onshapeRefresh?: Promise<OnshapeTokens>;
  onshapeState?: string;
  onshapeRedirectUri?: string;
  codexLoginId?: string;
  codexConnected?: boolean;
  plans: Map<string, StoredCadPlan>;
}

const onshapeTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite(),
  tokenType: z.string().min(1)
}).strict();

const persistedPlanSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["pending", "applying", "applied", "failed"]),
  prompt: z.string(),
  createdAt: z.string(),
  context: z.record(z.string(), z.unknown()),
  operations: z.array(z.unknown()),
  warnings: z.array(z.unknown())
}).passthrough();

const persistedSessionSchema = z.object({
  onshapeTokens: onshapeTokensSchema.optional(),
  onshapeState: z.string().optional(),
  onshapeRedirectUri: z.string().optional(),
  codexConnected: z.boolean().optional(),
  plans: z.array(persistedPlanSchema)
}).strict();

interface SessionRow {
  payload: string;
  updated_at: number;
}

interface ExpiredSessionRow {
  id: string;
}

function interruptedPlan(plan: StoredCadPlan): StoredCadPlan {
  if (plan.status !== "applying") return plan;
  return {
    ...plan,
    status: "failed",
    result: {
      status: "failed",
      operations: [],
      regenerationErrors: [{
        featureId: "unknown",
        featureName: "Interrupted apply",
        status: "INTERRUPTED",
        message: "The backend restarted while this plan was applying. Create a fresh plan before making another change."
      }]
    }
  };
}

/**
 * Durable session storage with authenticated encryption for every row payload.
 * SQLite supplies atomic commits; AES-256-GCM keeps OAuth tokens and CAD plans
 * unreadable if the volume or a database backup is exposed without the key.
 */
export class SessionStore {
  private readonly database: Database.Database;
  private readonly encryptionKey: Buffer;

  constructor(databasePath: string, encryptionSecret: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new Database(databasePath);
    this.encryptionKey = createHash("sha256").update(encryptionSecret, "utf8").digest();
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("secure_delete = ON");
    if (databasePath !== ":memory:") this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT
    `);
    const keyCheck = this.database.prepare("SELECT value FROM metadata WHERE key = 'encryption_key_check'").get() as { value: string } | undefined;
    if (!keyCheck) {
      this.database.prepare("INSERT INTO metadata (key, value) VALUES ('encryption_key_check', ?)")
        .run(this.encrypt("__key_check__", "morassistant-session-store-v1"));
    } else {
      try {
        if (this.decrypt("__key_check__", keyCheck.value) !== "morassistant-session-store-v1") {
          throw new Error("Unexpected key-check value.");
        }
      } catch {
        this.database.close();
        throw new Error("The session database encryption key is incorrect.");
      }
    }
  }

  create(id: string): UserSession {
    const session: UserSession = { id, lastTouchedAt: Date.now(), plans: new Map() };
    this.save(session);
    return session;
  }

  get(id: string): UserSession | undefined {
    const row = this.database.prepare("SELECT payload, updated_at FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) return undefined;
    const persisted = persistedSessionSchema.parse(JSON.parse(this.decrypt(id, row.payload)));
    const hadInterruptedApply = persisted.plans.some((plan) => plan.status === "applying");
    const plans = persisted.plans.map((plan) => interruptedPlan(plan as unknown as StoredCadPlan));
    const session: UserSession = {
      id,
      lastTouchedAt: row.updated_at,
      plans: new Map(plans.map((plan) => [plan.id, plan])),
      ...(persisted.onshapeTokens ? { onshapeTokens: persisted.onshapeTokens } : {}),
      ...(persisted.onshapeState ? { onshapeState: persisted.onshapeState } : {}),
      ...(persisted.onshapeRedirectUri ? { onshapeRedirectUri: persisted.onshapeRedirectUri } : {}),
      ...(persisted.codexConnected ? { codexConnected: true } : {})
    };
    if (hadInterruptedApply) this.save(session);
    return session;
  }

  save(session: UserSession): void {
    const payload = JSON.stringify({
      ...(session.onshapeTokens ? { onshapeTokens: session.onshapeTokens } : {}),
      ...(session.onshapeState ? { onshapeState: session.onshapeState } : {}),
      ...(session.onshapeRedirectUri ? { onshapeRedirectUri: session.onshapeRedirectUri } : {}),
      ...(session.codexConnected ? { codexConnected: true } : {}),
      plans: [...session.plans.values()]
    });
    const now = Date.now();
    this.database.prepare(`
      INSERT INTO sessions (id, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `).run(session.id, this.encrypt(session.id, payload), now, now);
    session.lastTouchedAt = now;
  }

  pruneExpired(updatedBefore: number): string[] {
    const expired = this.database.prepare("SELECT id FROM sessions WHERE updated_at < ?").all(updatedBefore) as ExpiredSessionRow[];
    if (expired.length > 0) this.database.prepare("DELETE FROM sessions WHERE updated_at < ?").run(updatedBefore);
    return expired.map(({ id }) => id);
  }

  isHealthy(): boolean {
    return this.database.pragma("quick_check", { simple: true }) === "ok";
  }

  close(): void {
    this.database.close();
  }

  private encrypt(id: string, plaintext: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(id, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [nonce, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
  }

  private decrypt(id: string, envelope: string): string {
    const [nonceValue, tagValue, ciphertextValue, extra] = envelope.split(".");
    if (!nonceValue || !tagValue || !ciphertextValue || extra) throw new Error("Stored session payload is malformed.");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(nonceValue, "base64url"));
    decipher.setAAD(Buffer.from(id, "utf8"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final()
    ]).toString("utf8");
  }
}
