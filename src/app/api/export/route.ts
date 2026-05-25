import { NextRequest, NextResponse } from "next/server";
import { scadTo, scadToStep, type ExportFormat } from "@/lib/openscad";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = { scad?: string; format?: string; filename?: string };

const ALLOWED: ExportFormat[] = ["stl", "obj", "3mf", "amf", "off"];

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.scad || typeof body.scad !== "string") {
    return NextResponse.json({ error: "scad is required" }, { status: 400 });
  }

  const format = (body.format ?? "stl").toLowerCase();
  const baseName = (body.filename ?? "model").replace(/[^a-z0-9_-]+/gi, "_") || "model";

  if (format === "scad") {
    return new NextResponse(body.scad, {
      status: 200,
      headers: {
        "Content-Type": "application/x-openscad",
        "Content-Disposition": `attachment; filename="${baseName}.scad"`,
      },
    });
  }

  // STEP solid (B-rep) via OpenCASCADE — a separate, slower pipeline.
  if (format === "step") {
    try {
      const bytes = await scadToStep(body.scad);
      return new NextResponse(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "Content-Type": "application/step",
          "Content-Disposition": `attachment; filename="${baseName}.step"`,
        },
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "STEP conversion failed" },
        { status: 422 }
      );
    }
  }

  if (!ALLOWED.includes(format as ExportFormat)) {
    return NextResponse.json(
      { error: `format must be one of: ${ALLOWED.join(", ")}, scad` },
      { status: 400 }
    );
  }

  try {
    const bytes = await scadTo(body.scad, format as ExportFormat);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${baseName}.${format}"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "openscad failed" },
      { status: 422 }
    );
  }
}
