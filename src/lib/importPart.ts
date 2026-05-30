// Convert an uploaded STL or STEP file into a SCAD wrapper script.
//
// The mesh becomes an opaque `module base() { polyhedron(...); }` and the
// editable portion below is where the user (and the LLM) bolt on new features
// via union / difference. This lets the rest of the app keep treating "the
// SCAD is the source of truth" — the imported mesh travels inside the SCAD,
// no per-project server-side asset storage required.

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Mesh = { points: number[][]; faces: number[][] };

export type ImportFormat = "stl" | "step";

// --- STL parsing -----------------------------------------------------------

// Binary STL: 80-byte header, uint32 triangle count, then 50 bytes per
// triangle (3 floats normal + 3×3 floats vertices + 2 byte attribute).
function isBinaryStl(buf: Buffer): boolean {
  if (buf.length < 84) return false;
  const n = buf.readUInt32LE(80);
  return buf.length === 84 + n * 50;
}

function parseBinaryStl(buf: Buffer): Mesh {
  const n = buf.readUInt32LE(80);
  const points: number[][] = [];
  const faces: number[][] = [];
  const map = new Map<string, number>();
  let off = 84;
  for (let i = 0; i < n; i++) {
    off += 12; // skip face normal — we recompute via vertex order
    const tri: number[] = [];
    for (let v = 0; v < 3; v++) {
      const x = buf.readFloatLE(off); off += 4;
      const y = buf.readFloatLE(off); off += 4;
      const z = buf.readFloatLE(off); off += 4;
      // Quantise to ~1µm to merge identical shared vertices despite float noise.
      const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
      let id = map.get(key);
      if (id === undefined) {
        id = points.length;
        map.set(key, id);
        points.push([x, y, z]);
      }
      tri.push(id);
    }
    off += 2; // attribute byte count
    if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) {
      faces.push(tri);
    }
  }
  return { points, faces };
}

function parseAsciiStl(text: string): Mesh {
  const points: number[][] = [];
  const faces: number[][] = [];
  const map = new Map<string, number>();
  const vertexRe = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const triBuf: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = vertexRe.exec(text))) {
    const x = parseFloat(m[1]), y = parseFloat(m[2]), z = parseFloat(m[3]);
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = points.length;
      map.set(key, id);
      points.push([x, y, z]);
    }
    triBuf.push(id);
    if (triBuf.length === 3) {
      if (triBuf[0] !== triBuf[1] && triBuf[1] !== triBuf[2] && triBuf[0] !== triBuf[2]) {
        faces.push([triBuf[0], triBuf[1], triBuf[2]]);
      }
      triBuf.length = 0;
    }
  }
  return { points, faces };
}

export function parseStl(buf: Buffer): Mesh {
  if (isBinaryStl(buf)) return parseBinaryStl(buf);
  return parseAsciiStl(buf.toString("utf8"));
}

// --- STEP via OCP ---------------------------------------------------------

function resolvePython(): string {
  if (process.env.PYTHON_BIN && process.env.PYTHON_BIN.trim()) {
    return process.env.PYTHON_BIN.trim();
  }
  return process.platform === "win32" ? "python" : "python3";
}

function run(bin: string, args: string[], label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", (err) => reject(new Error(`Failed to run ${label} at "${bin}": ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}\n${stderr.trim()}`));
    });
  });
}

export async function stepToMesh(stepBytes: Buffer): Promise<Mesh> {
  const py = resolvePython();
  const script = join(process.cwd(), "scripts", "step_to_mesh.py");
  const defl = Number(process.env.STEP_IMPORT_DEFL) || 0.1;
  const dir = await mkdtemp(join(tmpdir(), "vibemake-import-"));
  const stepPath = join(dir, "in.step");
  const jsonPath = join(dir, "out.json");
  try {
    await writeFile(stepPath, stepBytes);
    await run(py, [script, stepPath, jsonPath, String(defl)], "STEP importer (python/OCP)");
    const raw = await readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as Mesh;
    return parsed;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- SCAD wrapper ---------------------------------------------------------

// SCAD's polyhedron() takes flat arrays. We use 4-decimal precision: enough
// for sub-micron fidelity at mm scale, and ~half the file size of a naive
// `JSON.stringify`. Numbers like 1.0000 collapse to 1, and we strip the
// trailing-decimal cruft to keep the SCAD readable.
function fmtNum(n: number): string {
  const s = n.toFixed(4);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function fmtPoints(points: number[][]): string {
  return points.map(([x, y, z]) => `[${fmtNum(x)},${fmtNum(y)},${fmtNum(z)}]`).join(",");
}

function fmtFaces(faces: number[][]): string {
  return faces.map(([a, b, c]) => `[${a},${b},${c}]`).join(",");
}

export function buildBaseScad(mesh: Mesh, source: { name: string; format: ImportFormat }): string {
  const triCount = mesh.faces.length;
  const ptCount = mesh.points.length;
  // Center on origin so the imported part lands somewhere sensible in the
  // OpenSCAD scene regardless of its original coordinate system.
  const bb = boundingBox(mesh.points);
  const cx = (bb.min[0] + bb.max[0]) / 2;
  const cy = (bb.min[1] + bb.max[1]) / 2;
  const cz = bb.min[2]; // sit flat on XY plane
  const shifted = mesh.points.map(([x, y, z]) => [x - cx, y - cy, z - cz]);

  return [
    `// Imported base: "${source.name}" (${source.format.toUpperCase()}, ${triCount} tris, ${ptCount} verts)`,
    `// The mesh below is opaque geometry — edit only the "Modifications" block.`,
    `// To reshape the base, re-import the source file.`,
    ``,
    `$fn = 64;`,
    ``,
    `// ===== BEGIN IMPORTED BASE (do not edit) =====`,
    `module base() {`,
    `  polyhedron(`,
    `    points=[${fmtPoints(shifted)}],`,
    `    faces=[${fmtFaces(mesh.faces)}],`,
    `    convexity=10`,
    `  );`,
    `}`,
    `// ===== END IMPORTED BASE =====`,
    ``,
    `// ----- Modifications -----`,
    `// Add or subtract features around base(). Examples:`,
    `//   difference() { base(); translate([0,0,5]) cylinder(h=20, d=6); }`,
    `//   union()      { base(); translate([0,0,bb_top]) cylinder(h=10, d=8); }`,
    `base();`,
    ``,
  ].join("\n");
}

function boundingBox(points: number[][]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of points) {
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  }
  return { min, max };
}
