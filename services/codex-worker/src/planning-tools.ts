import {
  ONSHAPE_CAPABILITY_CATALOG,
  compactFeatureSpecContext,
  featureFingerprint,
  selectOnshapeCapabilities,
  type AssemblyInspection,
  type OnshapeFeature,
  type PartStudioInspection
} from "@morassistant/onshape-client";
import { boundedRecords, jsonBytes } from "./turn-budget.js";

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

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function sketchGeometry(feature: OnshapeFeature) {
  if (feature.featureType !== "newSketch" || !Array.isArray(feature.entities)) return undefined;
  return boundedRecords(feature.entities.flatMap<Record<string, unknown>>((value) => {
    const entity = asRecord(value);
    if (!entity || entity.isConstruction === true) return [];
    const geometry = asRecord(entity.geometry);
    if (geometry?.btType === "BTCurveGeometryCircle-115") {
      return [{ kind: "circleOrArc", xM: geometry.xCenter, yM: geometry.yCenter, radiusM: geometry.radius }];
    }
    if (geometry?.btType === "BTCurveGeometryLine-117") {
      return [{ kind: "line", xM: geometry.pntX, yM: geometry.pntY, dx: geometry.dirX, dy: geometry.dirY, startM: entity.startParam, endM: entity.endParam }];
    }
    if (entity.btType === "BTMSketchTextEntity-1761") {
      return [{ kind: "text", text: entity.text, xM: entity.baselineStartX, yM: entity.baselineStartY, heightM: entity.ascent }];
    }
    return [];
  }), 680, 6);
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
      : entry.surface !== "assembly").slice(0, 3);
    const exactSpecs = assembly ? [] : compactFeatureSpecContext(inspection.featureSpecs, [], 2_400, query).relevantFeatureSpecs;
    const relatedSpecs = assembly || exactSpecs.length > 0 ? []
      : compactFeatureSpecContext(inspection.featureSpecs, relevant, 2_400).relevantFeatureSpecs;
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
        instances: boundedRecords(instances, 1_900, 6),
        trustedComponentSources: boundedRecords(inspection.trustedSources.filter((source) => instances.some((instance) =>
          instance.documentId === source.documentId && instance.elementId === source.elementId &&
          instance.partId === source.partId && instance.configuration === source.configuration &&
          instance.documentVersion === source.versionId && instance.documentMicroversion === source.microversionId)), 950, 3),
        occurrences: boundedRecords(inspection.occurrences.filter((item) => ids.has(item.path[0] ?? "")), 1_550, 6),
        mates: boundedRecords(inspection.features.filter((item) => matches(query, item.id, item.name)
          || item.occurrencePaths.some((path) => ids.has(path[0] ?? ""))), 1_200, 8)
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
      dependency: dependency && { ...dependency, dependsOn: dependency.dependsOn.slice(0, 10), usedBy: dependency.usedBy.slice(0, 10), usedByCount: dependency.usedBy.length },
      feature: jsonBytes(feature) <= 3_500 ? feature : {
        featureId: feature!.featureId,
        name: feature!.name,
        featureType: feature!.featureType,
        parameters: boundedRecords((feature!.parameters ?? []).map(({ parameterId, expression, value }) => ({ parameterId, expression, value })), 800, 12),
        geometry: sketchGeometry(feature!),
        note: "Large feature: this is a summary, not a valid replacement payload. Preserve the feature or use a typed edit."
      }
    };
  }
  throw new Error("Unknown Onshape inspection tool.");
}
