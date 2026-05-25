import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ExportFormat = "stl" | "obj";

function resolveBinary(): string {
  if (process.env.OPENSCAD_BIN && process.env.OPENSCAD_BIN.trim()) {
    return process.env.OPENSCAD_BIN.trim();
  }
  if (process.platform === "win32") {
    return "C:\\Program Files\\OpenSCAD\\openscad.exe";
  }
  return "openscad";
}

export async function scadTo(scad: string, format: ExportFormat): Promise<Buffer> {
  const bin = resolveBinary();
  const dir = await mkdtemp(join(tmpdir(), "vibemake-"));
  const inputPath = join(dir, "model.scad");
  const outputPath = join(dir, `model.${format}`);

  try {
    await writeFile(inputPath, scad, "utf8");

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(bin, ["-o", outputPath, inputPath], { windowsHide: true });
      let stderr = "";
      proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      proc.on("error", (err) => reject(new Error(`Failed to run openscad at "${bin}": ${err.message}`)));
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`openscad exited with code ${code}\n${stderr.trim()}`));
      });
    });

    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
