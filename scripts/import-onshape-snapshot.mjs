#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SessionStore } from "../services/api/dist/session-store.js";

const [snapshotPath, documentId, workspaceId, elementId, configuration = ""] = process.argv.slice(2);
if (!snapshotPath || !documentId || !workspaceId || !elementId) {
  throw new Error("Usage: import-onshape-snapshot.mjs SNAPSHOT DID WID EID [CONFIGURATION]");
}

const installationToken = process.env.INSTALLATION_TOKEN;
const encryptionKey = process.env.SESSION_ENCRYPTION_KEY;
const databasePath = process.env.SESSION_DB_PATH;
const server = process.env.ONSHAPE_BASE_URL ?? "https://cad.onshape.com";
const apiVersion = process.env.ONSHAPE_API_VERSION ?? "v16";
if (!installationToken || !encryptionKey || !databasePath) {
  throw new Error("INSTALLATION_TOKEN, SESSION_ENCRYPTION_KEY, and SESSION_DB_PATH are required.");
}

const tree = JSON.parse(await readFile(resolve(snapshotPath), "utf8"));
if (!Array.isArray(tree.features) || typeof tree.sourceMicroversion !== "string") {
  throw new Error("The snapshot must be an Onshape feature-list response with a sourceMicroversion.");
}
if (JSON.stringify(tree).length > 2_000_000) throw new Error("The snapshot exceeds the 2 MB safety limit.");

const ownerSessionId = `owner-${createHash("sha256").update(`morassistant:${installationToken}`).digest("hex")}`;
const contextKey = createHash("sha256").update(JSON.stringify([
  server,
  apiVersion,
  documentId,
  workspaceId,
  elementId,
  configuration
])).digest("hex");

const store = new SessionStore(databasePath, encryptionKey);
try {
  const session = store.get(ownerSessionId) ?? store.create(ownerSessionId);
  session.partStudioSnapshots.set(contextKey, { contextKey, capturedAt: Date.now(), tree });
  store.save(session);
  process.stdout.write(`Imported verified feature snapshot (${tree.features.length} features).\n`);
} finally {
  store.close();
}
