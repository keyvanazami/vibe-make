# vibe-make

Describe a 3D object in plain English. AI generates an OpenSCAD script, renders a 3D preview, and lets you refine it with follow-up prompts. Export to STL, OBJ, or the parametric `.scad`.

## Stack

- **Next.js 14** (app router) + **TypeScript** + **Tailwind**
- **Gemini** (`gemini-3.5-flash` by default) via `@google/genai` for prompt → SCAD
- **OpenSCAD** CLI on the server for SCAD → STL/OBJ
- **three.js** + `@react-three/fiber` for the interactive 3D preview
- Conversation history & current model in `localStorage` (no auth, no DB)

## Prerequisites

1. **Node.js 18+** (this project tested on 22+).
2. **OpenSCAD** installed and reachable on your system.
   - Download: https://openscad.org/downloads.html
   - Windows default install path is `C:\Program Files\OpenSCAD\openscad.exe` — the app uses that automatically.
   - On macOS/Linux, install so `openscad` is on `PATH`, or set `OPENSCAD_BIN` (see below).
3. **Gemini API key** from https://aistudio.google.com/apikey

## Setup

```bash
npm install
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

## How the loop works

1. You type a description. The server calls Gemini, which returns SCAD code.
2. The server shells out to `openscad -o tmp.stl tmp.scad` and returns the STL.
3. The browser renders the STL with three.js — orbit / zoom freely.
4. When you type a follow-up, the browser captures a PNG screenshot of the current 3D view and sends it back to Gemini together with your new prompt and the current SCAD source. Only the *latest* render is sent — image history is not retained.
5. Click **Export STL / OBJ / SCAD** to download.

## Notes

- Conversation history is text-only — only the latest preview image is sent to the model each turn.
- Big STLs may exceed localStorage quotas; if persistence fails silently, that's why.
- The default OpenSCAD render engine is fine for most prompts; for very complex CSG you may need to bump `$fn` lower or simplify.

## Roadmap

- Mobile app (React Native or Capacitor wrapper)
- Optional cloud auth + project library
- Server-side PNG render (so the model sees a canonical view, not the user's camera angle)
