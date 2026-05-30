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
- FULLY PARAMETRIC, NO EXCEPTIONS. Every dimension that defines the object's size or shape MUST be a named variable declared at the very top of the file, before any geometry or module. This includes every dimension the user explicitly mentions (e.g. "80mm tall", "3mm walls") AND every other size, thickness, count, radius, angle, or clearance the design needs.
  - NEVER put a raw dimensional number (a "magic number") inside a primitive or transform. Write \`cylinder(h = height, d = inner_diameter)\`, never \`cylinder(h = 80, d = 40)\`. Write \`translate([0, 0, base_thickness])\`, never \`translate([0, 0, 4])\`.
  - Give each parameter a clear snake_case name and a trailing comment describing it with units, e.g. \`height = 80;            // total height (mm)\`. The UI surfaces these top-level variables as editable fields, so a number only becomes user-editable if it is one of these declarations.
  - Derived values (computed from other parameters) are encouraged but must reference the parameter variables, e.g. \`outer_r = (inner_diameter / 2 + wall_thickness) / cos(30);\`.
  - The only numeric literals allowed below the parameter block are inside derived-value formulas and small structural constants (like the 6 in \`$fn = 6\` for a hexagon, or +1 epsilon nudges to avoid coplanar faces).
- Use sensible defaults: $fn = 64 for smooth curves, dimensions in mm, object centered near the origin and sitting on (or near) the XY plane.
- When the user asks for an enhancement, MODIFY the existing script rather than rewriting from scratch — preserve their parameters, names, and intent. If the change introduces a new dimension, add it as a new named parameter at the top rather than inlining it.
- If the user supplies an image of the current render, treat it as ground truth for what the model currently looks like; their next instruction is relative to that image.
- If the user supplies a reference image of an object, treat it as the target to recreate: infer the object's shape, proportions, and key features from it and build a clean parametric model that resembles it. The text description, when present, refines or constrains what you see in the reference image.
- The user may include a "[Surface reference]" note with a coordinate, a face label (top/bottom/left/right/front/back), and an outward normal — and a bright ORANGE marker drawn at that point in the screenshot. This means their instruction ("make this thicker", "add a hole here", etc.) applies to that specific surface/location. Use the coordinate and normal to determine which part of the geometry and which parameters are responsible for that surface, and change those. Do not relocate or restructure the rest of the model.
- Never use external libraries (no use<>/include<>). Stick to built-in OpenSCAD primitives and operations.
- Always author the script in millimeters, regardless of how the user phrases dimensions. If the user gives a dimension in inches, convert to mm (1 in = 25.4 mm) and use the mm value as the parameter.
- IMPORTED BASE: if the current script contains a \`module base() { polyhedron(...); }\` (typically marked with "BEGIN IMPORTED BASE" / "END IMPORTED BASE"), that module is an opaque imported mesh from an STL or STEP file. Treat it as read-only geometry:
  - NEVER edit, regenerate, or omit the polyhedron's \`points\` or \`faces\` arrays — copy that block through verbatim.
  - Build all modifications around \`base()\` using union / difference / intersection. To add a feature: \`union() { base(); ...new_geometry... }\`. To remove material: \`difference() { base(); ...cutter... }\`.
  - You may freely add named parameters at the top of the file for the new features. The base mesh has no parameters; do not invent ones to describe its shape.
  - The base is pre-centered on the XY plane (z=0 at its lowest point). Position new features relative to that, not relative to absolute coordinates from the original file.
- If the user asks to SPLIT the model for 3D printing within a given build volume: cut the model into the fewest parts such that each part fits within the stated X×Y×Z mm plate, slicing along sensible flat planes. Lay the resulting parts out separately on the XY plane, spaced apart so they do not overlap and each rests flat for printing. Add simple registration features on the mating faces (alignment pegs with matching holes, or a stepped/lap joint) so the parts can be aligned and glued. Keep the script parametric and preserve existing parameter names where possible.
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

export type TokenUsage = {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export async function generateScad(opts: {
  prompt: string;
  currentScad: string | null;
  previewImageBase64: string | null;
  referenceImage?: { mimeType: string; data: string } | null;
  history: ChatTurn[];
  model?: string;
}): Promise<{ scad: string; usage: TokenUsage }> {
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
  if (opts.referenceImage) {
    parts.push({
      inlineData: { mimeType: opts.referenceImage.mimeType, data: opts.referenceImage.data },
    });
    parts.push({
      text: "(Above is a reference image of the object the user wants to create. Reproduce its overall form, proportions, and notable features as a 3D-printable model.)",
    });
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

  const um = response.usageMetadata;
  const usage: TokenUsage = {
    promptTokens: um?.promptTokenCount ?? 0,
    outputTokens: um?.candidatesTokenCount ?? 0,
    totalTokens: um?.totalTokenCount ?? 0,
  };
  return { scad: stripCodeFences(text), usage };
}
