#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ONSHAPE_CAPABILITY_CATALOG,
  ONSHAPE_CAPABILITY_CATALOG_VERSION,
  OnshapeClient,
  capabilityCategoryCounts,
  selectOnshapeCapabilities
} from "@morassistant/onshape-client";

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

server.registerTool("list_onshape_capabilities", {
  title: "List learned Onshape tools",
  description: "Read MorAssistant's complete Onshape modeling curriculum or select the tools relevant to a natural-language goal.",
  inputSchema: {
    prompt: z.string().max(2_000).optional(),
    surface: z.enum(["sketch", "part_studio", "assembly", "document"]).optional()
  },
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async ({ prompt, surface }) => {
  const selected = prompt ? selectOnshapeCapabilities(prompt, 60) : [...ONSHAPE_CAPABILITY_CATALOG];
  const capabilities = selected.filter((capability) => !surface || capability.surface === surface);
  const result = {
    version: ONSHAPE_CAPABILITY_CATALOG_VERSION,
    total: ONSHAPE_CAPABILITY_CATALOG.length,
    categoryCounts: capabilityCategoryCounts(),
    capabilities
  };
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
});

server.registerTool("get_feature_specs", {
  title: "Get live Onshape feature specifications",
  description: "Read exact current built-in and custom FeatureScript parameter schemas from the active Part Studio before constructing a native feature payload.",
  inputSchema: {
    ...contextShape,
    featureTypes: z.array(z.string().min(1).max(200)).max(30).optional()
  },
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async ({ featureTypes, ...context }) => {
  const response = await client.getFeatureSpecs(context);
  const specs = Array.isArray(response.featureSpecs)
    ? response.featureSpecs.filter((spec) => {
      if (!featureTypes?.length) return true;
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) return false;
      const featureType = (spec as Record<string, unknown>).featureType;
      return typeof featureType === "string" && featureTypes.some((candidate) => candidate.toLocaleLowerCase() === featureType.toLocaleLowerCase());
    }).slice(0, featureTypes?.length ? 30 : 200)
    : [];
  const result = { featureSpecs: specs };
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
});

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

server.registerTool("inspect_part_studio", {
  title: "Inspect the Part Studio model",
  description: "Read the feature dependency graph, downstream impact, topology, and mass-property summary. This does not modify the document.",
  inputSchema: contextShape,
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async (context) => {
  const inspection = await client.inspectPartStudio(context);
  const model = {
    dependencies: inspection.dependencies,
    geometry: inspection.geometry,
    warnings: inspection.warnings
  };
  return { content: [{ type: "text", text: JSON.stringify(model) }], structuredContent: model };
});

server.registerTool("evaluate_featurescript", {
  title: "Evaluate read-only FeatureScript",
  description: "Evaluate one FeatureScript lambda against the current Part Studio for geometric analysis. Evaluation is transient and does not persist feature changes.",
  inputSchema: {
    ...contextShape,
    script: z.string().min(1).max(20_000),
    libraryVersion: z.number().int().positive().optional()
  },
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async ({ script, libraryVersion, ...context }) => {
  const result = await client.evaluateFeatureScript(context, script, libraryVersion);
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { result } };
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

server.registerTool("create_circle_sketch", {
  title: "Create a circle sketch",
  description: "Create one native circle sketch on the Top plane.",
  inputSchema: {
    ...contextShape,
    sketchName: z.string().trim().min(1).max(100),
    plane: z.literal("Top"),
    radiusMm: z.number().min(0.05).max(10_000),
    centerXmm: z.number().min(-100_000).max(100_000),
    centerYmm: z.number().min(-100_000).max(100_000)
  },
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async ({ sketchName, plane, radiusMm, centerXmm, centerYmm, ...context }) => {
  const message = await client.applyOperation(context, {
    type: "create_circle_sketch",
    sketchName,
    plane,
    radiusMm,
    centerXmm,
    centerYmm,
    reason: "Approved MCP operation"
  });
  return { content: [{ type: "text", text: message }] };
});

server.registerTool("extrude_sketch", {
  title: "Extrude a sketch",
  description: "Create a guarded blind solid extrude from a named sketch; supports new, add, remove, and intersect.",
  inputSchema: {
    ...contextShape,
    featureName: z.string().trim().min(1).max(100),
    sourceFeatureName: z.string().trim().min(1).max(100),
    depthMm: z.number().min(0.05).max(100_000),
    operation: z.enum(["NEW", "ADD", "REMOVE", "INTERSECT"]),
    oppositeDirection: z.boolean(),
    symmetric: z.boolean()
  },
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async ({ featureName, sourceFeatureName, depthMm, operation, oppositeDirection, symmetric, ...context }) => {
  const message = await client.applyOperation(context, {
    type: "extrude_sketch",
    featureName,
    sourceFeatureName,
    depthMm,
    operation,
    oppositeDirection,
    symmetric,
    reason: "Approved MCP operation"
  });
  return { content: [{ type: "text", text: message }] };
});

server.registerTool("fillet_feature_edges", {
  title: "Fillet feature-created edges",
  description: "Resolve and fillet all current solid edges created by a named feature.",
  inputSchema: {
    ...contextShape,
    featureName: z.string().trim().min(1).max(100),
    targetFeatureName: z.string().trim().min(1).max(100),
    radiusMm: z.number().min(0.01).max(10_000),
    tangentPropagation: z.boolean()
  },
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async ({ featureName, targetFeatureName, radiusMm, tangentPropagation, ...context }) => {
  const message = await client.applyOperation(context, {
    type: "fillet_feature_edges",
    featureName,
    targetFeatureName,
    radiusMm,
    tangentPropagation,
    reason: "Approved MCP operation"
  });
  return { content: [{ type: "text", text: message }] };
});

server.registerTool("chamfer_feature_edges", {
  title: "Chamfer feature-created edges",
  description: "Resolve and apply an equal-offset chamfer to all current solid edges created by a named feature.",
  inputSchema: {
    ...contextShape,
    featureName: z.string().trim().min(1).max(100),
    targetFeatureName: z.string().trim().min(1).max(100),
    distanceMm: z.number().min(0.01).max(10_000),
    tangentPropagation: z.boolean()
  },
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async ({ featureName, targetFeatureName, distanceMm, tangentPropagation, ...context }) => {
  const message = await client.applyOperation(context, {
    type: "chamfer_feature_edges",
    featureName,
    targetFeatureName,
    distanceMm,
    tangentPropagation,
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
