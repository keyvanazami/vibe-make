import { NextRequest, NextResponse } from "next/server";
import { generateScad, type ChatTurn } from "@/lib/gemini";
import { scadTo } from "@/lib/openscad";
import { startLog, finishLog } from "@/lib/log";

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
  const log = startLog("generate");
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch (err) {
    finishLog(log, 400, err);
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.prompt || typeof body.prompt !== "string") {
    finishLog(log, 400);
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  // Record what we sent before going out to Gemini so the log is informative
  // even if the call hangs / times out at the platform level.
  log.meta.promptLen = body.prompt.length;
  log.meta.scadLen = body.currentScad?.length ?? 0;
  log.meta.historyTurns = body.history?.length ?? 0;
  log.meta.hasPreviewImage = !!body.previewImageBase64;
  log.meta.hasReferenceImage = !!body.referenceImageDataUrl;
  log.meta.model = process.env.GEMINI_MODEL || "gemini-3.5-flash";

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
    finishLog(log, 500, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Gemini call failed" },
      { status: 500 }
    );
  }

  log.meta.outputScadLen = scad.length;
  log.meta.tokensTotal = usage.totalTokens;
  log.meta.tokensPrompt = usage.promptTokens;
  log.meta.tokensOutput = usage.outputTokens;

  let stlBase64: string;
  try {
    const stl = await scadTo(scad, "stl");
    stlBase64 = stl.toString("base64");
  } catch (err) {
    log.meta.stage = "openscad-render";
    finishLog(log, 422, err);
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

  finishLog(log, 200);
  return NextResponse.json({ scad, stlBase64, usage });
}
