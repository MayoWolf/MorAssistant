/**
 * The durable curriculum for MorAssistant's CAD planner.
 *
 * Onshape's live feature-specification endpoint supplies exact, document-specific
 * parameter schemas. This catalog supplies the modeling intent that a raw schema
 * cannot: when to use a tool, what it requires, and how to verify the result.
 * Keeping those two sources separate lets the agent understand every built-in
 * toolbar while still adapting to new and custom FeatureScript features.
 */

export type OnshapeSurface = "sketch" | "part_studio" | "assembly" | "document";
export type CapabilityExecution =
  | "typed"
  | "native_feature"
  | "native_sketch"
  | "assembly_api"
  | "read_only"
  | "ui_only";

export type CapabilityCategory =
  | "sketch_geometry"
  | "sketch_constraint"
  | "sketch_edit"
  | "solid_feature"
  | "surface_feature"
  | "curve_feature"
  | "pattern_transform"
  | "construction_reference"
  | "sheet_metal"
  | "frame"
  | "assembly_mate"
  | "assembly_relation"
  | "assembly_management"
  | "inspection"
  | "metadata_configuration";

export interface OnshapeCapability {
  id: string;
  name: string;
  category: CapabilityCategory;
  surface: OnshapeSurface;
  execution: CapabilityExecution;
  aliases: string[];
  featureTypes: string[];
  prerequisites: string;
  guidance: string;
  verification: string;
}

type CompactCapability = readonly [
  id: string,
  name: string,
  featureTypes: string,
  aliases: string,
  prerequisites: string,
  guidance: string,
  verification?: string
];

function defineMany(
  category: CapabilityCategory,
  surface: OnshapeSurface,
  execution: CapabilityExecution,
  items: readonly CompactCapability[]
): OnshapeCapability[] {
  return items.map(([id, name, featureTypes, aliases, prerequisites, guidance, verification]) => ({
    id,
    name,
    category,
    surface,
    execution,
    aliases: aliases.split("|").map((value) => value.trim()).filter(Boolean),
    featureTypes: featureTypes.split("|").map((value) => value.trim()).filter(Boolean),
    prerequisites,
    guidance,
    verification: verification ?? "Confirm the resulting feature is OK and the intended geometry changed without new regeneration errors."
  }));
}

const sketchGeometry = defineMany("sketch_geometry", "sketch", "native_sketch", [
  ["line", "Line", "newSketch", "segment|edge|polyline", "A sketch plane and two endpoints.", "Create connected line segments; add geometric constraints first and dimensions second."],
  ["midpoint-line", "Midpoint line", "newSketch", "centered line", "A sketch plane, midpoint, and endpoint.", "Create a line symmetrically from a chosen midpoint."],
  ["point", "Point", "newSketch", "sketch point", "A sketch plane and position.", "Use for construction, dimensions, paths, and reference locations."],
  ["corner-rectangle", "Corner rectangle", "newSketch", "rectangle|box profile", "Two opposite corners.", "Create four closed, horizontal/vertical segments; constrain coincident corners."],
  ["center-point-rectangle", "Center-point rectangle", "newSketch", "center rectangle|symmetric rectangle", "Center, width, height, and orientation.", "Create a rectangle centered on a reference point and keep opposing sides symmetric."],
  ["three-point-rectangle", "Three-point rectangle", "newSketch", "angled rectangle|oriented rectangle", "Three points defining a side and width.", "Use when the rectangle must not align to the sketch axes."],
  ["aligned-rectangle", "Aligned rectangle", "newSketch", "edge aligned rectangle", "An alignment reference and rectangle bounds.", "Align the rectangle to existing sketch or model geometry."],
  ["center-point-circle", "Center-point circle", "newSketch", "circle|round profile|diameter", "Center and radius or diameter.", "Prefer the typed create_circle_sketch operation for a single Top-plane circle."],
  ["three-point-circle", "Three-point circle", "newSketch", "circle through points|circumcircle", "Three non-collinear points.", "Use when a circle must pass through three known locations."],
  ["tangent-arc", "Tangent arc", "newSketch", "arc tangent", "An existing curve endpoint and arc endpoint.", "Continue from a curve with tangent continuity."],
  ["three-point-arc", "Three-point arc", "newSketch", "arc through points", "Start, end, and point on the arc.", "Use for an arc fixed by three positions."],
  ["center-point-arc", "Center-point arc", "newSketch", "radius arc|circular arc", "Center, radius point, and sweep endpoint.", "Use when center and angular span matter."],
  ["ellipse", "Ellipse", "newSketch", "oval", "Center, major-axis point, and minor radius.", "Dimension both axes and constrain the major-axis orientation."],
  ["elliptical-arc", "Elliptical arc", "newSketch", "partial ellipse", "Ellipse axes plus start and end parameters.", "Use for a bounded portion of an ellipse."],
  ["spline", "Spline", "newSketch", "fit spline|freeform curve", "Ordered fit points and optional end conditions.", "Use the fewest fit points practical; constrain endpoints and tangency/curvature deliberately."],
  ["bezier", "Bezier", "newSketch", "control polygon curve", "Endpoints and control points.", "Use control points to shape a polynomial curve with predictable continuity."],
  ["conic", "Conic", "newSketch", "parabola|hyperbola|rho conic", "Endpoints, shoulder point, and rho.", "Use when a controlled conic transition is preferable to a spline."],
  ["text", "Sketch text", "newSketch", "label|engraving text|emboss text", "Text, font settings, anchor, and size.", "Create text curves suitable for extrude, remove, split, or wrap."],
  ["slot", "Slot", "newSketch", "straight slot|arc slot|keyway", "Slot centerline or arc plus width.", "Create a closed constant-width slot and fully constrain its path and width."],
  ["inscribed-polygon", "Inscribed polygon", "newSketch", "polygon inside circle|regular polygon", "Center, vertex radius, and side count.", "Place vertices on the construction circle."],
  ["circumscribed-polygon", "Circumscribed polygon", "newSketch", "polygon around circle", "Center, apothem, and side count.", "Place side midpoints tangent to the construction circle."],
  ["construction", "Construction geometry", "newSketch", "centerline|reference geometry", "Existing or new sketch entities.", "Mark non-profile geometry as construction so it constrains without forming regions."],
  ["insert-image", "Insert image", "newSketch", "canvas|reference image", "An uploaded image and scale/position.", "Use only as a tracing reference; constrain the scale before tracing."],
  ["insert-dxf-dwg", "Insert DXF or DWG", "newSketch", "import dxf|import dwg", "A supported drawing file and insertion plane.", "Import curves, then repair gaps, scale, and constraints before modeling."],
  ["wrap-sketch", "Wrap", "wrap", "wrap sketch|emboss|deboss|scribe", "Sketch entities and a cylindrical or conical target.", "Wrap sketch curves onto a target using solid add/remove or surface imprint as appropriate."]
]);

const sketchConstraints = defineMany("sketch_constraint", "sketch", "native_sketch", [
  ["dimension", "Dimension", "newSketch", "length|distance|angle|radius|diameter", "Compatible sketch entities.", "Apply driving or driven length, distance, angle, radius, or diameter dimensions with unit-aware expressions."],
  ["coincident", "Coincident", "newSketch", "merge point|point on curve", "Two points, or a point and curve.", "Make selected positions occupy the same location or place a point on a curve."],
  ["concentric", "Concentric", "newSketch", "same center", "Two circles, arcs, or ellipses.", "Make curved entities share a center."],
  ["parallel", "Parallel", "newSketch", "same direction", "Two lines.", "Constrain two lines to remain parallel."],
  ["perpendicular", "Perpendicular", "newSketch", "right angle|90 degree", "Two lines.", "Constrain lines to a right angle."],
  ["horizontal", "Horizontal", "newSketch", "horizontal line|same y", "A line or two points.", "Make a line horizontal or points share Y."],
  ["vertical", "Vertical", "newSketch", "vertical line|same x", "A line or two points.", "Make a line vertical or points share X."],
  ["tangent", "Tangent", "newSketch", "smooth contact|g1", "Compatible line/arc/circle/spline entities.", "Apply G1 tangency at the intended contact."],
  ["curvature", "Curvature", "newSketch", "curvature continuous|g2", "Compatible spline or conic endpoints.", "Apply G2 continuity only when smooth curvature flow is required."],
  ["equal", "Equal", "newSketch", "same length|same radius", "Compatible lines or circular entities.", "Keep lengths or radii equal without duplicating dimensions."],
  ["midpoint", "Midpoint", "newSketch", "center point of line", "A point and a line or arc.", "Constrain the point to the entity midpoint."],
  ["symmetric", "Symmetric", "newSketch", "mirror constraint", "Two entities and a symmetry line.", "Keep entities mirrored about a construction line."],
  ["normal", "Normal", "newSketch", "curve normal", "A line and curve, or curve and plane.", "Make the line normal to the curve at their relationship point."],
  ["pierce", "Pierce", "newSketch", "profile intersects path", "A sketch point and a curve crossing the sketch plane.", "Constrain the point to the curve/plane intersection, especially for sweep profiles."],
  ["fix", "Fix", "newSketch", "lock|ground sketch entity", "Sketch entities.", "Use sparingly; prefer design-intent constraints and dimensions."],
  ["automatic-inference", "Automatic inference", "newSketch", "auto constraint|infer", "Geometry being created near references.", "Accept useful inferred relations, then verify the sketch is neither under- nor over-constrained."]
]);

const sketchEditing = defineMany("sketch_edit", "sketch", "native_sketch", [
  ["trim", "Trim", "newSketch", "cut sketch curve", "Intersecting or bounded sketch curves.", "Remove the selected curve segment while preserving useful constraints."],
  ["extend", "Extend", "newSketch", "extend curve to boundary", "A curve and reachable boundary.", "Extend to the nearest valid intersection."],
  ["split-sketch", "Split sketch entity", "newSketch", "break curve", "A curve and split location.", "Divide a curve without changing its shape."],
  ["sketch-fillet", "Sketch fillet", "newSketch", "round sketch corner", "Intersecting sketch curves and radius.", "Trim/extend inputs and insert a tangent arc."],
  ["sketch-chamfer", "Sketch chamfer", "newSketch", "bevel sketch corner", "Intersecting sketch curves and distance/angle definition.", "Trim/extend inputs and insert the selected chamfer type."],
  ["offset-sketch", "Offset sketch entities", "newSketch", "parallel sketch copy|wall profile", "Curves, distance, direction, and chain selection.", "Offset with correct side and cap behavior; check self-intersections."],
  ["use-project", "Use or project", "newSketch", "project edge|convert entities", "Model/sketch edges or silhouettes and an active sketch plane.", "Project stable references into the active sketch."],
  ["intersection-sketch", "Intersection", "newSketch", "intersect face with plane", "Faces/surfaces crossing the sketch plane.", "Create sketch curves where selected geometry intersects the plane."],
  ["sketch-mirror", "Sketch mirror", "newSketch", "mirror sketch entities", "Entities and a construction mirror line.", "Mirror geometry and preserve intended symmetry."],
  ["sketch-linear-pattern", "Sketch linear pattern", "newSketch", "array sketch linear", "Entities, direction, count, and spacing.", "Pattern seed entities with constrained spacing/count."],
  ["sketch-circular-pattern", "Sketch circular pattern", "newSketch", "polar sketch array", "Entities, center, angle, and count.", "Pattern around a center with full or partial angular distribution."],
  ["sketch-transform", "Sketch transform", "newSketch", "move rotate scale sketch", "Selected entities and translation/rotation/scale.", "Rigidly move/rotate or uniformly scale selected geometry; recheck external references."],
  ["spline-control-point", "Spline control points", "newSketch", "edit spline handles", "An existing spline.", "Adjust fit/control points and handles while monitoring continuity."],
  ["troubleshoot-sketch", "Troubleshoot sketch", "newSketch", "under constrained|over constrained|solve sketch", "A sketch with solver issues.", "Inspect constraints and degrees of freedom; remove only redundant/conflicting relations.", "The sketch solves and reports the intended fully constrained state without red constraints."]
]);

const solidFeatures = defineMany("solid_feature", "part_studio", "native_feature", [
  ["extrude", "Extrude", "extrude", "push pull|prismatic|pad|pocket|cut", "Sketch regions, planar faces, or curves.", "Choose solid/surface/thin, NEW/ADD/REMOVE/INTERSECT, end bound, direction, offsets, draft, second direction, and merge scope. Prefer typed extrude_sketch for blind solids."],
  ["revolve", "Revolve", "revolve", "lathe|turn|revolution", "Profile plus an axis.", "Choose solid/surface/thin, operation, axis, angle/full revolution, directions, and merge scope."],
  ["sweep", "Sweep", "sweep", "pipe along path|profile along path", "Profile and a connected path; optional guide/lock controls.", "Choose solid/surface/thin and operation; control profile orientation, twist, scale, and merge scope. Use Pierce constraints to locate profiles robustly."],
  ["loft", "Loft", "loft", "blend profiles|transition", "Two or more ordered profiles or faces.", "Choose solid/surface/thin and operation; order profiles, add guides/paths, and set start/end continuity and connections."],
  ["fillet", "Fillet", "fillet", "round|edge round|face fillet|full round", "Edges or faces and a feasible radius law.", "Use edge, face, or full-round mode; constant/variable radius, tangent propagation, conic/cross-section options, and overflow behavior. Prefer typed fillet_feature_edges for all edges created by one feature."],
  ["chamfer", "Chamfer", "chamfer", "bevel|break edge", "Edges or faces.", "Use equal distance, two distances, or distance-angle; choose direction and tangent propagation."],
  ["draft", "Draft", "draft", "taper|pull angle", "Faces plus neutral plane or parting/reference entities and pull direction.", "Select neutral plane, parting line, or reference-surface mode; set pull direction, angle, propagation, and refillet behavior."],
  ["body-draft", "Body draft", "bodyDraft", "draft whole body|taper body", "Bodies and pull/neutral references.", "Apply consistent draft to many faces while respecting parting and reference geometry."],
  ["shell", "Shell", "shell", "hollow|wall thickness", "Solid parts and optional faces to remove.", "Set inward/outward thickness, remove openings, and use per-face overrides only where needed."],
  ["hole", "Hole", "hole", "drill|counterbore|countersink|tapped hole", "Placement points or mate connectors and target parts.", "Choose simple/counterbore/countersink, clearance/tapped standard, diameter, depth/end condition, tip, countersink angle, scope, and positions."],
  ["rib", "Rib", "rib", "web|stiffener", "Open or closed sketch curves intersecting a part.", "Set normal/parallel direction, thickness, symmetric/one-sided behavior, draft, extension, and merge scope."],
  ["boolean", "Boolean", "boolean", "union|subtract|intersect|combine", "Two or more parts/surfaces.", "Choose union, subtract, or intersect; identify target/tools, keep-tools behavior, and offset if available."],
  ["split", "Split", "split", "split part|split face", "Parts/faces and a plane, face, surface, or mate connector.", "Choose part or face split, tool, trim-to-face-boundaries behavior, and keep both sides as intended."],
  ["enclose", "Enclose", "enclose", "make solid from surfaces|watertight", "A closed set of surfaces and/or faces.", "Create a solid from a watertight boundary; include all bounding entities."],
  ["thicken", "Thicken", "thicken", "surface to solid|wall", "Faces or surfaces.", "Choose NEW/ADD/REMOVE/INTERSECT, one/two-sided or midplane thickness, direction, and merge scope."],
  ["replace-face", "Replace face", "replaceFace", "move face to surface", "Target faces and replacement face/surface.", "Extend/trim adjacent faces so the targets terminate on the replacement."],
  ["move-face", "Move face", "moveFace", "offset face|translate face|rotate face", "Faces and offset/translation/rotation definition.", "Use direct editing while preserving adjacent topology; verify thin or blended regions."],
  ["delete-face", "Delete face", "deleteFace", "remove face|heal", "Faces.", "Delete with heal to close the part, or leave open to create a surface."],
  ["modify-fillet", "Modify fillet", "modifyFillet", "change imported fillet", "Recognized fillet faces.", "Change or remove recognized fillets on imported/direct-edited geometry."],
  ["delete-part", "Delete part", "deleteBodies", "remove body", "Parts or bodies.", "Delete only explicitly requested bodies; treat as destructive and high risk."],
  ["external-thread", "External thread", "externalThread", "thread shaft|screw thread", "A cylindrical face and thread definition.", "Choose standard/size/class, thread length, end treatment, and modeled-versus-cosmetic intent."],
  ["derived", "Derived", "importDerived", "derive part|reference part studio", "A source Part Studio/part and configuration.", "Insert linked source geometry with location/orientation and preserve associativity."],
  ["composite-part", "Composite part", "compositePart", "group parts as one", "Multiple parts, surfaces, curves, or points.", "Create a closed or open composite for BOM and selection behavior without booleaning geometry."],
  ["decal", "Decal", "decal", "apply image to face|label image", "An image and target face.", "Position, scale, rotate, and map the image to the face; this changes appearance, not solid geometry."],
  ["tag", "Tag", "tag", "entity tag", "Supported entities and a tag value.", "Attach stable semantic tags for later queries or custom features."],
  ["custom-feature", "Custom FeatureScript feature", "", "custom feature|featurescript", "An installed/imported feature specification.", "Use the live feature spec and an exact existing example; never guess a custom feature payload."]
]);

const surfaceFeatures = defineMany("surface_feature", "part_studio", "native_feature", [
  ["boundary-surface", "Boundary surface", "boundarySurface", "four sided surface|network surface", "Curves/edges in two directions.", "Build a surface from U/V boundary networks with tangent or curvature continuity where required."],
  ["fill-surface", "Fill", "fill", "patch surface|fill hole", "A closed boundary of edges/curves.", "Create a patch and set contact, tangent, or curvature conditions per boundary; add guides when needed."],
  ["offset-surface", "Offset surface", "offsetSurface", "copy surface offset", "Faces or surfaces and distance.", "Create an offset copy; use zero offset to extract faces."],
  ["ruled-surface", "Ruled surface", "ruledSurface", "surface from edge|draft surface", "Edges and a direction/angle rule.", "Create surfaces normal, tangent, aligned, or angled from selected edges."],
  ["constrained-surface", "Constrained surface", "constrainedSurface", "surface through constraints", "Boundary and interior constraints.", "Create a surface honoring positional/tangent/curvature constraints."],
  ["face-blend", "Face blend", "faceBlend", "surface blend|blend faces", "Two face sets and optional limits/cross section.", "Blend between face sets with rolling-ball or controlled cross section and propagation."],
  ["move-boundary", "Move boundary", "moveBoundary", "extend trim surface edge", "Surface boundary edges.", "Move a surface boundary by distance or up to an entity without changing the underlying surface."],
  ["mutual-trim", "Mutual trim", "mutualTrim", "trim surfaces together", "Intersecting surfaces.", "Trim both surfaces at their intersection and retain the intended regions."],
  ["surface-modeling", "Surface workflow", "", "surfacing|surface model", "Curves, edges, and surface features.", "Plan surface continuity, create/trim/extend surfaces, then enclose or thicken only after the quilt is watertight."]
]);

const curveFeatures = defineMany("curve_feature", "part_studio", "native_feature", [
  ["helix", "Helix", "helix", "spiral|coil path", "Cylinder/cone, circular edge, axis, or mate connector.", "Define turns/pitch/height, handedness, start angle, and direction; use as a sweep path or reference."],
  ["fit-spline-3d", "3D fit spline", "fitSpline", "3d spline|curve through vertices", "Ordered vertices or mate connectors.", "Create a 3D curve through points with optional start/end tangency."],
  ["projected-curve", "Projected curve", "projectedCurve", "project sketches|curve on face", "Two sketches, or curves plus faces.", "Use two-sketch intersection projection or curve-to-face projection."],
  ["bridging-curve", "Bridging curve", "bridgingCurve", "connect two points|bridge curve", "Two endpoints with optional tangent/curvature references.", "Create a connecting curve and set magnitude plus G0/G1/G2 conditions at each end."],
  ["composite-curve", "Composite curve", "compositeCurve", "join curves|chain curve", "A connected edge/curve chain.", "Combine selected curves into one selectable path without changing shape."],
  ["intersection-curve", "Intersection curve", "intersectionCurve", "surface intersection curve", "Two intersecting face/surface sets.", "Create curves along the intersection of the selected sets."],
  ["trim-curve", "Trim curve", "trimCurve", "cut 3d curve", "Curves and trim references/parameters.", "Trim or split wire curves at chosen entities or parameters."],
  ["isocline", "Isocline", "isocline", "draft angle curve", "Faces, direction, and angle.", "Create curves where surface normals meet the specified angle to a direction."],
  ["offset-curve", "Offset curve", "offsetCurve", "offset edge on face", "Edges/curves, support face/direction, and distance.", "Create an offset with correct side, gap, and corner handling."],
  ["isoparametric-curve", "Isoparametric curve", "isoparametricCurve", "uv curve|surface parameter curve", "A face and U/V parameter.", "Create a curve along a constant surface parameter."],
  ["edit-curve", "Edit curve", "editCurve", "adjust 3d curve", "A supported curve and edit controls.", "Change curve control data while preserving intended endpoints and continuity."],
  ["routing-curve", "Routing curve", "routingCurve", "route|orthogonal path|tube path", "Start/end mate connectors and route controls.", "Create a routed path with appropriate bend radii and orientation for tubing/cabling." ]
]);

const patternTransforms = defineMany("pattern_transform", "part_studio", "native_feature", [
  ["linear-pattern", "Linear pattern", "linearPattern", "rectangular pattern|array", "Seed parts/features/faces, direction(s), counts, and spacing.", "Choose PART/FEATURE/FACE, one or two directions, equal spacing or total distance, skipped instances, and apply-per-instance behavior."],
  ["circular-pattern", "Circular pattern", "circularPattern", "polar pattern|radial array", "Seed entities, axis, count, and angle.", "Choose PART/FEATURE/FACE, full/equal/centered distribution, direction, skipped instances, and apply-per-instance behavior."],
  ["curve-pattern", "Curve pattern", "curvePattern", "pattern along path", "Seed entities and a path.", "Control count/spacing, orientation, start point, direction, skipped instances, and merge behavior."],
  ["mirror", "Mirror", "mirror", "reflect part|mirror feature|mirror face", "Seed entities and mirror plane or planar face.", "Choose PART/FEATURE/FACE and merge/add behavior; verify handed features and references."],
  ["transform", "Transform", "transform", "move copy rotate scale part", "Parts and transform definition.", "Translate by XYZ/entity, rotate about axis, map mate connectors, scale uniformly/nonuniformly where supported, or copy in place."],
  ["replicate", "Replicate", "replicate", "repeat part at mate connectors", "Seed parts and target mate connectors.", "Place copies at selected mate connectors while preserving orientation." ]
]);

const construction = defineMany("construction_reference", "part_studio", "native_feature", [
  ["plane", "Plane", "plane", "construction plane|offset plane|midplane", "Suitable planar/linear/point references.", "Use offset, point-normal, three-point, line-angle, midplane, or curve-point mode as dictated by references."],
  ["mate-connector-part-studio", "Mate connector", "mateConnector", "coordinate system|csys", "An origin entity and optional orientation references.", "Define origin, primary axis, secondary axis, offsets, and rotation for assembly and feature references."],
  ["variable", "Variable", "variable", "parameter|named dimension", "A valid name and unit-aware expression.", "Create variables before consumers and reference them as #name; keep units consistent."],
  ["query-variable", "Query variable", "queryVariable", "measured variable|entity query variable", "A named variable and entity query/evaluation.", "Store a query or measured result for downstream features."],
  ["configuration", "Part Studio configuration", "", "config|family of parts|variant", "Configuration inputs and target feature/property parameters.", "Create list, checkbox, or configuration-variable inputs and map them to dimensions, suppression, properties, or FeatureScript."],
  ["variable-table", "Variable table", "", "variables panel|parameter table", "Document or Part Studio variable definitions.", "Organize shared variables and expressions with clear names and units."],
  ["custom-table", "Custom table", "", "featurescript table", "An installed table type and valid query inputs.", "Evaluate read-only feature/BOM/inspection data without mutating geometry."],
  ["composite-reference", "Composite and reference geometry", "compositePart", "reference group", "Existing supported entities.", "Group geometry semantically when downstream selection or BOM behavior benefits." ]
]);

const sheetMetal = defineMany("sheet_metal", "part_studio", "native_feature", [
  ["sheet-metal-model", "Sheet metal model", "sheetMetalModel", "convert to sheet metal|sheet metal start", "A sketch, face, or thin solid plus thickness and bend rules.", "Create/convert/extrude a sheet-metal model with thickness, bend radius, K-factor, relief, and rip settings."],
  ["sheet-metal-flange", "Flange", "sheetMetalFlange", "edge flange", "Sheet-metal edges.", "Set wall alignment, length/end condition, angle, bend radius, relief, offsets, and corner behavior."],
  ["sheet-metal-hem", "Hem", "sheetMetalHem", "rolled edge|open hem|teardrop hem", "Sheet-metal edges/faces.", "Choose return/rolled/teardrop type, inside/outside alignment, length/radius, and corner treatment."],
  ["sheet-metal-tab", "Tab", "sheetMetalTab", "add sheet metal tab", "A sketch region and target sheet-metal wall.", "Add the region with merge scope and subtract/clearance behavior as required."],
  ["sheet-metal-bend", "Bend", "sheetMetalBend", "bend along line", "A sheet-metal model and bend-reference line.", "Set angle, direction, fixed side, alignment, radius, and relief."],
  ["sheet-metal-form", "Form", "sheetMetalForm", "louver|dimple|emboss sheet metal", "A form feature, placement sketch/points, and target wall.", "Place library/custom forms with orientation and flat-view representation."],
  ["sheet-metal-loft", "Sheet metal loft", "sheetMetalLoft", "lofted bend|transition duct", "Two compatible profiles.", "Create a developable faceted or bent transition with thickness and joint controls."],
  ["sheet-metal-joint", "Make joint", "sheetMetalJoint", "bend joint|rip joint", "Intersecting sheet-metal walls.", "Convert the wall intersection to bend or rip and select edge/butt style plus gap."],
  ["sheet-metal-corner", "Sheet metal corner", "sheetMetalCorner", "corner relief|closed corner", "Sheet-metal corners.", "Set corner type, overlap, gap, and relief for manufacturable flattening."],
  ["sheet-metal-corner-break", "Corner break", "sheetMetalCornerBreak", "sheet metal fillet|sheet metal chamfer", "Sheet-metal model edges.", "Apply a manufacturable fillet or chamfer without invalidating the flat pattern."],
  ["sheet-metal-bend-relief", "Bend relief", "sheetMetalBendRelief", "relief cut", "Sheet-metal bends/corners.", "Choose rectangular/obround/tear relief and size relative to thickness."],
  ["finish-sheet-metal", "Finish sheet metal model", "sheetMetalFinish", "finish sheet metal", "An active sheet-metal model.", "Finish editing while preserving flat-pattern validity." ]
]);

const frames = defineMany("frame", "part_studio", "native_feature", [
  ["frame", "Frame", "frame", "structural member|weldment|beam", "A path and frame profile.", "Place profile members along sketch/curve paths; control alignment, rotation, corners, and merged segments."],
  ["frame-trim", "Frame trim", "frameTrim", "miter frame|trim beam", "Intersecting frame members or trim faces.", "Use miter, butt, or trim-to-face behavior and choose which member continues."],
  ["frame-gusset", "Gusset", "gusset", "frame brace plate", "Frame members and placement references.", "Create a plate with thickness, offsets, chamfers, and weld clearances."],
  ["frame-end-cap", "End cap", "endCap", "cap tube|close frame end", "Frame end faces.", "Cap selected ends with thickness, inset/offset, and profile treatment."],
  ["cut-list", "Cut list", "", "frame cut list|weldment bom", "Frame/composite parts.", "Inspect member lengths, angles, profiles, and quantities after frame edits.", "Cut-list rows match the modeled members and no member is omitted." ]
]);

const assemblyMates = defineMany("assembly_mate", "assembly", "assembly_api", [
  ["fastened-mate", "Fastened mate", "fastenedMate", "rigid mate|lock parts together", "Two mate connectors.", "Remove all six relative degrees of freedom; apply offsets/orientation only when intended."],
  ["revolute-mate", "Revolute mate", "revoluteMate", "hinge|pin rotation", "Two coaxial mate connectors.", "Allow rotation about Z; set angular limits, offsets, and initial angle."],
  ["slider-mate", "Slider mate", "sliderMate", "linear slide|prismatic mate", "Two aligned mate connectors.", "Allow translation along Z; set linear limits and XY offsets."],
  ["planar-mate", "Planar mate", "planarMate", "face slide", "Two planar mate connectors.", "Allow X/Y translation and Z rotation; set Z offset and applicable limits."],
  ["cylindrical-mate", "Cylindrical mate", "cylindricalMate", "rotate and slide|shaft in bore", "Two coaxial mate connectors.", "Allow Z translation and Z rotation; apply limits deliberately."],
  ["pin-slot-mate", "Pin slot mate", "pinSlotMate", "pin in slot", "Pin and slot mate connectors.", "Allow translation along the slot and rotation; set travel limits and offset."],
  ["ball-mate", "Ball mate", "ballMate", "spherical joint", "Two mate connectors at the joint center.", "Allow three rotations and no translation."],
  ["parallel-mate", "Parallel mate", "parallelMate", "align axes parallel", "Two mate connectors.", "Constrain primary axes parallel while leaving intended translations/rotations free."],
  ["tangent-mate", "Tangent mate", "tangentMate", "cam contact|surface contact", "Compatible faces/edges.", "Maintain tangency between selected geometries; verify solution branch and motion."],
  ["width-mate", "Width mate", "widthMate", "center tab in slot", "Two width faces and two tab faces.", "Center or position a tab between width faces with optional ratio/offset."],
  ["group-mate", "Group", "group", "rigid group", "Assembly instances.", "Lock selected instances in their current relative positions without defining pairwise mates."],
  ["assembly-mate-connector", "Assembly mate connector", "mateConnector", "assembly coordinate system", "An assembly instance entity.", "Create an explicit connector when implicit connector locations are unstable or insufficient." ]
]);

const assemblyRelations = defineMany("assembly_relation", "assembly", "assembly_api", [
  ["gear-relation", "Gear relation", "gearRelation", "gears|rotation ratio", "Two revolute/cylindrical mate rotational DOFs.", "Couple rotations with signed ratio and direction."],
  ["rack-pinion-relation", "Rack and pinion relation", "rackAndPinionRelation", "rotation to translation", "A rotational mate and linear mate.", "Couple rotation to translation using pitch radius or distance per revolution."],
  ["screw-relation", "Screw relation", "screwRelation", "lead screw|helical motion", "Rotational and translational DOFs, often one cylindrical mate.", "Couple angle and travel using pitch/lead and handedness."],
  ["linear-relation", "Linear relation", "linearRelation", "couple sliders", "Two translational mate DOFs.", "Couple translations with signed ratio." ]
]);

const assemblyManagement = defineMany("assembly_management", "assembly", "assembly_api", [
  ["insert-instance", "Insert parts and assemblies", "", "insert component|add instance|standard content", "A source document/element/part/version and target assembly.", "Insert immutable/versioned references where appropriate and preserve configuration intent."],
  ["replace-instance", "Replace instance", "", "swap component", "An existing occurrence and replacement source.", "Replace while preserving compatible mates and configuration when possible."],
  ["replicate-assembly", "Replicate", "replicate", "copy instance to mate connectors", "Seed instance and target mate connectors.", "Replicate instances to connector locations and verify orientation."],
  ["assembly-linear-pattern", "Assembly linear pattern", "linearPattern", "component linear array", "Instances, direction, count, and spacing.", "Pattern occurrences with stable seed and spacing references."],
  ["assembly-circular-pattern", "Assembly circular pattern", "circularPattern", "component circular array", "Instances, axis, count, and angle.", "Pattern occurrences around a stable axis."],
  ["assembly-mirror", "Assembly mirror", "mirror", "mirror components", "Instances and mirror plane.", "Mirror occurrences and choose mirrored/derived parts versus reused instances deliberately."],
  ["fix-instance", "Fix instance", "", "ground component|lock instance", "An assembly instance.", "Fix only the foundational occurrence; mates define reusable design intent."],
  ["named-position", "Named position", "", "save assembly position", "A solved assembly position.", "Save mechanism states for repeatable review, drawings, or release."],
  ["display-state", "Display state", "", "visibility state|appearance state", "Assembly visibility/appearance choices.", "Capture display-only state separately from configuration and motion."],
  ["exploded-view", "Exploded view", "", "explosion|assembly disassembly", "Assembly instances and explode steps.", "Create ordered translation/rotation steps while retaining the assembled definition."],
  ["bill-of-materials", "Bill of materials", "", "bom|parts list", "Assembly occurrences and metadata.", "Inspect quantities, part numbers, descriptions, and excluded items; do not infer missing metadata."],
  ["assembly-simulation", "Assembly simulation", "", "motion simulation|modal simulation", "A sufficiently constrained assembly and study inputs.", "Validate mates/materials/loads and treat simulation setup/results as a separate workflow from geometry creation." ]
]);

const inspection = defineMany("inspection", "document", "read_only", [
  ["measure", "Measure", "", "distance|angle|area|length|clearance", "Selected geometry.", "Evaluate exact distances, angles, radii, areas, and positions before choosing dimensions."],
  ["mass-properties", "Mass properties", "", "mass|volume|centroid|inertia", "Parts with material/density where mass is required.", "Compare volume, mass, centroid, and inertia before/after edits; distinguish geometry from material assumptions."],
  ["feature-tree", "Feature and dependency inspection", "", "feature list|dependencies|regeneration", "A Part Studio.", "Read exact feature payloads, dependency graph, hashes, and regeneration states before edits."],
  ["feature-specs", "Live feature specifications", "", "available tools|feature schema|custom feature schema", "An authenticated Part Studio.", "Read exact current built-in and custom feature types and parameter definitions; prefer these over memory."],
  ["flat-pattern", "Sheet metal flat view", "", "unfold|flat pattern", "A valid sheet-metal model.", "Verify bends, rips, joints, and manufacturable flattened geometry after each sheet-metal change."],
  ["cut-list-inspection", "Frame cut-list inspection", "", "member lengths|cut angles", "Frame parts.", "Verify profile, length, end angles, and quantity after frame operations."],
  ["regeneration-errors", "Regeneration error inspection", "", "feature error|warning", "A feature mutation or existing Part Studio.", "Stop after any new ERROR/WARNING that invalidates the requested result; never bury failed features." ]
]);

const metadata = defineMany("metadata_configuration", "document", "native_feature", [
  ["rename-feature", "Rename feature", "", "rename tree item", "An exact feature ID and current name.", "Use the guarded typed rename operation and preserve the full payload."],
  ["update-dimension", "Update feature dimension", "", "change parameter|edit measurement", "An exact feature/parameter ID and current expression.", "Use the guarded typed dimension operation with unit-aware expression and snapshot match."],
  ["material", "Material", "", "assign material|density", "A part and known material library/custom properties.", "Set material only when specified or needed for mass calculations; do not invent engineering properties."],
  ["appearance", "Appearance", "", "color|transparency", "Parts or faces.", "Treat appearance as metadata unless color carries explicit design meaning."],
  ["part-properties", "Part properties", "", "part number|description|revision", "Parts and user-provided metadata.", "Set names, numbers, descriptions, vendor, and custom properties without fabricating business data."],
  ["configuration-properties", "Configured properties", "", "variant part number|configuration metadata", "A Part Studio configuration.", "Map property values to configuration inputs and verify each intended row."],
  ["suppress-feature", "Suppress or resume feature", "", "disable feature|enable feature", "An exact feature and configuration state.", "Use suppression for variants or debugging while preserving downstream dependency awareness."],
  ["delete-feature", "Delete feature", "", "remove feature", "An exact feature ID/name and explicit user request.", "Treat as destructive/high risk; inspect downstream dependents and require approval."],
  ["model-based-definition", "Model-based definition", "", "mfd|3d annotations|gdt", "Model faces/edges and engineering requirements.", "Create dimensions, datum references, and tolerances only from explicit engineering intent." ]
]);

const typedCapabilityIds = new Set(["corner-rectangle", "center-point-circle", "extrude", "fillet", "chamfer"]);

export const ONSHAPE_CAPABILITY_CATALOG: readonly OnshapeCapability[] = Object.freeze([
  ...sketchGeometry,
  ...sketchConstraints,
  ...sketchEditing,
  ...solidFeatures,
  ...surfaceFeatures,
  ...curveFeatures,
  ...patternTransforms,
  ...construction,
  ...sheetMetal,
  ...frames,
  ...assemblyMates,
  ...assemblyRelations,
  ...assemblyManagement,
  ...inspection,
  ...metadata
].map((capability) => typedCapabilityIds.has(capability.id) ? { ...capability, execution: "typed" as const } : capability));

export const ONSHAPE_CAPABILITY_CATALOG_VERSION = "2026-07-14";

const stopWords = new Set(["a", "an", "and", "as", "at", "be", "by", "do", "for", "from", "in", "into", "it", "make", "of", "on", "or", "the", "to", "use", "with"]);

function words(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length > 1 && !stopWords.has(word)));
}

const defaultCapabilityIds = new Set([
  "line", "corner-rectangle", "center-point-circle", "dimension", "coincident", "tangent",
  "extrude", "revolve", "sweep", "loft", "fillet", "chamfer", "hole", "shell", "draft",
  "boolean", "linear-pattern", "circular-pattern", "mirror", "transform", "plane", "variable",
  "measure", "mass-properties", "feature-specs", "regeneration-errors"
]);

export function selectOnshapeCapabilities(prompt: string, limit = 36): OnshapeCapability[] {
  const promptWords = words(prompt);
  const scored = ONSHAPE_CAPABILITY_CATALOG.map((capability, index) => {
    const haystack = words([capability.id, capability.name, ...capability.aliases, ...capability.featureTypes].join(" "));
    let score = defaultCapabilityIds.has(capability.id) ? 1 : 0;
    for (const word of promptWords) if (haystack.has(word)) score += 8;
    const exactPhrases = [capability.name, ...capability.aliases].map((value) => value.toLocaleLowerCase());
    if (exactPhrases.some((phrase) => phrase.length > 2 && prompt.toLocaleLowerCase().includes(phrase))) score += 20;
    if (/sketch|profile|2d/u.test(prompt.toLocaleLowerCase()) && capability.surface === "sketch") score += 3;
    if (/assembl|mate|mechanism/u.test(prompt.toLocaleLowerCase()) && capability.surface === "assembly") score += 5;
    if (/sheet.?metal|flange|bend/u.test(prompt.toLocaleLowerCase()) && capability.category === "sheet_metal") score += 5;
    if (/surface|patch|quilt/u.test(prompt.toLocaleLowerCase()) && capability.category === "surface_feature") score += 5;
    if (/frame|weldment|beam/u.test(prompt.toLocaleLowerCase()) && capability.category === "frame") score += 5;
    return { capability, score, index };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.capability);
}

export function capabilityCategoryCounts(): Record<CapabilityCategory, number> {
  const counts = {} as Record<CapabilityCategory, number>;
  for (const capability of ONSHAPE_CAPABILITY_CATALOG) {
    counts[capability.category] = (counts[capability.category] ?? 0) + 1;
  }
  return counts;
}

export function capabilityInventoryText(): string {
  const byCategory = new Map<CapabilityCategory, string[]>();
  for (const capability of ONSHAPE_CAPABILITY_CATALOG) {
    const entries = byCategory.get(capability.category) ?? [];
    entries.push(capability.name);
    byCategory.set(capability.category, entries);
  }
  return [...byCategory.entries()].map(([category, names]) => `${category}: ${names.join(", ")}`).join("\n");
}

export function capabilityCurriculumText(prompt: string): string {
  return selectOnshapeCapabilities(prompt).map((capability) => [
    `- ${capability.name} [${capability.surface}/${capability.execution}]`,
    `requires: ${capability.prerequisites}`,
    `method: ${capability.guidance}`,
    `verify: ${capability.verification}`,
    capability.featureTypes.length ? `featureTypes: ${capability.featureTypes.join(",")}` : ""
  ].filter(Boolean).join("; ")).join("\n");
}

function boundedClone(value: unknown, maximumLength: number): unknown | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= maximumLength ? value : undefined;
  } catch {
    return undefined;
  }
}

function featureSpecArray(response: unknown): Array<Record<string, unknown>> {
  if (!response || typeof response !== "object" || Array.isArray(response)) return [];
  const record = response as Record<string, unknown>;
  const candidates = [record.featureSpecs, record.features, record.specs];
  const array = candidates.find(Array.isArray) as unknown[] | undefined;
  return (array ?? []).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

export interface CompactFeatureSpecContext {
  availableFeatureTypes: Array<{ featureType: string; name?: string }>;
  relevantFeatureSpecs: unknown[];
}

export function compactFeatureSpecContext(
  response: unknown,
  capabilities: readonly OnshapeCapability[],
  maximumRelevantBytes = 100_000
): CompactFeatureSpecContext {
  const specs = featureSpecArray(response);
  const desired = new Set(capabilities.flatMap((capability) => capability.featureTypes).map((value) => value.toLocaleLowerCase()));
  const availableFeatureTypes = specs.flatMap((spec) => {
    const featureType = typeof spec.featureType === "string" ? spec.featureType : undefined;
    if (!featureType) return [];
    const name = [spec.featureName, spec.name, spec.displayName].find((value) => typeof value === "string") as string | undefined;
    return [{ featureType, ...(name ? { name } : {}) }];
  });
  const relevantFeatureSpecs: unknown[] = [];
  let budget = maximumRelevantBytes;
  for (const spec of specs) {
    const featureType = typeof spec.featureType === "string" ? spec.featureType : "";
    const displayName = [spec.featureName, spec.name, spec.displayName].find((value) => typeof value === "string") as string | undefined;
    const isRelevant = desired.has(featureType.toLocaleLowerCase()) ||
      (displayName ? capabilities.some((capability) => capability.name.toLocaleLowerCase() === displayName.toLocaleLowerCase()) : false);
    if (!isRelevant) continue;
    const candidate = boundedClone(spec, Math.min(30_000, budget));
    if (candidate === undefined) continue;
    const size = JSON.stringify(candidate).length;
    relevantFeatureSpecs.push(candidate);
    budget -= size;
    if (budget <= 0) break;
  }
  return { availableFeatureTypes, relevantFeatureSpecs };
}

export function assertCapabilityCatalogIntegrity(): void {
  const ids = new Set<string>();
  for (const capability of ONSHAPE_CAPABILITY_CATALOG) {
    if (ids.has(capability.id)) throw new Error(`Duplicate Onshape capability id: ${capability.id}`);
    ids.add(capability.id);
    if (!capability.name || !capability.prerequisites || !capability.guidance || !capability.verification) {
      throw new Error(`Incomplete Onshape capability: ${capability.id}`);
    }
  }
}
