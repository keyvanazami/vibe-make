# vibe-make

Describe a 3D object in plain English. AI generates an OpenSCAD script, renders a 3D preview, and lets you refine it with follow-up prompts. Export to STL, OBJ, 3MF, AMF, a STEP solid (for Fusion 360 / CAD), or the parametric `.scad`.

## Stack

- **Next.js 14** (app router) + **TypeScript** + **Tailwind**
- **Gemini** (`gemini-3.5-flash` by default) via `@google/genai` for prompt → SCAD
- **OpenSCAD** CLI on the server for SCAD → STL/OBJ/3MF/AMF
- **OpenCASCADE** (Python `cadquery-ocp`) for the optional mesh → STEP solid export
- **three.js** + `@react-three/fiber` for the interactive 3D preview
- Conversation history & current model in `localStorage` (no auth, no DB)

## Prerequisites

1. **Node.js 18+** (this project tested on 22+).
2. **OpenSCAD** installed and reachable on your system.
   - Download: https://openscad.org/downloads.html
   - Windows default install path is `C:\Program Files\OpenSCAD\openscad.exe` — the app uses that automatically.
   - On macOS/Linux, install so `openscad` is on `PATH`, or set `OPENSCAD_BIN` (see below).
3. **Gemini API key** from https://aistudio.google.com/apikey
4. **Python 3.10+** — only needed for **STEP** export. Other formats work without it.

## Setup

```bash
npm install

# Optional: only required for STEP (B-rep) export.
# Installs the OpenCASCADE bindings used by scripts/stl_to_step.py.
pip install -r requirements.txt

cp .env.local.example .env.local
# edit .env.local and paste your GEMINI_API_KEY
npm run dev
```

Open http://localhost:3000

## Environment variables

| Var | Required | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes | Google AI Studio key |
| `GEMINI_MODEL`   | no  | Model ID, defaults to `gemini-3.5-flash` |
| `OPENSCAD_BIN`   | no  | Full path to the `openscad` executable. Defaults to Windows install path on Windows, otherwise `openscad` on PATH |
| `PYTHON_BIN`     | no  | Python executable for STEP export. Defaults to `python` (Windows) / `python3` |
| `STEP_FN`        | no  | Facet count for curves when converting to STEP. Defaults to `128` (higher = smoother curves, larger/slower files) |

## How the loop works

1. You type a description. The server calls Gemini, which returns SCAD code.
2. The server shells out to `openscad -o tmp.stl tmp.scad` and returns the STL.
3. The browser renders the STL with three.js — orbit / zoom freely.
4. When you type a follow-up, the browser captures a PNG screenshot of the current 3D view and sends it back to Gemini together with your new prompt and the current SCAD source. Only the *latest* render is sent — image history is not retained.
5. Use the **Export** menu to download a mesh (STL/OBJ/3MF/AMF), a STEP solid, or the `.scad` source.

STEP export converts the mesh to a B-rep solid via OpenCASCADE: coplanar faces are merged so flat surfaces stay clean and editable in CAD. Curved surfaces come through faceted (controlled by `STEP_FN`), and there's no parametric feature tree — for that, the `.scad` is the editable source.

## Notes

- Conversation history is text-only — only the latest preview image is sent to the model each turn.
- Big STLs may exceed localStorage quotas; if persistence fails silently, that's why.
- The default OpenSCAD render engine is fine for most prompts; for very complex CSG you may need to bump `$fn` lower or simplify.

## Roadmap

- Mobile app (React Native or Capacitor wrapper)
- Optional cloud auth + project library
- Server-side PNG render (so the model sees a canonical view, not the user's camera angle)
