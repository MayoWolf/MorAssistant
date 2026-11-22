import type { CadOperation } from "@morassistant/cad-command-schema";

type Profile = Extract<CadOperation, { type: "create_rectangle_sketch" | "create_circle_sketch" | "create_text_sketch" }>;
type Extrude = Extract<CadOperation, { type: "extrude_sketch" }>;

function Shape({ profile, usage }: { profile: Profile; usage: "body" | "cut" | "raised" }) {
  if (profile.type === "create_text_sketch") {
    return <text className={`layout-lettering ${usage}`} x={profile.baselineXmm} y={-profile.baselineYmm}
      fontSize={profile.heightMm * 1.3}>{profile.text}</text>;
  }
  if (profile.type === "create_circle_sketch") {
    return <circle className={usage} vectorEffect="non-scaling-stroke" cx={profile.centerXmm} cy={-profile.centerYmm} r={profile.radiusMm} />;
  }
  return <rect className={usage} vectorEffect="non-scaling-stroke"
    x={profile.centerXmm - profile.widthMm / 2} y={-profile.centerYmm - profile.heightMm / 2}
    width={profile.widthMm} height={profile.heightMm} />;
}

/** Approximate composition sketch, shown only for supported, understandable flat layouts. */
export function FlatLayout({ operations }: { operations: CadOperation[] }) {
  const profiles = new Map<string, Profile>();
  const extrudes: Extrude[] = [];
  for (const operation of operations) {
    if ("sketchName" in operation && operation.plane === "Top") profiles.set(operation.sketchName.toLowerCase(), operation);
    else if (operation.type === "extrude_sketch" && !operation.symmetric && operation.operation !== "INTERSECT") extrudes.push(operation);
    else return null;
  }
  if (![...profiles.values()].some((profile) => profile.type === "create_text_sketch") ||
    extrudes.filter((extrude) => extrude.operation === "NEW").length !== 1 || extrudes[0]?.operation !== "NEW") return null;
  const base = profiles.get(extrudes[0].sourceFeatureName.toLowerCase());
  if (!base || base.type === "create_text_sketch") return null;
  const details = extrudes.slice(1).map((extrude) => ({
    profile: profiles.get(extrude.sourceFeatureName.toLowerCase()),
    usage: extrude.operation === "REMOVE" ? "cut" as const : "raised" as const
  }));
  if (details.some(({ profile, usage }) => !profile || (usage === "raised" && profile.type !== "create_text_sketch")) ||
    !details.some(({ profile }) => profile?.type === "create_text_sketch")) return null;
  const width = base.type === "create_circle_sketch" ? 2 * base.radiusMm : base.widthMm;
  const height = base.type === "create_circle_sketch" ? 2 * base.radiusMm : base.heightMm;
  const pad = 0.09 * Math.max(width, height);
  const viewBox = `${base.centerXmm - width / 2 - pad} ${-base.centerYmm - height / 2 - pad} ${width + 2 * pad} ${height + 2 * pad}`;
  return <figure className="flat-layout">
    <svg viewBox={viewBox} aria-label="Approximate layout of the proposed part, holes, and lettering" role="img">
      <Shape profile={base} usage="body" />
      {details.map(({ profile, usage }, index) => profile && <Shape key={index} profile={profile} usage={usage} />)}
    </svg>
    <figcaption>Proposed face layout · not a CAD render</figcaption>
  </figure>;
}
