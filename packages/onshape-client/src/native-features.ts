import { randomBytes } from "node:crypto";

export type ExtrudeOperation = "NEW" | "ADD" | "REMOVE" | "INTERSECT";

export interface CircleSketchInput {
  name: string;
  radiusMm: number;
  centerXmm: number;
  centerYmm: number;
}

export interface ExtrudeFeatureInput {
  name: string;
  sketchFeatureId: string;
  depthMm: number;
  operation: ExtrudeOperation;
  oppositeDirection: boolean;
  symmetric: boolean;
}

export interface FilletFeatureInput {
  name: string;
  edgeTransientIds: string[];
  radiusMm: number;
  tangentPropagation: boolean;
}

function objectId(): string {
  // Onshape BTObjectId values use standard base64, not base64url.
  return randomBytes(12).toString("base64").replace(/=+$/u, "");
}

function deterministicId(): string {
  return `J${randomBytes(8).toString("hex").toUpperCase()}`;
}

function booleanParameter(parameterId: string, value: boolean): Record<string, unknown> {
  return {
    btType: "BTMParameterBoolean-144",
    libraryRelationType: "DEFAULT",
    value,
    nodeId: objectId(),
    parameterId,
    parameterName: ""
  };
}

function enumParameter(parameterId: string, enumName: string, value: string): Record<string, unknown> {
  return {
    btType: "BTMParameterEnum-145",
    namespace: "",
    nodeId: objectId(),
    libraryRelationType: "DEFAULT",
    enumName,
    value,
    parameterId,
    parameterName: ""
  };
}

function quantityParameter(parameterId: string, expression: string): Record<string, unknown> {
  return {
    btType: "BTMParameterQuantity-147",
    libraryRelationType: "DEFAULT",
    isInteger: false,
    value: 0,
    units: "",
    expression,
    nodeId: objectId(),
    parameterId,
    parameterName: ""
  };
}

const topPlaneQuery = "query=qCompressed(1.0,\"%B5$QueryM4Sa$entityTypeBa$EntityTypeS4$FACESb$historyTypeS8$CREATIONSb$operationIdB2$IdA1S3.7$TopplaneOpS9$queryTypeS5$DUMMY\",id);";

const topPlaneFilter = {
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

const sketchRegionFilter = {
  btType: "BTAndFilter-110",
  operand1: {
    btType: "BTOrFilter-167",
    operand1: {
      btType: "BTAndFilter-110",
      operand1: {
        btType: "BTAndFilter-110",
        operand1: { btType: "BTFlatSheetMetalFilter-3018", allows: "MODEL_AND_FLATTENED" },
        operand2: { btType: "BTSketchObjectFilter-184", isSketchObject: true, objectType: "ANY_SKETCH_OBJECT" }
      },
      operand2: { btType: "BTEntityTypeFilter-124", entityType: "FACE" }
    },
    operand2: {
      btType: "BTAndFilter-110",
      operand1: {
        btType: "BTAndFilter-110",
        operand1: { btType: "BTGeometryFilter-130", geometryType: "PLANE" },
        operand2: { btType: "BTFlatSheetMetalFilter-3018", allows: "MODEL_ONLY" }
      },
      operand2: { btType: "BTEntityTypeFilter-124", entityType: "FACE" }
    }
  },
  operand2: { btType: "BTConstructionObjectFilter-113", isConstruction: false }
};

const solidBodyFilter = {
  btType: "BTAndFilter-110",
  operand1: {
    btType: "BTAndFilter-110",
    operand1: { btType: "BTEntityTypeFilter-124", entityType: "BODY" },
    operand2: { btType: "BTBodyTypeFilter-112", bodyType: "SOLID" }
  },
  operand2: { btType: "BTSketchObjectFilter-184", isSketchObject: false, objectType: "NOT_SKETCH_OBJECT" }
};

const filletEntityFilter = {
  btType: "BTAndFilter-110",
  operand1: {
    btType: "BTAndFilter-110",
    operand1: {
      btType: "BTAndFilter-110",
      operand1: {
        btType: "BTOrFilter-167",
        operand1: {
          btType: "BTAndFilter-110",
          operand1: { btType: "BTActiveSheetMetalFilter-2944", isFromActiveSheetMetal: false },
          operand2: {
            btType: "BTOrFilter-167",
            operand1: {
              btType: "BTAndFilter-110",
              operand1: { btType: "BTEntityTypeFilter-124", entityType: "EDGE" },
              operand2: { btType: "BTEdgeTopologyFilter-122", isInternalEdge: true, edgeTopology: "TWO_SIDED" }
            },
            operand2: { btType: "BTEntityTypeFilter-124", entityType: "FACE" }
          }
        },
        operand2: {
          btType: "BTAndFilter-110",
          operand1: { btType: "BTEntityTypeFilter-124", entityType: "EDGE" },
          operand2: { btType: "BTSMDefinitionEntityTypeFilter-1651", smDefinitionEntityType: "VERTEX" }
        }
      },
      operand2: { btType: "BTConstructionObjectFilter-113", isConstruction: false }
    },
    operand2: { btType: "BTSketchObjectFilter-184", isSketchObject: false, objectType: "NOT_SKETCH_OBJECT" }
  },
  operand2: { btType: "BTModifiableEntityOnlyFilter-1593", modifiableOnly: true }
};

function queryList(parameterId: string, queries: Array<Record<string, unknown>>, filter: Record<string, unknown>): Record<string, unknown> {
  return {
    btType: "BTMParameterQueryList-148",
    libraryRelationType: "DEFAULT",
    queries,
    filter,
    nodeId: objectId(),
    parameterId,
    parameterName: ""
  };
}

function featureRoot(name: string, featureType: string, parameters: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    btType: "BTMFeature-134",
    namespace: "",
    name,
    suppressed: false,
    parameters,
    nodeId: objectId(),
    featureType,
    returnAfterSubfeatures: false,
    subFeatures: [],
    parameterLibraries: [],
    suppressionState: null
  };
}

/** Build a native Top-plane circle sketch using the payload shape emitted by Onshape API v16. */
export function buildCircleSketchFeature(input: CircleSketchInput): Record<string, unknown> {
  const entityId = `circle${randomBytes(8).toString("hex")}`;
  return {
    btType: "BTMSketch-151",
    suppressionState: null,
    parameterLibraries: [],
    returnAfterSubfeatures: false,
    subFeatures: [],
    entities: [{
      btType: "BTMSketchCurve-4",
      geometry: {
        btType: "BTCurveGeometryCircle-115",
        clockwise: false,
        radius: input.radiusMm / 1_000,
        xCenter: input.centerXmm / 1_000,
        yCenter: input.centerYmm / 1_000,
        xDir: 1,
        yDir: 0
      },
      isConstruction: false,
      isFromSplineControlPolygon: false,
      isFromEndpointSplineHandle: false,
      centerId: `${entityId}.center`,
      isFromSplineHandle: false,
      internalIds: [],
      curvedTextIds: [],
      namespace: "",
      name: "",
      index: 1,
      parameters: [],
      nodeId: objectId(),
      entityId
    }],
    constraints: [],
    namespace: "",
    name: input.name,
    parameters: [
      queryList("sketchPlane", [{
        btType: "BTMIndividualQuery-138",
        queryStatement: null,
        queryString: topPlaneQuery,
        nodeId: objectId(),
        deterministicIds: ["JDC"]
      }], topPlaneFilter),
      booleanParameter("disableImprinting", false)
    ],
    nodeId: objectId(),
    suppressed: false,
    featureType: "newSketch"
  };
}

/** Build a blind solid extrude from every closed region in one sketch. */
export function buildExtrudeFeature(input: ExtrudeFeatureInput): Record<string, unknown> {
  const isNew = input.operation === "NEW";
  return featureRoot(input.name, "extrude", [
    enumParameter("domain", "OperationDomain", "MODEL"),
    enumParameter("bodyType", "ExtendedToolBodyType", "SOLID"),
    enumParameter("operationType", "NewBodyOperationType", input.operation),
    enumParameter("surfaceOperationType", "NewSurfaceOperationType", "NEW"),
    enumParameter("flatOperationType", "FlatOperationType", "REMOVE"),
    queryList("entities", [{
      btType: "BTMIndividualSketchRegionQuery-140",
      queryStatement: null,
      filterInnerLoops: true,
      queryString: `query = qSketchRegion(id + ${JSON.stringify(input.sketchFeatureId)}, true);`,
      featureId: input.sketchFeatureId,
      nodeId: objectId(),
      deterministicIds: [deterministicId()]
    }], sketchRegionFilter),
    enumParameter("endBound", "BoundingType", "BLIND"),
    booleanParameter("oppositeDirection", input.oppositeDirection),
    quantityParameter("depth", `${input.depthMm} mm`),
    booleanParameter("symmetric", input.symmetric),
    booleanParameter("hasDraft", false),
    booleanParameter("defaultScope", !isNew),
    queryList("booleanScope", [], solidBodyFilter)
  ]);
}

/** Build an edge fillet over all edges created by a named source feature. */
export function buildFilletFeature(input: FilletFeatureInput): Record<string, unknown> {
  const emptyFaceFilter = {
    btType: "BTAndFilter-110",
    operand1: { btType: "BTEntityTypeFilter-124", entityType: "FACE" },
    operand2: { btType: "BTModifiableEntityOnlyFilter-1593", modifiableOnly: true }
  };
  return featureRoot(input.name, "fillet", [
    enumParameter("filletType", "FilletType", "EDGE"),
    queryList("entities", input.edgeTransientIds.map((transientId) => ({
      btType: "BTMIndividualQuery-138",
      queryStatement: null,
      queryString: `query=qTransient(${JSON.stringify(transientId)});`,
      nodeId: objectId(),
      deterministicIds: [transientId]
    })), filletEntityFilter),
    queryList("side1Face", [], emptyFaceFilter),
    queryList("side2Face", [], emptyFaceFilter),
    queryList("centerFaces", [], emptyFaceFilter),
    booleanParameter("tangentPropagation", input.tangentPropagation),
    enumParameter("blendControlType", "BlendControlType", "RADIUS"),
    enumParameter("crossSection", "FilletCrossSection", "CIRCULAR"),
    quantityParameter("radius", `${input.radiusMm} mm`),
    quantityParameter("nonCircularRadius", `${input.radiusMm} mm`),
    quantityParameter("width", `${input.radiusMm} mm`),
    quantityParameter("rho", "0.5"),
    quantityParameter("magnitude", "0.5"),
    booleanParameter("defaultsChanged", true),
    booleanParameter("isAsymmetric", false),
    quantityParameter("otherRadius", `${input.radiusMm} mm`),
    booleanParameter("flipAsymmetric", false),
    booleanParameter("isPartial", false),
    booleanParameter("isVariable", false),
    {
      btType: "BTMParameterArray-2025",
      libraryRelationType: "DEFAULT",
      items: [],
      nodeId: objectId(),
      parameterId: "vertexSettings",
      parameterName: ""
    },
    {
      btType: "BTMParameterArray-2025",
      libraryRelationType: "DEFAULT",
      items: [],
      nodeId: objectId(),
      parameterId: "pointOnEdgeSettings",
      parameterName: ""
    },
    booleanParameter("smoothTransition", false),
    booleanParameter("allowEdgeOverflow", true),
    queryList("keepEdges", [], filletEntityFilter),
    booleanParameter("smoothCorners", false),
    queryList("smoothCornerExceptions", [], {
      btType: "BTAndFilter-110",
      operand1: { btType: "BTEntityTypeFilter-124", entityType: "VERTEX" },
      operand2: { btType: "BTModifiableEntityOnlyFilter-1593", modifiableOnly: true }
    })
  ]);
}
