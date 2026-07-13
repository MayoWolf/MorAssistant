import { randomBytes } from "node:crypto";

export interface RectangleSketchInput {
  name: string;
  widthMm: number;
  heightMm: number;
  centerXmm: number;
  centerYmm: number;
}

function objectId(): string {
  // Onshape BTObjectId values accept the standard base64 alphabet, but reject
  // base64url's '-' and '_' characters.
  return randomBytes(12).toString("base64").replace(/=+$/u, "");
}

function stringParameter(value: string, parameterId: string): Record<string, unknown> {
  return {
    btType: "BTMParameterString-149",
    libraryRelationType: "DEFAULT",
    value,
    nodeId: objectId(),
    parameterId,
    parameterName: ""
  };
}

function line(
  prefix: string,
  suffix: string,
  index: number,
  pntX: number,
  pntY: number,
  dirX: number,
  dirY: number,
  startParam: number,
  endParam: number
): Record<string, unknown> {
  const entityId = `${prefix}.${suffix}`;
  return {
    btType: "BTMSketchCurveSegment-155",
    geometry: { btType: "BTCurveGeometryLine-117", pntX, pntY, dirX, dirY },
    isConstruction: false,
    isFromSplineControlPolygon: false,
    offsetCurveExtensions: [],
    startPointId: `${entityId}.start`,
    endPointId: `${entityId}.end`,
    startParam,
    endParam,
    isFromEndpointSplineHandle: false,
    centerId: "",
    isFromSplineHandle: false,
    internalIds: [],
    curvedTextIds: [],
    namespace: "",
    name: "",
    index,
    parameters: [],
    nodeId: objectId(),
    entityId
  };
}

function constraint(
  prefix: string,
  suffix: string,
  index: number,
  type: string,
  references: Array<{ parameterId: string; value: string }>
): Record<string, unknown> {
  return {
    btType: "BTMSketchConstraint-2",
    hasOffsetData1: false,
    offsetOrientation1: false,
    offsetDistance1: 0,
    hasOffsetData2: false,
    offsetOrientation2: false,
    offsetDistance2: 0,
    hasPierceParameter: false,
    pierceParameter: 0,
    helpParameters: [],
    constraintType: type,
    namespace: "",
    name: "",
    parameters: references.map(({ parameterId, value }) => stringParameter(value, parameterId)),
    index,
    nodeId: objectId(),
    entityId: `${prefix}.${suffix}`
  };
}

const topPlaneQuery = "query=qCompressed(1.0,\"%B5$QueryM4Sa$entityTypeBa$EntityTypeS4$FACESb$historyTypeS8$CREATIONSb$operationIdB2$IdA1S3.7$TopplaneOpS9$queryTypeS5$DUMMY\",id);";

/**
 * Build the internal sketch feature format accepted by addPartStudioFeature.
 * The shape is based on a rectangle captured from Onshape API v15; coordinates
 * are converted from the public millimeter command contract to sketch meters.
 */
export function buildRectangleSketchFeature(input: RectangleSketchInput): Record<string, unknown> {
  const prefix = `rect${randomBytes(8).toString("hex")}`;
  const width = input.widthMm / 1_000;
  const height = input.heightMm / 1_000;
  const centerX = input.centerXmm / 1_000;
  const centerY = input.centerYmm / 1_000;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const bottom = `${prefix}.bottom`;
  const top = `${prefix}.top`;
  const left = `${prefix}.left`;
  const right = `${prefix}.right`;

  return {
    btType: "BTMSketch-151",
    suppressionState: null,
    parameterLibraries: [],
    returnAfterSubfeatures: false,
    subFeatures: [],
    entities: [
      line(prefix, "bottom", 1, centerX, centerY - halfHeight, 1, 0, -halfWidth, halfWidth),
      line(prefix, "top", 2, centerX, centerY + halfHeight, 1, 0, -halfWidth, halfWidth),
      line(prefix, "left", 3, centerX - halfWidth, centerY, 0, 1, -halfHeight, halfHeight),
      line(prefix, "right", 4, centerX + halfWidth, centerY, 0, 1, -halfHeight, halfHeight)
    ],
    constraints: [
      constraint(prefix, "perpendicular", 1, "PERPENDICULAR", [
        { parameterId: "localFirst", value: top },
        { parameterId: "localSecond", value: left }
      ]),
      constraint(prefix, "parallelHorizontal", 2, "PARALLEL", [
        { parameterId: "localFirst", value: bottom },
        { parameterId: "localSecond", value: top }
      ]),
      constraint(prefix, "parallelVertical", 3, "PARALLEL", [
        { parameterId: "localFirst", value: left },
        { parameterId: "localSecond", value: right }
      ]),
      constraint(prefix, "horizontal", 4, "HORIZONTAL", [
        { parameterId: "localFirst", value: top }
      ]),
      constraint(prefix, "corner0", 5, "COINCIDENT", [
        { parameterId: "localFirst", value: `${bottom}.start` },
        { parameterId: "localSecond", value: `${left}.start` }
      ]),
      constraint(prefix, "corner1", 6, "COINCIDENT", [
        { parameterId: "localFirst", value: `${bottom}.end` },
        { parameterId: "localSecond", value: `${right}.start` }
      ]),
      constraint(prefix, "corner2", 7, "COINCIDENT", [
        { parameterId: "localFirst", value: `${top}.start` },
        { parameterId: "localSecond", value: `${left}.end` }
      ]),
      constraint(prefix, "corner3", 8, "COINCIDENT", [
        { parameterId: "localFirst", value: `${top}.end` },
        { parameterId: "localSecond", value: `${right}.end` }
      ])
    ],
    namespace: "",
    name: input.name,
    parameters: [
      {
        btType: "BTMParameterQueryList-148",
        libraryRelationType: "DEFAULT",
        queries: [{
          btType: "BTMIndividualQuery-138",
          queryStatement: null,
          queryString: topPlaneQuery,
          nodeId: objectId(),
          deterministicIds: ["JDC"]
        }],
        filter: {
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
        },
        nodeId: objectId(),
        parameterId: "sketchPlane",
        parameterName: ""
      },
      {
        btType: "BTMParameterBoolean-144",
        libraryRelationType: "DEFAULT",
        value: false,
        nodeId: objectId(),
        parameterId: "disableImprinting",
        parameterName: ""
      }
    ],
    nodeId: objectId(),
    suppressed: false,
    featureType: "newSketch"
  };
}
