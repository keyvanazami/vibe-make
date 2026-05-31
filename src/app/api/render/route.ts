import { NextRequest, NextResponse } from "next/server";
import { scadTo } from "@/lib/openscad";
import { startLog, finishLog } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const log = startLog("render");
  let body: { scad?: string };
  try {
    body = (await req.json()) as { scad?: string };
  } catch (err) {
    finishLog(log, 400, err);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.scad || typeof body.scad !== "string") {
    finishLog(log, 400);
    return NextResponse.json({ error: "scad is required" }, { status: 400 });
  }

  log.meta.scadLen = body.scad.length;

  try {
    const stl = await scadTo(body.scad, "stl");
    log.meta.stlBytes = stl.length;
    finishLog(log, 200);
    return NextResponse.json({ stlBase64: stl.toString("base64") });
  } catch (err) {
    finishLog(log, 422, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "openscad failed" },
      { status: 422 }
    );
  }
}
