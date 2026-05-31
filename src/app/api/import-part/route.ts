import { NextRequest, NextResponse } from "next/server";
import { parseStl, stepToMesh, buildBaseScad, type ImportFormat } from "@/lib/importPart";
import { scadTo } from "@/lib/openscad";
import { startLog, finishLog } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60;

// Embedding a triangle mesh as a polyhedron literal scales with face count
// (every triangle becomes ~15 chars of SCAD text). Past ~50k triangles the
// SCAD string starts to push localStorage limits and OpenSCAD slows down
// noticeably, so refuse early with a clear message rather than producing a
// project the user can't iterate on.
const MAX_TRIS = 50_000;

export async function POST(req: NextRequest) {
  const log = startLog("import-part");
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    finishLog(log, 400, err);
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    finishLog(log, 400);
    return NextResponse.json({ error: "file field is required" }, { status: 400 });
  }

  const name = file.name || "imported";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  log.meta.filename = name;
  log.meta.fileBytes = file.size;
  let format: ImportFormat;
  if (ext === "stl") format = "stl";
  else if (ext === "step" || ext === "stp") format = "step";
  else {
    finishLog(log, 400);
    return NextResponse.json(
      { error: `Unsupported extension ".${ext}". Use .stl, .step, or .stp.` },
      { status: 400 }
    );
  }
  log.meta.format = format;

  const bytes = Buffer.from(await file.arrayBuffer());

  let mesh;
  try {
    log.meta.stage = format === "stl" ? "parse-stl" : "tessellate-step";
    mesh = format === "stl" ? parseStl(bytes) : await stepToMesh(bytes);
  } catch (err) {
    finishLog(log, 422, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read uploaded file" },
      { status: 422 }
    );
  }

  log.meta.triCount = mesh.faces.length;
  log.meta.pointCount = mesh.points.length;

  if (mesh.faces.length === 0) {
    finishLog(log, 422);
    return NextResponse.json({ error: "The uploaded file contained no triangles." }, { status: 422 });
  }
  if (mesh.faces.length > MAX_TRIS) {
    finishLog(log, 413);
    return NextResponse.json(
      {
        error:
          `That model has ${mesh.faces.length.toLocaleString()} triangles, ` +
          `which is more than the ${MAX_TRIS.toLocaleString()} budget for an embedded base. ` +
          `Decimate the mesh in the source tool (or re-export STEP with a coarser tessellation) and try again.`,
      },
      { status: 413 }
    );
  }

  const baseName = name.replace(/\.[^.]+$/, "");
  const scad = buildBaseScad(mesh, { name, format });
  log.meta.scadLen = scad.length;

  // Render the wrapper so the user immediately sees the imported part in the
  // viewer. If OpenSCAD chokes on the polyhedron we still return the SCAD so
  // the user can inspect it.
  let stlBase64: string | null = null;
  try {
    log.meta.stage = "openscad-render";
    const stl = await scadTo(scad, "stl");
    stlBase64 = stl.toString("base64");
  } catch (err) {
    finishLog(log, 422, err);
    return NextResponse.json(
      {
        scad,
        name: baseName,
        triCount: mesh.faces.length,
        error:
          "Imported the file but OpenSCAD failed to render the polyhedron wrapper.\n\n" +
          (err instanceof Error ? err.message : String(err)),
      },
      { status: 422 }
    );
  }

  finishLog(log, 200);
  return NextResponse.json({
    scad,
    stlBase64,
    name: baseName,
    triCount: mesh.faces.length,
    pointCount: mesh.points.length,
  });
}
