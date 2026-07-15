export type StandardPlane = "Top" | "Front" | "Right";

const planeTransientIds: Record<StandardPlane, string> = {
  Top: "JDC",
  Front: "JCC",
  Right: "JEC"
};

/** Return a stable query for one of Onshape's default datum planes. */
export function standardPlaneQuery(plane: StandardPlane, nodeId: string): Record<string, unknown> {
  return {
    btType: "BTMIndividualQuery-138",
    queryStatement: null,
    queryString: `query=qCreatedBy(makeId(${JSON.stringify(plane)}), EntityType.FACE);`,
    nodeId,
    deterministicIds: [planeTransientIds[plane]]
  };
}

export const sketchPlaneFilter = {
  btType: "BTOrFilter-167",
  operand1: {
    btType: "BTOrFilter-167",
    operand1: {
      btType: "BTAndFilter-110",
      operand1: { btType: "BTGeometryFilter-130", geometryType: "PLANE" },
      operand2: { btType: "BTFlatSheetMetalFilter-3018", allows: "MODEL_ONLY" }
    },
    operand2: {
      btType: "BTAndFilter-110",
      operand1: {
        btType: "BTAndFilter-110",
        operand1: { btType: "BTSMDefinitionEntityTypeFilter-1651", smDefinitionEntityType: "FACE" },
        operand2: { btType: "BTFlatSheetMetalFilter-3018", allows: "MODEL_AND_FLATTENED" }
      },
      operand2: { btType: "BTGeometryFilter-130", geometryType: "PLANE" }
    }
  },
  operand2: { btType: "BTBodyTypeFilter-112", bodyType: "MATE_CONNECTOR" }
};
