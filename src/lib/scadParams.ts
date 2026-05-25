// Extracts top-level editable variable assignments from an OpenSCAD script so
// the UI can expose them as directly-editable dimensional parameters. This
// mirrors OpenSCAD's "Customizer" convention: plain `name = <number>;` (or a
// numeric vector `name = [a, b, c];`) at the top level of the file is a knob the
// user is meant to tweak.

export type ParamUnit = "length" | "angle" | "count";

export type ScadParam = {
  name: string;
  label: string; // trailing-comment description, or a humanized version of the name
  line: number; // 0-based line index in the source
  value: number[]; // length 1 = scalar; length > 1 = vector
  isVector: boolean;
  unit: ParamUnit; // inferred so the UI only converts lengths between mm/inch
};

// Guess whether a parameter is a length (mm), an angle (deg), or a plain count
// from its name and comment, so a mm/inch toggle only touches actual lengths.
function inferUnit(name: string, label: string): ParamUnit {
  const s = `${name} ${label}`.toLowerCase();
  if (/(angle|degree|\bdeg\b|tilt|lean|slope|rotation|rotate|twist|bevel angle)/.test(s)) {
    return "angle";
  }
  if (/(count|qty|quantity|number of|num[_ ]|[_ ]num\b|sides|segments|teeth|spokes|columns|rows|copies|divisions)/.test(s)) {
    return "count";
  }
  return "length";
}

// Matched against the comment-stripped line, so they end right after the `;`.
const SCALAR_RE = /^(\s*)(\$?[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;\s*$/;
const VECTOR_RE =
  /^(\s*)(\$?[A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[\s*(-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)*)\s*\]\s*;\s*$/;

// Special variables control render quality/view, not dimensions — hide them.
const SPECIAL = new Set(["$fn", "$fa", "$fs", "$t", "$vpr", "$vpt", "$vpd", "$vpf"]);

// Strip // line comments and /* */ block comments from a single line, carrying
// block-comment state across lines. Returns the code-only text plus whether we
// end the line still inside a block comment.
function stripComments(line: string, inBlock: boolean): { code: string; inBlock: boolean } {
  let out = "";
  let block = inBlock;
  let i = 0;
  while (i < line.length) {
    if (block) {
      const end = line.indexOf("*/", i);
      if (end === -1) return { code: out, inBlock: true };
      block = false;
      i = end + 2;
    } else if (line[i] === "/" && line[i + 1] === "/") {
      break; // rest of the line is a comment
    } else if (line[i] === "/" && line[i + 1] === "*") {
      block = true;
      i += 2;
    } else {
      out += line[i];
      i += 1;
    }
  }
  return { code: out, inBlock: block };
}

function humanize(name: string): string {
  return name
    .replace(/^\$/, "")
    .replace(/_+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function labelFor(rawLine: string, name: string): string {
  const idx = rawLine.indexOf("//");
  if (idx >= 0) {
    const t = rawLine.slice(idx + 2).trim();
    if (t) return t;
  }
  return humanize(name);
}

export function parseScadParams(scad: string): ScadParam[] {
  const lines = scad.split("\n");
  const params: ScadParam[] = [];
  const seen = new Set<string>();
  let depth = 0;
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const startedInBlock = inBlock;
    const { code, inBlock: nextBlock } = stripComments(lines[i], inBlock);

    if (!startedInBlock && depth === 0) {
      const sc = code.match(SCALAR_RE);
      const ve = sc ? null : code.match(VECTOR_RE);
      const m = sc ?? ve;
      if (m) {
        const name = m[2];
        if (!SPECIAL.has(name) && !seen.has(name)) {
          seen.add(name);
          const isVector = !!ve;
          const value = isVector
            ? ve![3].split(",").map((x) => parseFloat(x.trim()))
            : [parseFloat(sc![3])];
          const label = labelFor(lines[i], name);
          params.push({ name, label, line: i, value, isVector, unit: inferUnit(name, label) });
        }
      }
    }

    // Track brace depth on the comment-stripped code only.
    for (const ch of code) {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
    inBlock = nextBlock;
  }

  return params;
}

function formatNum(n: number): string {
  return String(n);
}

// Returns a new SCAD string with the given parameters' values replaced. Only
// lines that parseScadParams identified as params are touched; the trailing
// comment and indentation are preserved.
export function applyScadParams(
  scad: string,
  values: Record<string, number | number[]>
): string {
  const lines = scad.split("\n");
  const byLine = new Map<number, ScadParam>();
  for (const p of parseScadParams(scad)) byLine.set(p.line, p);

  for (let i = 0; i < lines.length; i++) {
    const p = byLine.get(i);
    if (!p || !(p.name in values)) continue;
    const v = values[p.name];

    let valStr: string;
    if (Array.isArray(v)) {
      if (!v.every(Number.isFinite)) continue;
      valStr = `[${v.map(formatNum).join(", ")}]`;
    } else {
      if (!Number.isFinite(v)) continue;
      valStr = formatNum(v);
    }

    const raw = lines[i];
    const ws = (raw.match(/^(\s*)/) ?? ["", ""])[1];
    const cIdx = raw.indexOf("//");
    const comment = cIdx >= 0 ? "  " + raw.slice(cIdx) : "";
    lines[i] = `${ws}${p.name} = ${valStr};${comment}`;
  }

  return lines.join("\n");
}
