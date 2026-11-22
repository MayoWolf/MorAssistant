import {
  ONSHAPE_CAPABILITY_CATALOG,
  compactFeatureSpecContext,
  featureFingerprint,
  selectOnshapeCapabilities,
  type AssemblyInspection,
  type PartStudioInspection
} from "@morassistant/onshape-client";

const querySchema = {
  type: "object",
  properties: { query: { type: "string", description: "Exact ID or name, or a short description." } },
  required: ["query"],
  additionalProperties: false
};

export const planningTools = [
  {
    type: "function",
    name: "lookup_onshape_tool",
    description: "Look up an Onshape operation by name or intent. Returns prerequisites, modeling guidance, verification and matching feature specifications from this tab.",
    inputSchema: querySchema
  },
  {
    type: "function",
    name: "inspect_onshape_target",
    description: "Read the exact payload of a feature or assembly instance from the current snapshot, including nearby constraints and occurrence transforms. Prefer an exact ID.",
    inputSchema: querySchema
  }
];

function matches(query: string, id: string, name: string): boolean {
  return id === query || name.toLowerCase().includes(query.toLowerCase());
}

export function readPlanningEvidence(
  inspection: PartStudioInspection | AssemblyInspection,
  tool: string,
  query: string
): unknown {
  if (tool === "lookup_onshape_tool") {
    const ranked = selectOnshapeCapabilities(query, ONSHAPE_CAPABILITY_CATALOG.length);
    const assembly = "elementType" in inspection;
    const relevant = ranked.filter((entry) => assembly
      ? entry.surface === "assembly" || entry.execution === "read_only"
      : entry.surface !== "assembly").slice(0, 6);
    const exactSpecs = assembly ? [] : compactFeatureSpecContext(inspection.featureSpecs, [], 38_000, query).relevantFeatureSpecs;
    const relatedSpecs = assembly || exactSpecs.length > 0 ? []
      : compactFeatureSpecContext(inspection.featureSpecs, relevant, 38_000).relevantFeatureSpecs;
    return {
      capabilities: relevant,
      exactSpecs,
      relatedSpecs,
      execution: assembly
        ? "Assembly writes: insert, place, suppress, unsuppress, delete. Other catalog entries can inform advice."
        : "Part Studio writes use typed operations or validated native feature payloads. UI actions can inform advice."
    };
  }

  if (tool === "inspect_onshape_target") {
    if ("elementType" in inspection) {
      const exact = inspection.instances.find((item) => item.id === query);
      const instances = exact ? [exact] : inspection.instances.filter((item) => matches(query, item.id, item.name)).slice(0, 8);
      const ids = new Set(instances.map((item) => item.id));
      return {
        instances,
        occurrences: inspection.occurrences.filter((item) => ids.has(item.path[0] ?? "")).slice(0, 24),
        mates: inspection.features.filter((item) => matches(query, item.id, item.name)
          || item.occurrencePaths.some((path) => ids.has(path[0] ?? ""))).slice(0, 24)
      };
    }
    const features = inspection.featureTree.features;
    const exact = features.find((item) => item.featureId === query);
    const candidates = exact ? [exact] : features.filter((item) => matches(query, item.featureId, item.name ?? "")).slice(0, 8);
    if (candidates.length !== 1) {
      return { matches: candidates.map(({ featureId, name, featureType }) => ({ featureId, name, featureType })) };
    }
    const [feature] = candidates;
    const dependency = inspection.dependencies.find((item) => item.featureId === feature!.featureId);
    return {
      featureHash: featureFingerprint(feature!),
      dependency,
      feature: JSON.stringify(feature).length <= 48_000 ? feature : {
        featureId: feature!.featureId,
        name: feature!.name,
        featureType: feature!.featureType,
        parameterIds: feature!.parameters?.slice(0, 100).map((parameter) => parameter.parameterId),
        note: "Full payload exceeds the response budget."
      }
    };
  }
  throw new Error("Unknown Onshape inspection tool.");
}
