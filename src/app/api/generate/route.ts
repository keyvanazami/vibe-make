import { NextRequest, NextResponse } from "next/server";
import { generateScad, type ChatTurn } from "@/lib/gemini";
import { scadTo } from "@/lib/openscad";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  prompt: string;
  currentScad?: string | null;
  previewImageBase64?: string | null;
  referenceImageDataUrl?: string | null;
  history?: ChatTurn[];
};

// Split a "data:<mime>;base64,<data>" URL into the parts Gemini's API expects.
function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

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
  let usage;
  try {
    ({ scad, usage } = await generateScad({
      prompt: body.prompt,
      currentScad: body.currentScad ?? null,
      previewImageBase64: body.previewImageBase64 ?? null,
      referenceImage: body.referenceImageDataUrl ? parseDataUrl(body.referenceImageDataUrl) : null,
      history: body.history ?? [],
    }));
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
    // Tokens were already spent, so report usage even on render failure.
    return NextResponse.json(
      {
        scad,
        usage,
        error:
          "OpenSCAD failed to render the generated script. The SCAD code is returned so you can inspect it.\n\n" +
          (err instanceof Error ? err.message : String(err)),
      },
      { status: 422 }
    );
  }

  return NextResponse.json({ scad, stlBase64, usage });
}
