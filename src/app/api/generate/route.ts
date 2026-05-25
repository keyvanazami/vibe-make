import { NextRequest, NextResponse } from "next/server";
import { generateScad, type ChatTurn } from "@/lib/gemini";
import { scadTo } from "@/lib/openscad";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  prompt: string;
  currentScad?: string | null;
  previewImageBase64?: string | null;
  history?: ChatTurn[];
};

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.prompt || typeof body.prompt !== "string") {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  let scad: string;
  try {
    scad = await generateScad({
      prompt: body.prompt,
      currentScad: body.currentScad ?? null,
      previewImageBase64: body.previewImageBase64 ?? null,
      history: body.history ?? [],
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Gemini call failed" },
      { status: 500 }
    );
  }

  let stlBase64: string;
  try {
    const stl = await scadTo(scad, "stl");
    stlBase64 = stl.toString("base64");
  } catch (err) {
    return NextResponse.json(
      {
        scad,
        error:
          "OpenSCAD failed to render the generated script. The SCAD code is returned so you can inspect it.\n\n" +
          (err instanceof Error ? err.message : String(err)),
      },
      { status: 422 }
    );
  }

  return NextResponse.json({ scad, stlBase64 });
}
