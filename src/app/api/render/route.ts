import { NextRequest, NextResponse } from "next/server";
import { scadTo } from "@/lib/openscad";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { scad?: string };
  try {
    body = (await req.json()) as { scad?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.scad || typeof body.scad !== "string") {
    return NextResponse.json({ error: "scad is required" }, { status: 400 });
  }

  try {
    const stl = await scadTo(body.scad, "stl");
    return NextResponse.json({ stlBase64: stl.toString("base64") });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "openscad failed" },
      { status: 422 }
    );
  }
}
