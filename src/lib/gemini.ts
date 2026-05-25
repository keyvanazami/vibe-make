import { GoogleGenAI } from "@google/genai";

export type ChatTurn = {
  role: "user" | "assistant";
  text: string;
};

const SYSTEM_PROMPT = `You are an expert in OpenSCAD, the parametric solid-modeling language used for 3D printable objects.

Your job: turn the user's natural-language description into a single complete OpenSCAD script that builds the requested object.

Rules:
- Output ONLY raw OpenSCAD code. No markdown fences, no commentary, no explanation. The first character of your reply must be valid SCAD.
- The script must be self-contained and renderable as-is by the openscad CLI.
- Prefer parametric design: declare variables at the top (with sensible defaults in millimeters) so the user could tweak dimensions later.
- Use sensible defaults: $fn = 64 for smooth curves, dimensions in mm, object centered near the origin and sitting on (or near) the XY plane.
- When the user asks for an enhancement, MODIFY the existing script rather than rewriting from scratch — preserve their parameters and intent.
- If the user supplies an image of the current render, treat it as ground truth for what the model currently looks like; their next instruction is relative to that image.
- Never use external libraries (no use<>/include<>). Stick to built-in OpenSCAD primitives and operations.
`;

let _client: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (!_client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Add it to .env.local.");
    _client = new GoogleGenAI({ apiKey });
  }
  return _client;
}

function stripCodeFences(text: string): string {
  let t = text.trim();
  const fence = /^```(?:openscad|scad|cpp|c)?\s*\n([\s\S]*?)\n```\s*$/i;
  const m = t.match(fence);
  if (m) t = m[1];
  return t.trim();
}

export async function generateScad(opts: {
  prompt: string;
  currentScad: string | null;
  previewImageBase64: string | null;
  history: ChatTurn[];
  model?: string;
}): Promise<string> {
  const model = opts.model || process.env.GEMINI_MODEL || "gemini-3.5-flash";

  const contents: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> = [];

  for (const turn of opts.history) {
    contents.push({
      role: turn.role === "assistant" ? "model" : "user",
      parts: [{ text: turn.text }],
    });
  }

  const parts: Array<Record<string, unknown>> = [];
  if (opts.currentScad) {
    parts.push({
      text: `Current OpenSCAD script:\n\n${opts.currentScad}\n\nThe user wants to modify it as follows:`,
    });
  }
  if (opts.previewImageBase64) {
    parts.push({
      inlineData: { mimeType: "image/png", data: opts.previewImageBase64 },
    });
    parts.push({ text: "(Above is a screenshot of the current 3D render.)" });
  }
  parts.push({ text: opts.prompt });

  contents.push({ role: "user", parts });

  const response = await client().models.generateContent({
    model,
    contents,
    config: { systemInstruction: SYSTEM_PROMPT, temperature: 0.4 },
  });

  const text = response.text ?? "";
  if (!text.trim()) throw new Error("Gemini returned an empty response.");
  return stripCodeFences(text);
}
