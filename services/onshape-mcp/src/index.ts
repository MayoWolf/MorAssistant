#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OnshapeClient } from "@morassistant/onshape-client";

const accessToken = process.env.MOR_ONSHAPE_ACCESS_TOKEN;
if (!accessToken) throw new Error("MOR_ONSHAPE_ACCESS_TOKEN is required.");

const client = new OnshapeClient({
  accessToken: () => accessToken,
  ...(process.env.ONSHAPE_BASE_URL ? { baseUrl: process.env.ONSHAPE_BASE_URL } : {}),
  ...(process.env.ONSHAPE_API_VERSION ? { apiVersion: process.env.ONSHAPE_API_VERSION } : {})
});
const server = new McpServer({ name: "morassistant-onshape", version: "0.1.0" });

const contextShape = {
  documentId: z.string().min(1).describe("Current Onshape document ID"),
  workspaceId: z.string().min(1).describe("Current Onshape workspace ID"),
  elementId: z.string().min(1).describe("Current Part Studio element ID")
};

server.registerTool("list_features", {
  title: "List Part Studio features",
  description: "Read the current feature tree. This does not modify the document.",
  inputSchema: contextShape,
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async (context) => {
  const tree = await client.listFeatures(context);
  const features = tree.features.map((feature) => ({
    featureId: feature.featureId,
    name: feature.name,
    featureType: feature.featureType,
    parameters: feature.parameters?.filter((parameter) => typeof parameter.expression === "string")
      .map((parameter) => ({ parameterId: parameter.parameterId, expression: parameter.expression }))
  }));
  return { content: [{ type: "text", text: JSON.stringify({ features }) }], structuredContent: { features } };
});

server.registerTool("rename_feature", {
  title: "Rename a Part Studio feature",
  description: "Rename one existing feature, only if its current name still matches the preview.",
  inputSchema: {
    ...contextShape,
    featureId: z.string().min(1),
    currentName: z.string().min(1),
    newName: z.string().trim().min(1).max(100)
  },
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async ({ featureId, currentName, newName, ...context }) => {
  const message = await client.applyOperation(context, {
    type: "rename_feature", featureId, currentName, newName, reason: "Approved MCP operation"
  });
  return { content: [{ type: "text", text: message }] };
});

server.registerTool("update_dimension", {
  title: "Update a feature dimension",
  description: "Change one quantity expression, only if the current expression still matches the preview.",
  inputSchema: {
    ...contextShape,
    featureId: z.string().min(1),
    featureName: z.string().min(1),
    parameterId: z.string().min(1),
    currentExpression: z.string().min(1),
    newExpression: z.string().trim().min(1).max(100)
  },
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async ({ featureId, featureName, parameterId, currentExpression, newExpression, ...context }) => {
  const message = await client.applyOperation(context, {
    type: "update_dimension",
    featureId,
    featureName,
    parameterId,
    currentExpression,
    newExpression,
    reason: "Approved MCP operation"
  });
  return { content: [{ type: "text", text: message }] };
});

server.registerTool("create_rectangle_sketch", {
  title: "Create a rectangle sketch",
  description: "Create one axis-aligned rectangle or square sketch on the Top plane.",
  inputSchema: {
    ...contextShape,
    sketchName: z.string().trim().min(1).max(100),
    plane: z.literal("Top"),
    widthMm: z.number().min(0.1).max(10_000),
    heightMm: z.number().min(0.1).max(10_000),
    centerXmm: z.number().min(-100_000).max(100_000),
    centerYmm: z.number().min(-100_000).max(100_000)
  },
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async ({ sketchName, plane, widthMm, heightMm, centerXmm, centerYmm, ...context }) => {
  const message = await client.applyOperation(context, {
    type: "create_rectangle_sketch",
    sketchName,
    plane,
    widthMm,
    heightMm,
    centerXmm,
    centerYmm,
    reason: "Approved MCP operation"
  });
  return { content: [{ type: "text", text: message }] };
});

server.registerTool("create_feature", {
  title: "Create a native Part Studio feature",
  description: "Create any validated BTMFeature-134 or BTMSketch-151 payload.",
  inputSchema: {
    ...contextShape,
    featureName: z.string().trim().min(1).max(100),
    featureType: z.string().trim().min(1).max(200),
    featureJson: z.string().min(2).max(100_000)
  },
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async ({ featureName, featureType, featureJson, ...context }) => {
  const message = await client.applyOperation(context, {
    type: "create_feature",
    featureName,
    featureType,
    featureJson,
    reason: "Approved MCP operation"
  });
  return { content: [{ type: "text", text: message }] };
});

server.registerTool("replace_feature", {
  title: "Replace a native Part Studio feature",
  description: "Replace one existing feature only if its exact snapshot hash still matches.",
  inputSchema: {
    ...contextShape,
    featureId: z.string().min(1),
    currentName: z.string().min(1),
    currentFeatureHash: z.string().regex(/^[a-f0-9]{64}$/u),
    featureType: z.string().trim().min(1).max(200),
    featureJson: z.string().min(2).max(100_000)
  },
  annotations: { readOnlyHint: false, destructiveHint: true }
}, async ({ featureId, currentName, currentFeatureHash, featureType, featureJson, ...context }) => {
  const message = await client.applyOperation(context, {
    type: "replace_feature",
    featureId,
    currentName,
    currentFeatureHash,
    featureType,
    featureJson,
    reason: "Approved MCP operation"
  });
  return { content: [{ type: "text", text: message }] };
});

server.registerTool("delete_feature", {
  title: "Delete a Part Studio feature",
  description: "Delete one feature only if its current name still matches.",
  inputSchema: {
    ...contextShape,
    featureId: z.string().min(1),
    currentName: z.string().min(1)
  },
  annotations: { readOnlyHint: false, destructiveHint: true }
}, async ({ featureId, currentName, ...context }) => {
  const message = await client.applyOperation(context, {
    type: "delete_feature",
    featureId,
    currentName,
    reason: "Approved MCP operation"
  });
  return { content: [{ type: "text", text: message }] };
});

server.registerTool("inspect_regeneration_errors", {
  title: "Inspect regeneration errors",
  description: "Read failed or warning feature states after an edit.",
  inputSchema: contextShape,
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async (context) => {
  const errors = await client.inspectRegenerationErrors(context);
  return { content: [{ type: "text", text: JSON.stringify({ errors }) }], structuredContent: { errors } };
});

await server.connect(new StdioServerTransport());
