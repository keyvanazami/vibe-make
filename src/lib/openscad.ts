import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mesh formats OpenSCAD can emit. STEP/IGES (true B-rep parametric) are not
// supported by OpenSCAD; for a CAD solid we convert the mesh via OpenCASCADE
// (see scadToStep), and the parametric source we offer is the .scad file.
export type ExportFormat = "stl" | "obj" | "3mf" | "amf" | "off";

function resolveBinary(): string {
  if (process.env.OPENSCAD_BIN && process.env.OPENSCAD_BIN.trim()) {
    return process.env.OPENSCAD_BIN.trim();
  }
  if (process.platform === "win32") {
    return "C:\\Program Files\\OpenSCAD\\openscad.exe";
  }
  return "openscad";
}

function resolvePython(): string {
  if (process.env.PYTHON_BIN && process.env.PYTHON_BIN.trim()) {
    return process.env.PYTHON_BIN.trim();
  }
  return process.platform === "win32" ? "python" : "python3";
}

// Run a child process, rejecting (with captured stderr) on non-zero exit.
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

export async function scadTo(scad: string, format: ExportFormat): Promise<Buffer> {
  const bin = resolveBinary();
  const dir = await mkdtemp(join(tmpdir(), "vibemake-"));
  const inputPath = join(dir, "model.scad");
  const outputPath = join(dir, `model.${format}`);

  try {
    await writeFile(inputPath, scad, "utf8");
    await run(bin, ["-o", outputPath, inputPath], "openscad");
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Render the SCAD to a mesh, then convert that mesh to a STEP B-rep solid via
// OpenCASCADE (Python/OCP). Coplanar faces are merged so the result is a clean
// editable solid body in CAD tools like Fusion 360 (not triangle soup).
export async function scadToStep(scad: string): Promise<Buffer> {
  const bin = resolveBinary();
  const py = resolvePython();
  const script = join(process.cwd(), "scripts", "stl_to_step.py");
  const dir = await mkdtemp(join(tmpdir(), "vibemake-"));
  const inputPath = join(dir, "model.scad");
  const stlPath = join(dir, "model.stl");
  const stepPath = join(dir, "model.step");

  // Raise the global facet count so curved surfaces tessellate finer before we
  // convert to a solid (flat faces still merge to clean faces; curves come out
  // much smoother). `-D` overrides the script's global $fn but leaves per-call
  // overrides — e.g. a hexagon's $fn=6 — alone. Tunable via STEP_FN.
  const fn = Number(process.env.STEP_FN) || 128;

  try {
    await writeFile(inputPath, scad, "utf8");
    await run(bin, ["-D", `$fn=${fn}`, "-o", stlPath, inputPath], "openscad");
    await run(py, [script, stlPath, stepPath], "STEP converter (python/OCP)");
    return await readFile(stepPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
