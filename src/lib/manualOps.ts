// Manual, LLM-free geometry tweaks. Each op wraps the entire current SCAD in a
// uniquely-named module and applies a CSG/transform operation to that module
// call, producing a new self-contained script that re-renders locally.
//
// Top-level parameter declarations are hoisted out of the wrapper so they stay
// global (the wrapped body still references them) and the Parameters panel keeps
// working after manual edits.

import { parseScadParams } from "@/lib/scadParams";

export type ManualOpId =
  | "add_box"
  | "cut_box"
  | "add_cyl"
  | "cut_cyl"
  | "scale"
  | "move"
  | "rotate"
  | "mirror";

export type FieldDef = { key: string; label: string; default: number };

export type ManualOp = {
  id: ManualOpId;
  label: string;
  hint: string;
  fields: FieldDef[];
  /** Whether the op has a position (px,py,pz) that can be prefilled from a pick. */
  positional: boolean;
  /**
   * Builds the SCAD expression that consumes the wrapped module `name`. `t` is
   * an optional transform (e.g. a `rotate(...)`) inserted just before the tool
   * primitive so positional ops can be aligned to a picked surface normal.
   */
  build: (name: string, f: Record<string, number>, t: string) => string;
};

const POS: FieldDef[] = [
  { key: "px", label: "Pos X", default: 0 },
  { key: "py", label: "Pos Y", default: 0 },
  { key: "pz", label: "Pos Z", default: 0 },
];
const SIZE: FieldDef[] = [
  { key: "sx", label: "Size X", default: 10 },
  { key: "sy", label: "Size Y", default: 10 },
  { key: "sz", label: "Size Z", default: 10 },
];

export const MANUAL_OPS: ManualOp[] = [
  {
    id: "add_box",
    label: "Add box",
    hint: "Union a rectangular block onto the model.",
    fields: [...SIZE, ...POS],
    positional: true,
    build: (n, f, t) =>
      `union() {\n  ${n}();\n  translate([${f.px}, ${f.py}, ${f.pz}]) ${t}cube([${f.sx}, ${f.sy}, ${f.sz}], center = true);\n}`,
  },
  {
    id: "cut_box",
    label: "Cut box",
    hint: "Subtract a rectangular block (remove material).",
    fields: [...SIZE, ...POS],
    positional: true,
    build: (n, f, t) =>
      `difference() {\n  ${n}();\n  translate([${f.px}, ${f.py}, ${f.pz}]) ${t}cube([${f.sx}, ${f.sy}, ${f.sz}], center = true);\n}`,
  },
  {
    id: "add_cyl",
    label: "Add cylinder",
    hint: "Union a cylinder / peg / boss.",
    fields: [
      { key: "d", label: "Diameter", default: 10 },
      { key: "h", label: "Height", default: 20 },
      ...POS,
    ],
    positional: true,
    build: (n, f, t) =>
      `union() {\n  ${n}();\n  translate([${f.px}, ${f.py}, ${f.pz}]) ${t}cylinder(h = ${f.h}, d = ${f.d}, center = true, $fn = 64);\n}`,
  },
  {
    id: "cut_cyl",
    label: "Drill hole",
    hint: "Subtract a cylinder (bore a hole).",
    fields: [
      { key: "d", label: "Diameter", default: 6 },
      { key: "h", label: "Depth", default: 40 },
      ...POS,
    ],
    positional: true,
    build: (n, f, t) =>
      `difference() {\n  ${n}();\n  translate([${f.px}, ${f.py}, ${f.pz}]) ${t}cylinder(h = ${f.h}, d = ${f.d}, center = true, $fn = 64);\n}`,
  },
  {
    id: "scale",
    label: "Scale",
    hint: "Scale the whole model (1 = unchanged).",
    fields: [
      { key: "sx", label: "Scale X", default: 1 },
      { key: "sy", label: "Scale Y", default: 1 },
      { key: "sz", label: "Scale Z", default: 1 },
    ],
    positional: false,
    build: (n, f) => `scale([${f.sx}, ${f.sy}, ${f.sz}]) ${n}();`,
  },
  {
    id: "move",
    label: "Move",
    hint: "Translate the whole model.",
    fields: [...POS],
    positional: false,
    build: (n, f) => `translate([${f.px}, ${f.py}, ${f.pz}]) ${n}();`,
  },
  {
    id: "rotate",
    label: "Rotate",
    hint: "Rotate the whole model (degrees).",
    fields: [
      { key: "rx", label: "Rot X°", default: 0 },
      { key: "ry", label: "Rot Y°", default: 0 },
      { key: "rz", label: "Rot Z°", default: 0 },
    ],
    positional: false,
    build: (n, f) => `rotate([${f.rx}, ${f.ry}, ${f.rz}]) ${n}();`,
  },
  {
    id: "mirror",
    label: "Mirror",
    hint: "Mirror across a plane (1 = on for that axis).",
    fields: [
      { key: "mx", label: "Axis X", default: 1 },
      { key: "my", label: "Axis Y", default: 0 },
      { key: "mz", label: "Axis Z", default: 0 },
    ],
    positional: false,
    build: (n, f) => `mirror([${f.mx}, ${f.my}, ${f.mz}]) ${n}();`,
  },
];

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

// SCAD `rotate(...)` that maps the primitive's +Z axis onto the given normal,
// so a drilled hole / peg points into/out of a picked surface.
function alignZTo(n: [number, number, number]): string {
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const [x, y, z] = [n[0] / len, n[1] / len, n[2] / len];
  const dot = Math.max(-1, Math.min(1, z)); // dot of [0,0,1] and the normal
  const angle = (Math.acos(dot) * 180) / Math.PI;
  // axis = cross([0,0,1], n) = [-y, x, 0]
  const ax = -y, ay = x;
  if (Math.hypot(ax, ay) < 1e-6) {
    return dot >= 0 ? "" : "rotate(a = 180, v = [1, 0, 0]) ";
  }
  return `rotate(a = ${r4(angle)}, v = [${r4(ax)}, ${r4(ay)}, 0]) `;
}

function nextIndex(scad: string): number {
  let max = 0;
  const re = /vibe_make_model_(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scad))) max = Math.max(max, parseInt(m[1], 10));
  return max + 1;
}

export function buildManualScad(
  currentScad: string,
  op: ManualOp,
  f: Record<string, number>,
  orientNormal?: [number, number, number] | null
): string {
  const name = `vibe_make_model_${nextIndex(currentScad)}`;
  const paramLines = new Set(parseScadParams(currentScad).map((p) => p.line));
  const all = currentScad.split("\n");

  // Keep top-level params global so the panel still sees them; wrap the rest.
  const head = all.filter((_, i) => paramLines.has(i));
  const body = all
    .filter((_, i) => !paramLines.has(i))
    .map((l) => (l.length ? "    " + l : l))
    .join("\n");

  const t = op.positional && orientNormal ? alignZTo(orientNormal) : "";
  const headStr = head.length ? head.join("\n") + "\n\n" : "";
  return `${headStr}module ${name}() {\n${body}\n}\n\n// manual edit: ${op.label}\n${op.build(name, f, t)}\n`;
}
