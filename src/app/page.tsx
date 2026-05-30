"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import type { ViewerHandle, PickData, DimLine } from "@/components/Viewer";
import { parseScadParams, applyScadParams, type ScadParam } from "@/lib/scadParams";
import { MANUAL_OPS, buildManualScad, type ManualOpId } from "@/lib/manualOps";
import WorkingIndicator from "@/components/WorkingIndicator";
import {
  listProjects,
  upsertProject,
  deleteProject,
  newProjectId,
  type Project,
} from "@/lib/projects";

const Viewer = dynamic(() => import("@/components/Viewer"), { ssr: false });

type ChatTurn = { role: "user" | "assistant"; text: string; status?: "ok" | "error" };

// Mesh formats, a STEP solid (mesh→B-rep via OpenCASCADE), and the .scad source.
type ExportFormat = "stl" | "obj" | "3mf" | "amf" | "step" | "scad";

type SessionState = {
  history: ChatTurn[];
  currentScad: string | null;
  stlBase64: string | null;
  projectId: string | null;
  tokensTotal: number; // cumulative LLM tokens for this project/session
  tokensLast: number | null; // tokens for the most recent prompt
};

type Selection = PickData & { label: string };

// Map a surface normal to a human-friendly face name (OpenSCAD is Z-up).
function describeNormal(n: [number, number, number]): string {
  const [x, y, z] = n;
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (az >= ax && az >= ay) return z >= 0 ? "top" : "bottom";
  if (ax >= ay) return x >= 0 ? "right (+X)" : "left (−X)";
  return y >= 0 ? "back (+Y)" : "front (−Y)";
}

const round1 = (n: number) => Math.round(n * 10) / 10;

type DisplayUnit = "mm" | "in";
const MM_PER_IN = 25.4;

const fmtNum = (n: number) => String(Math.round(n * 1e5) / 1e5);

// Length params convert between mm (canonical, what the SCAD stores) and the
// display unit; angles and counts are never converted.
function fromMM(p: ScadParam, mm: number, unit: DisplayUnit): number {
  return p.unit === "length" && unit === "in" ? mm / MM_PER_IN : mm;
}
function toMM(p: ScadParam, shown: number, unit: DisplayUnit): number {
  return p.unit === "length" && unit === "in" ? shown * MM_PER_IN : shown;
}

// Strip a trailing unit parenthetical from a comment-derived label so we can
// show the currently-active unit instead (e.g. "wall thickness (mm)" → "wall thickness").
function cleanLabel(label: string): string {
  return label
    .replace(/\s*\((mm|millimet(er|re)s?|cm|in|inch(es)?|deg|degrees?|°)\)\s*$/i, "")
    .trim();
}

function unitSuffix(p: ScadParam, unit: DisplayUnit): string {
  if (p.unit === "angle") return "°";
  if (p.unit === "count") return "";
  return unit;
}

// Bridge between a parsed param and its editable string field, in the display
// unit. Vectors are edited as a comma-separated list ("120, 80, 50").
function paramToEdit(p: ScadParam, unit: DisplayUnit): string {
  return p.value.map((v) => fmtNum(fromMM(p, v, unit))).join(", ");
}

// Parse an edit string (in the display unit) back to canonical mm value(s).
function parseEdit(p: ScadParam, edit: string, unit: DisplayUnit): number | number[] | null {
  if (p.isVector) {
    const parts = (edit ?? "").split(",").map((s) => parseFloat(s.trim()));
    if (parts.length !== p.value.length || parts.some((n) => !Number.isFinite(n))) return null;
    return parts.map((n) => toMM(p, n, unit));
  }
  const n = parseFloat(edit);
  return Number.isFinite(n) ? toMM(p, n, unit) : null;
}

function editChanged(p: ScadParam, edit: string, unit: DisplayUnit): boolean {
  const v = parseEdit(p, edit, unit);
  if (v === null) return false;
  const arr = Array.isArray(v) ? v : [v];
  // Tolerance absorbs unit round-trip rounding so untouched fields aren't flagged.
  return arr.some((n, i) => Math.abs(n - p.value[i]) > 1e-3);
}

// --- Dimension highlighting (which axis does a parameter control) ----------

type DimAxis = { axis: number; value: number }; // value in mm, for the label

// Parse the bounding-box size (mm) from a base64 STL (handles ASCII + binary).
function stlSize(b64: string): [number, number, number] | null {
  try {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const consider = (x: number, y: number, z: number) => {
      const v = [x, y, z];
      for (let a = 0; a < 3; a++) {
        if (v[a] < min[a]) min[a] = v[a];
        if (v[a] > max[a]) max[a] = v[a];
      }
    };

    const isBinary = len >= 84 && 84 + new DataView(bytes.buffer).getUint32(80, true) * 50 === len;
    if (isBinary) {
      const dv = new DataView(bytes.buffer);
      const tris = dv.getUint32(80, true);
      let o = 84;
      for (let t = 0; t < tris; t++) {
        o += 12; // skip normal
        for (let v = 0; v < 3; v++) {
          consider(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true));
          o += 12;
        }
        o += 2; // attribute byte count
      }
    } else {
      const re = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(bin))) consider(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    }
    if (!Number.isFinite(min[0])) return null;
    return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  } catch {
    return null;
  }
}

// Instant guess: map a length param to bounding-box axis/axes by name + value.
function guessAxes(p: ScadParam, dims: [number, number, number]): DimAxis[] {
  if (p.unit !== "length") return [];
  const close = (val: number, ext: number) => Math.abs(val - ext) <= Math.max(0.5, ext * 0.03);

  // Vectors: component i maps to axis i when it matches that extent.
  if (p.isVector && p.value.length === 3) {
    const out: DimAxis[] = [];
    for (let a = 0; a < 3; a++) if (close(p.value[a], dims[a])) out.push({ axis: a, value: p.value[a] });
    return out;
  }

  const v = p.value[0];
  const s = `${p.name} ${p.label}`.toLowerCase();
  const named: number =
    /(height|tall|\bht\b|\bz\b)/.test(s) ? 2 :
    /(width|wide|\bx\b)/.test(s) ? 0 :
    /(depth|length|long|\by\b)/.test(s) ? 1 :
    -1;

  if (named >= 0 && close(v, dims[named])) return [{ axis: named, value: v }];
  // Diameter/across: match the value to whichever horizontal extent fits.
  if (/(diam|\bdia\b|\bod\b|\bid\b|across|bore)/.test(s)) {
    if (close(v, dims[0])) return [{ axis: 0, value: v }];
    if (close(v, dims[1])) return [{ axis: 1, value: v }];
  }
  // Fallback: value equals exactly one extent → highlight it.
  const matches = [0, 1, 2].filter((a) => close(v, dims[a]));
  if (matches.length === 1) return [{ axis: matches[0], value: v }];
  return [];
}

// Turn a project name into a filesystem-safe export filename base.
function safeFilename(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9-_ ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "vibe-make";
}

// Read an image file and downscale it to a reasonable size, returning a JPEG
// data URL. Keeps the request payload small and within the model's limits.
function readImageFile(file: File, maxDim = 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const src = reader.result as string;
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(src); // fall back to the original if 2d context is unavailable
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

const STORAGE_KEY = "vibe-make:session:v1";

const EMPTY: SessionState = {
  history: [],
  currentScad: null,
  stlBase64: null,
  projectId: null,
  tokensTotal: 0,
  tokensLast: null,
};

function loadSession(): SessionState {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as SessionState;
    return {
      history: Array.isArray(parsed.history) ? parsed.history : [],
      currentScad: typeof parsed.currentScad === "string" ? parsed.currentScad : null,
      stlBase64: typeof parsed.stlBase64 === "string" ? parsed.stlBase64 : null,
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : null,
      tokensTotal: typeof parsed.tokensTotal === "number" ? parsed.tokensTotal : 0,
      tokensLast: typeof parsed.tokensLast === "number" ? parsed.tokensLast : null,
    };
  } catch {
    return EMPTY;
  }
}

function saveSession(state: SessionState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be full (STL can be big); ignore silently
  }
}

type Settings = { plate: [number, number, number]; unit: DisplayUnit };
const SETTINGS_KEY = "vibe-make:settings:v1";
const DEFAULT_SETTINGS: Settings = { plate: [220, 220, 250], unit: "mm" };

function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const p = JSON.parse(raw) as Partial<Settings>;
    const plate = Array.isArray(p.plate) && p.plate.length === 3 ? (p.plate as [number, number, number]) : DEFAULT_SETTINGS.plate;
    const unit = p.unit === "in" ? "in" : "mm";
    return { plate, unit };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// --- Header dropdown menu primitives ---------------------------------------
const MenuCloseCtx = createContext<() => void>(() => {});

function HeaderMenu({
  label,
  disabled,
  width,
  onOpen,
  children,
}: {
  label: string;
  disabled?: boolean;
  width?: string;
  onOpen?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="relative">
      <button
        disabled={disabled}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen((v) => !v);
        }}
        className="px-3 py-1.5 rounded border border-neutral-700 hover:bg-neutral-900 disabled:opacity-40"
      >
        {label} ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div
            className={
              "absolute right-0 mt-1 z-20 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl p-1 " +
              (width ?? "w-52")
            }
          >
            <MenuCloseCtx.Provider value={close}>{children}</MenuCloseCtx.Provider>
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  disabled,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const close = useContext(MenuCloseCtx);
  return (
    <button
      disabled={disabled}
      onClick={() => {
        onClick?.();
        close();
      }}
      className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function ProjectRow({
  name,
  when,
  active,
  onLoad,
  onDelete,
}: {
  name: string;
  when: string;
  active: boolean;
  onLoad: () => void;
  onDelete: () => void;
}) {
  const close = useContext(MenuCloseCtx);
  return (
    <div
      className={
        "flex items-center gap-1 rounded px-2 py-1.5 hover:bg-neutral-800 " +
        (active ? "bg-neutral-800/60" : "")
      }
    >
      <button
        className="flex-1 text-left min-w-0"
        onClick={() => {
          onLoad();
          close();
        }}
      >
        <div className="text-sm truncate">{name}</div>
        <div className="text-xs text-neutral-500">{when}</div>
      </button>
      <button
        className="text-xs text-neutral-500 hover:text-red-400 shrink-0 px-1"
        onClick={onDelete}
      >
        Delete
      </button>
    </div>
  );
}

export default function Home() {
  const [session, setSession] = useState<SessionState>(EMPTY);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScad, setShowScad] = useState(false);
  const [showParams, setShowParams] = useState(true);
  const [paramEdits, setParamEdits] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [refImage, setRefImage] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [exporting, setExporting] = useState<null | ExportFormat>(null);
  const [modelDims, setModelDims] = useState<[number, number, number] | null>(null);
  const [showSplit, setShowSplit] = useState(false);
  const [showModify, setShowModify] = useState(false);
  const [modOpId, setModOpId] = useState<ManualOpId>("cut_cyl");
  const [modFields, setModFields] = useState<Record<string, string>>({});
  const [modAlign, setModAlign] = useState(true);
  const [highlightParam, setHighlightParam] = useState<string | null>(null);
  const [dimAxes, setDimAxes] = useState<Record<string, DimAxis[]>>({});
  const viewerRef = useRef<ViewerHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const unit = settings.unit;

  const onPickImage = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    try {
      setRefImage(await readImageFile(file));
    } catch {
      setError("Could not read that image file.");
    }
  }, []);

  useEffect(() => { setSession(loadSession()); }, []);
  useEffect(() => { saveSession(session); }, [session]);
  useEffect(() => { setProjects(listProjects()); }, []);
  useEffect(() => { setSettings(loadSettings()); }, []);
  useEffect(() => {
    try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  }, [settings]);

  // A pick refers to a specific geometry; once the model re-renders it's stale.
  useEffect(() => { setSelection(null); }, [session.stlBase64]);
  useEffect(() => { if (!session.stlBase64) setModelDims(null); }, [session.stlBase64]);

  // Resolved dimension cache and focus are tied to the current geometry.
  useEffect(() => { setDimAxes({}); setHighlightParam(null); }, [session.currentScad]);

  const onPick = useCallback((d: PickData | null) => {
    setSelection(d ? { ...d, label: describeNormal(d.normal) } : null);
  }, []);

  const currentProject = projects.find((p) => p.id === session.projectId) ?? null;

  // Does the model fit the plate in some axis-aligned orientation? (compare
  // sorted extents so rotating the part onto the bed counts as fitting).
  const fitsPlate = (() => {
    if (!modelDims) return true;
    const m = [...modelDims].sort((a, b) => a - b);
    const pl = [...settings.plate].sort((a, b) => a - b);
    return m[0] <= pl[0] && m[1] <= pl[1] && m[2] <= pl[2];
  })();

  // Parameters parsed out of the current SCAD. Recomputed only when the SCAD
  // itself changes (e.g. after a generate/refine), at which point we reset the
  // edit fields back to the script's actual values.
  const params = useMemo(
    () => (session.currentScad ? parseScadParams(session.currentScad) : []),
    [session.currentScad]
  );

  useEffect(() => {
    const init: Record<string, string> = {};
    for (const p of params) init[p.name] = paramToEdit(p, unit);
    setParamEdits(init);
    // Re-initialised only when the model's params change, not on unit toggle
    // (changeUnit converts existing edits in place).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const paramsDirty = params.some((p) => editChanged(p, paramEdits[p.name] ?? "", unit));

  const resetParams = useCallback(() => {
    const init: Record<string, string> = {};
    for (const p of params) init[p.name] = paramToEdit(p, unit);
    setParamEdits(init);
  }, [params, unit]);

  // Switch display unit, converting any current edit strings between units so
  // unsaved tweaks survive the toggle.
  const changeUnit = useCallback(
    (next: DisplayUnit) => {
      setParamEdits((prev) => {
        const out = { ...prev };
        for (const p of params) {
          const cur = prev[p.name];
          if (cur == null) continue;
          const mm = parseEdit(p, cur, unit);
          if (mm == null) continue;
          const arr = Array.isArray(mm) ? mm : [mm];
          out[p.name] = arr.map((v) => fmtNum(fromMM(p, v, next))).join(", ");
        }
        return out;
      });
      setSettings((s) => ({ ...s, unit: next }));
    },
    [params, unit]
  );

  const applyParams = useCallback(async () => {
    if (!session.currentScad || busy) return;
    const values: Record<string, number | number[]> = {};
    for (const p of params) {
      const edit = paramEdits[p.name] ?? "";
      if (!editChanged(p, edit, unit)) continue; // leave untouched lines byte-identical
      const v = parseEdit(p, edit, unit);
      if (v !== null) values[p.name] = v;
    }
    const newScad = applyScadParams(session.currentScad, values);
    if (newScad === session.currentScad) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scad: newScad }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Render failed (${res.status})`);
        return;
      }
      setSession((s) => ({ ...s, currentScad: newScad, stlBase64: data.stlBase64 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Render error");
    } finally {
      setBusy(false);
    }
  }, [session.currentScad, params, paramEdits, busy, unit]);

  // Resolve which axis the focused parameter controls: instant name/value guess
  // first, then (if inconclusive) probe by nudging the value and re-rendering to
  // see which way the bounding box grows. Results are cached per parameter.
  useEffect(() => {
    if (!highlightParam || !modelDims || !session.currentScad) return;
    if (highlightParam in dimAxes) return; // already resolved
    const p = params.find((x) => x.name === highlightParam);
    if (!p || p.unit !== "length") {
      setDimAxes((c) => ({ ...c, [highlightParam]: [] }));
      return;
    }

    const instant = guessAxes(p, modelDims);
    if (instant.length) {
      setDimAxes((c) => ({ ...c, [p.name]: instant }));
      return;
    }
    if (p.isVector) {
      setDimAxes((c) => ({ ...c, [p.name]: [] })); // probing vectors is ambiguous
      return;
    }

    // Probe: bump the value, render, compare bounding box per axis.
    let cancelled = false;
    const scad = session.currentScad;
    const baseDims = modelDims;
    const delta = Math.max(Math.abs(p.value[0]) * 0.15, 3);
    const probe = setTimeout(async () => {
      try {
        const newScad = applyScadParams(scad, { [p.name]: p.value[0] + delta });
        const res = await fetch("/api/render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scad: newScad }),
        });
        const data = await res.json();
        const size = res.ok ? stlSize(data.stlBase64) : null;
        let result: DimAxis[] = [];
        if (size) {
          const deltas = [0, 1, 2].map((a) => Math.abs(size[a] - baseDims[a]));
          const best = deltas.indexOf(Math.max(...deltas));
          if (deltas[best] > 0.3) result = [{ axis: best, value: p.value[0] }];
        }
        if (!cancelled) setDimAxes((c) => ({ ...c, [p.name]: result }));
      } catch {
        if (!cancelled) setDimAxes((c) => ({ ...c, [p.name]: [] }));
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(probe); };
  }, [highlightParam, modelDims, params, session.currentScad, dimAxes]);

  // Build the dimension annotation lines for the currently-highlighted param.
  const dimLines = useMemo<DimLine[]>(() => {
    if (!highlightParam || !modelDims) return [];
    const p = params.find((x) => x.name === highlightParam);
    const axes = dimAxes[highlightParam];
    if (!p || !axes || !axes.length) return [];
    const half = modelDims.map((d) => d / 2) as [number, number, number];
    const off = Math.max(...modelDims) * 0.12 + 3;
    return axes.map(({ axis, value }) => {
      const o1 = (axis + 1) % 3;
      const o2 = (axis + 2) % 3;
      const base = [0, 0, 0];
      base[o1] = half[o1] + off;
      base[o2] = half[o2] + off;
      const from = [...base] as [number, number, number];
      const to = [...base] as [number, number, number];
      from[axis] = -half[axis];
      to[axis] = half[axis];
      const label = `${fmtNum(fromMM(p, value, unit))} ${unitSuffix(p, unit)}`;
      return { from, to, label };
    });
  }, [highlightParam, dimAxes, modelDims, params, unit]);

  // Shared generation path used by both the prompt box and the split action.
  // Captures the current render (with any selection marker) and posts to the API.
  const runGeneration = useCallback(
    async (
      promptForApi: string,
      displayText: string,
      referenceImageDataUrl?: string | null
    ): Promise<boolean> => {
      setBusy(true);
      setError(null);
      const previewImageBase64 =
        session.currentScad && viewerRef.current ? viewerRef.current.capturePng() : null;
      const userTurn: ChatTurn = { role: "user", text: displayText };
      try {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: promptForApi,
            currentScad: session.currentScad,
            previewImageBase64,
            referenceImageDataUrl: referenceImageDataUrl ?? null,
            history: session.history,
          }),
        });
        const data = await res.json();
        const tok = typeof data.usage?.totalTokens === "number" ? data.usage.totalTokens : 0;
        if (!res.ok) {
          setError(data.error || `Request failed (${res.status})`);
          if (data.scad) {
            setSession((s) => ({
              ...s,
              history: [...s.history, { ...userTurn, status: "error" }],
              currentScad: data.scad,
              tokensLast: tok,
              tokensTotal: s.tokensTotal + tok,
            }));
          }
          return false;
        }
        setSession((s) => ({
          ...s,
          history: [...s.history, { ...userTurn, status: "ok" }],
          currentScad: data.scad,
          stlBase64: data.stlBase64,
          tokensLast: tok,
          tokensTotal: s.tokensTotal + tok,
        }));
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [session]
  );

  const submit = useCallback(async () => {
    const trimmed = prompt.trim();
    const hasImage = !!refImage;
    if ((!trimmed && !hasImage) || busy) return;

    const sel = selection;
    const refNote = sel
      ? `📍 ${sel.label} surface @ (${round1(sel.modelPoint[0])}, ${round1(sel.modelPoint[1])}, ${round1(sel.modelPoint[2])}) mm`
      : "";

    // Effective instruction sent to the model — fall back to a default when the
    // user attached only an image with no text.
    const baseText =
      trimmed ||
      "Create a clean 3D-printable model of the object shown in the reference image.";

    const notes = [hasImage ? "🖼 reference image" : "", refNote].filter(Boolean).join("  ·  ");
    const displayText =
      [trimmed, notes].filter(Boolean).join("  ·  ") || "(generate from reference image)";
    const promptForApi = sel
      ? `${baseText}\n\n[Surface reference] The user clicked a point on the current model to mark where this instruction applies: the ${sel.label} surface, at approximately (${round1(
          sel.modelPoint[0]
        )}, ${round1(sel.modelPoint[1])}, ${round1(
          sel.modelPoint[2]
        )}) mm in the model's coordinate system, outward normal (${round1(
          sel.normal[0]
        )}, ${round1(sel.normal[1])}, ${round1(
          sel.normal[2]
        )}). A bright orange marker is drawn at this point in the screenshot. Figure out which feature/parameters of the SCAD produce that surface and apply the change there.`
      : baseText;

    const ok = await runGeneration(promptForApi, displayText, refImage);
    if (ok) {
      setPrompt("");
      setRefImage(null);
    }
  }, [prompt, busy, selection, refImage, runGeneration]);

  const splitForPrinting = useCallback(async () => {
    if (!session.currentScad || busy) return;
    const [px, py, pz] = settings.plate;
    setShowSplit(false);
    const dimNote = modelDims
      ? `The current model measures approximately ${round1(modelDims[0])} × ${round1(modelDims[1])} × ${round1(modelDims[2])} mm. `
      : "";
    const instruction =
      `${dimNote}Split this model into the fewest parts such that every part fits within a 3D printer build volume of ${px} × ${py} × ${pz} mm (X, Y, Z). ` +
      `Cut along sensible flat planes, lay the parts out separately on the XY plane spaced apart so they do not overlap and each sits flat for printing, ` +
      `and add simple registration features (alignment pegs with matching holes, or a stepped/lap joint) on the mating faces so the parts can be aligned and glued. Keep it parametric.`;
    const display = `🪚 Split for printing · plate ${px}×${py}×${pz} mm`;
    await runGeneration(instruction, display, null);
  }, [session.currentScad, busy, settings.plate, modelDims, runGeneration]);

  // --- Manual (LLM-free) geometry edits ---
  const modOp = MANUAL_OPS.find((o) => o.id === modOpId)!;

  // Reset the form to the op's defaults when the chosen op changes, prefilling
  // the position from the current surface pick when relevant.
  useEffect(() => {
    const f: Record<string, string> = {};
    for (const fd of modOp.fields) f[fd.key] = String(fd.default);
    if (modOp.positional && selection) {
      f.px = String(round1(selection.modelPoint[0]));
      f.py = String(round1(selection.modelPoint[1]));
      f.pz = String(round1(selection.modelPoint[2]));
    }
    setModFields(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modOpId]);

  const usePickedPoint = useCallback(() => {
    if (!selection) return;
    setModFields((m) => ({
      ...m,
      px: String(round1(selection.modelPoint[0])),
      py: String(round1(selection.modelPoint[1])),
      pz: String(round1(selection.modelPoint[2])),
    }));
  }, [selection]);

  const applyManualOp = useCallback(async () => {
    if (!session.currentScad || busy) return;
    const f: Record<string, number> = {};
    for (const fd of modOp.fields) {
      const n = parseFloat(modFields[fd.key]);
      f[fd.key] = Number.isFinite(n) ? n : fd.default;
    }
    const orient = modOp.positional && modAlign && selection ? selection.normal : null;
    const newScad = buildManualScad(session.currentScad, modOp, f, orient);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scad: newScad }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Render failed (${res.status})`);
        return;
      }
      setSession((s) => ({ ...s, currentScad: newScad, stlBase64: data.stlBase64 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Render error");
    } finally {
      setBusy(false);
    }
  }, [session.currentScad, busy, modOp, modFields, modAlign, selection]);

  const onExport = useCallback(
    async (format: ExportFormat) => {
      if (!session.currentScad || exporting) return;
      const base = currentProject ? safeFilename(currentProject.name) : "vibe-make";
      setExporting(format);
      setError(null);
      try {
        const res = await fetch("/api/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scad: session.currentScad, format, filename: base }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error || `Export failed (${res.status})`);
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${base}.${format}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Download failed");
      } finally {
        setExporting(null);
      }
    },
    [session.currentScad, currentProject, exporting]
  );

  const onNewProject = useCallback(() => {
    if (!confirm("Start a new project? Unsaved work will be cleared.")) return;
    setSession(EMPTY);
    setPrompt("");
    setError(null);
  }, []);

  // Upload an STL or STEP file, wrap it as a polyhedron base() module, and
  // start a fresh (unsaved) project so the user can prompt modifications.
  const onImportPart = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-import of the same file
    if (!file) return;
    if (session.currentScad && !confirm("Replace the current model with an imported file? Unsaved work will be cleared.")) return;
    setImporting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/import-part", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Import failed (${res.status})`);
        if (data.scad) {
          // Server returned SCAD but render failed — still load it so the user can inspect.
          setSession({ ...EMPTY, currentScad: data.scad });
        }
        return;
      }
      const seedTurn: ChatTurn = {
        role: "assistant",
        text: `Imported ${data.name} (${data.triCount.toLocaleString()} triangles) as the base part.`,
        status: "ok",
      };
      setSession({
        history: [seedTurn],
        currentScad: data.scad,
        stlBase64: data.stlBase64,
        projectId: null,
        tokensTotal: 0,
        tokensLast: null,
      });
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import error");
    } finally {
      setImporting(false);
    }
  }, [session.currentScad]);

  // Save the current prompts + SCAD as a named project. Updates the loaded
  // project in place if there is one; otherwise asks for a name and creates it.
  const saveProject = useCallback(() => {
    if (!session.currentScad) return;
    const existing = session.projectId
      ? projects.find((p) => p.id === session.projectId) ?? null
      : null;

    let id: string;
    let name: string;
    if (existing) {
      id = existing.id;
      name = existing.name;
    } else {
      const suggested =
        session.history.find((h) => h.role === "user")?.text.slice(0, 48) || "Untitled";
      const input = window.prompt("Save project as:", suggested);
      if (input === null) return; // cancelled
      name = input.trim() || suggested;
      id = newProjectId();
    }

    const now = Date.now();
    const updated = upsertProject({
      id,
      name,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      history: session.history,
      scad: session.currentScad,
      tokensTotal: session.tokensTotal,
    });
    setProjects(updated);
    setSession((s) => ({ ...s, projectId: id }));
  }, [session, projects]);

  const loadProject = useCallback(async (id: string) => {
    const p = listProjects().find((x) => x.id === id);
    if (!p) return;
    setError(null);
    setPrompt("");
    // Show the saved state immediately; re-render the STL from the SCAD.
    setSession({
      history: p.history,
      currentScad: p.scad,
      stlBase64: null,
      projectId: p.id,
      tokensTotal: p.tokensTotal ?? 0,
      tokensLast: null,
    });
    setBusy(true);
    try {
      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scad: p.scad }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Render failed (${res.status})`);
        return;
      }
      setSession((s) => ({ ...s, stlBase64: data.stlBase64 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Render error");
    } finally {
      setBusy(false);
    }
  }, []);

  const removeProject = useCallback(
    (id: string) => {
      if (!confirm("Delete this project? This cannot be undone.")) return;
      setProjects(deleteProject(id));
      setSession((s) => (s.projectId === id ? { ...s, projectId: null } : s));
    },
    []
  );

  return (
    <main className="h-screen w-screen flex flex-col bg-gradient-to-b from-neutral-950 via-neutral-950 to-black text-neutral-100">
      <header className="relative z-50 flex items-center justify-between px-4 py-2.5 border-b border-neutral-800/80 bg-neutral-950/60 backdrop-blur">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-900/40">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
              <path d="M12 2l9 5v10l-9 5-9-5V7z" />
              <path d="M12 2v20M3 7l9 5 9-5" />
            </svg>
          </span>
          <h1 className="text-lg font-semibold tracking-tight bg-gradient-to-r from-white to-neutral-400 bg-clip-text text-transparent">
            vibe-make
          </h1>
          {currentProject && (
            <span className="text-sm text-neutral-500 truncate" title={currentProject.name}>
              <span className="text-neutral-700">/</span> {currentProject.name}
            </span>
          )}
        </div>
        <div className="flex gap-2 text-sm">
          <HeaderMenu label="View" disabled={!session.currentScad}>
            <MenuItem onClick={() => setShowParams((v) => !v)}>
              <span className="inline-block w-4 text-indigo-400">{showParams ? "✓" : ""}</span>
              Parameters panel
            </MenuItem>
            <MenuItem onClick={() => setShowScad((v) => !v)}>
              <span className="inline-block w-4 text-indigo-400">{showScad ? "✓" : ""}</span>
              SCAD code
            </MenuItem>
          </HeaderMenu>
          <div className="relative">
            <button
              className="px-3 py-1.5 rounded border border-neutral-700 hover:bg-neutral-900 disabled:opacity-40"
              disabled={!session.currentScad}
              onClick={() => setShowModify((v) => !v)}
            >
              Modify…
            </button>
            {showModify && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowModify(false)} />
                <div className="absolute right-0 mt-1 w-80 z-20 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl p-3">
                  <div className="text-sm font-medium mb-1">Manual edit</div>
                  <p className="text-xs text-neutral-500 mb-2">
                    Apply a basic operation directly — no model call. Values in mm.
                  </p>
                  <select
                    value={modOpId}
                    onChange={(e) => setModOpId(e.target.value as ManualOpId)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-sm outline-none focus:border-neutral-500 mb-1"
                  >
                    <optgroup label="Add">
                      {MANUAL_OPS.filter((o) => o.id.startsWith("add")).map((o) => (
                        <option key={o.id} value={o.id}>{o.label}</option>
                      ))}
                    </optgroup>
                    <optgroup label="Remove">
                      {MANUAL_OPS.filter((o) => o.id.startsWith("cut")).map((o) => (
                        <option key={o.id} value={o.id}>{o.label}</option>
                      ))}
                    </optgroup>
                    <optgroup label="Transform">
                      {MANUAL_OPS.filter((o) => ["scale", "move", "rotate", "mirror"].includes(o.id)).map((o) => (
                        <option key={o.id} value={o.id}>{o.label}</option>
                      ))}
                    </optgroup>
                  </select>
                  <p className="text-xs text-neutral-500 mb-2">{modOp.hint}</p>
                  {modOp.positional && selection && (
                    <div className="mb-2 space-y-1.5">
                      <button
                        onClick={usePickedPoint}
                        className="w-full px-2 py-1 text-xs rounded border border-orange-900/70 bg-orange-950/40 text-orange-200 hover:bg-orange-950/70"
                      >
                        📍 Use selected surface point ({round1(selection.modelPoint[0])},{" "}
                        {round1(selection.modelPoint[1])}, {round1(selection.modelPoint[2])})
                      </button>
                      <label className="flex items-center gap-2 text-xs text-neutral-300">
                        <input
                          type="checkbox"
                          checked={modAlign}
                          onChange={(e) => setModAlign(e.target.checked)}
                          className="accent-orange-500"
                        />
                        Align to surface normal (point into/out of the {selection.label} face)
                      </label>
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-1.5 mb-3">
                    {modOp.fields.map((fd) => (
                      <label key={fd.key} className="block">
                        <span className="block text-[10px] text-neutral-500 mb-0.5 truncate">{fd.label}</span>
                        <input
                          type="number"
                          step="any"
                          value={modFields[fd.key] ?? ""}
                          onChange={(e) => setModFields((m) => ({ ...m, [fd.key]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              applyManualOp();
                            }
                          }}
                          className="w-full bg-neutral-800 border border-neutral-700 rounded px-1.5 py-1 text-sm outline-none focus:border-neutral-500"
                        />
                      </label>
                    ))}
                  </div>
                  <button
                    onClick={applyManualOp}
                    disabled={busy}
                    className="w-full px-3 py-1.5 text-sm rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40"
                  >
                    {busy ? "Rendering…" : `Apply ${modOp.label}`}
                  </button>
                </div>
              </>
            )}
          </div>
          <div className="relative">
            <button
              className="px-3 py-1.5 rounded border border-neutral-700 hover:bg-neutral-900 disabled:opacity-40"
              disabled={!session.currentScad}
              onClick={() => setShowSplit((v) => !v)}
            >
              Split…
            </button>
            {showSplit && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowSplit(false)} />
                <div className="absolute right-0 mt-1 w-72 z-20 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl p-3">
                  <div className="text-sm font-medium mb-1">Split for printing</div>
                  <p className="text-xs text-neutral-500 mb-3">
                    Cuts the model into parts that fit your printer&apos;s build plate, laid out
                    flat with alignment features for gluing.
                  </p>
                  <div className="text-xs text-neutral-400 mb-1">Build plate (mm)</div>
                  <div className="flex gap-1.5 mb-3">
                    {(["X", "Y", "Z"] as const).map((axis, i) => (
                      <label key={axis} className="flex-1">
                        <span className="block text-[10px] uppercase text-neutral-500 mb-0.5">{axis}</span>
                        <input
                          type="number"
                          min="1"
                          value={String(settings.plate[i])}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            setSettings((s) => {
                              const plate = [...s.plate] as [number, number, number];
                              if (Number.isFinite(v) && v > 0) plate[i] = v;
                              return { ...s, plate };
                            });
                          }}
                          className="w-full bg-neutral-800 border border-neutral-700 rounded px-1.5 py-1 text-sm outline-none focus:border-neutral-500"
                        />
                      </label>
                    ))}
                  </div>
                  {modelDims && (
                    <div className="text-xs mb-3">
                      <span className="text-neutral-500">Model size: </span>
                      <span className={fitsPlate ? "text-neutral-300" : "text-amber-400"}>
                        {round1(modelDims[0])} × {round1(modelDims[1])} × {round1(modelDims[2])} mm
                      </span>
                      {!fitsPlate && (
                        <span className="text-amber-400"> — larger than plate</span>
                      )}
                    </div>
                  )}
                  <button
                    onClick={splitForPrinting}
                    disabled={busy}
                    className="w-full px-3 py-1.5 text-sm rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40"
                  >
                    {busy ? "Working…" : "Split model"}
                  </button>
                </div>
              </>
            )}
          </div>
          <HeaderMenu label="Export" width="w-64" disabled={!session.currentScad}>
            <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-500">
              Mesh
            </div>
            {(
              [
                ["stl", "STL", "3D printing / slicers"],
                ["obj", "OBJ", "Blender, mesh tools"],
                ["3mf", "3MF", "Fusion 360, modern apps"],
                ["amf", "AMF", "mesh interchange"],
              ] as const
            ).map(([fmt, label, hint]) => (
              <MenuItem key={fmt} onClick={() => onExport(fmt)} disabled={!!exporting}>
                <span className="font-medium">
                  {exporting === fmt ? `Exporting ${label}…` : label}
                </span>
                <span className="text-neutral-500"> — {hint}</span>
              </MenuItem>
            ))}
            <div className="my-1 border-t border-neutral-800" />
            <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-500">
              Solid (B-rep)
            </div>
            <MenuItem onClick={() => onExport("step")} disabled={!!exporting}>
              <span className="font-medium">
                {exporting === "step" ? "Converting STEP…" : "STEP"}
              </span>
              <span className="text-neutral-500"> — Fusion 360 solid body</span>
            </MenuItem>
            <div className="my-1 border-t border-neutral-800" />
            <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-500">
              Parametric source
            </div>
            <MenuItem onClick={() => onExport("scad")} disabled={!!exporting}>
              <span className="font-medium">
                {exporting === "scad" ? "Exporting SCAD…" : "OpenSCAD (.scad)"}
              </span>
              <span className="text-neutral-500"> — editable</span>
            </MenuItem>
          </HeaderMenu>
          <HeaderMenu label="Project" width="w-72" onOpen={() => setProjects(listProjects())}>
            <MenuItem onClick={saveProject} disabled={!session.currentScad}>
              {currentProject ? "Save" : "Save as…"}
            </MenuItem>
            <MenuItem onClick={onNewProject}>New project</MenuItem>
            <MenuItem onClick={() => importInputRef.current?.click()} disabled={importing}>
              {importing ? "Importing…" : "Import STL or STEP…"}
            </MenuItem>
            <div className="my-1 border-t border-neutral-800" />
            <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-500">
              Open project
            </div>
            {projects.length === 0 ? (
              <div className="px-2 py-2 text-xs text-neutral-600">No saved projects yet.</div>
            ) : (
              <div className="max-h-72 overflow-y-auto">
                {projects.map((p) => (
                  <ProjectRow
                    key={p.id}
                    name={p.name}
                    when={new Date(p.updatedAt).toLocaleString()}
                    active={p.id === session.projectId}
                    onLoad={() => loadProject(p.id)}
                    onDelete={() => removeProject(p.id)}
                  />
                ))}
              </div>
            )}
          </HeaderMenu>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-12 gap-3 p-3 min-h-0">
        <aside className="col-span-4 flex flex-col min-h-0 bg-neutral-900/40 border border-neutral-800/80 rounded-xl shadow-xl shadow-black/30">
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {session.history.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-3 text-neutral-500">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500/20 to-violet-600/20 border border-indigo-500/30">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="text-indigo-300" aria-hidden>
                    <path d="M12 2l9 5v10l-9 5-9-5V7z" />
                    <path d="M12 2v20M3 7l9 5 9-5" />
                  </svg>
                </span>
                <p className="text-sm text-neutral-400">Describe what you want to make.</p>
                <p className="text-xs italic text-neutral-600 leading-relaxed">
                  e.g. “A hexagonal pen holder, 80mm tall, 40mm inner diameter, 3mm walls”
                </p>
              </div>
            )}
            {session.history
              .filter((m) => m.role === "user")
              .map((m, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2.5 rounded-lg px-3 py-2.5 bg-neutral-900/70 border border-neutral-800/80"
                >
                  <span
                    className={
                      "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold " +
                      (m.status === "error"
                        ? "bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/40"
                        : "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40")
                    }
                    title={m.status === "error" ? "Generated, but failed to render" : "Applied"}
                  >
                    {m.status === "error" ? "!" : "✓"}
                  </span>
                  <span className="text-sm text-neutral-200 leading-snug">{m.text}</span>
                </div>
              ))}
            {busy && <WorkingIndicator />}
            {exporting && <WorkingIndicator label={`Exporting ${exporting.toUpperCase()}…`} />}
            {importing && <WorkingIndicator label="Importing part…" />}
            {error && (
              <div className="text-sm rounded-lg px-3 py-2 bg-red-950/40 border border-red-900/70 text-red-200 whitespace-pre-wrap">
                {error}
              </div>
            )}
          </div>

          <div className="border-t border-neutral-800 p-3">
            {refImage && (
              <div className="mb-2 flex items-center gap-2 text-xs rounded px-2 py-1.5 bg-neutral-900 border border-neutral-800">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={refImage}
                  alt="reference"
                  className="h-10 w-10 object-cover rounded border border-neutral-700"
                />
                <span className="flex-1 truncate text-neutral-400">Reference image attached</span>
                <button
                  className="shrink-0 text-neutral-500 hover:text-red-400"
                  onClick={() => setRefImage(null)}
                  title="Remove reference image"
                >
                  ✕
                </button>
              </div>
            )}
            {selection && (
              <div className="mb-2 flex items-center gap-2 text-xs rounded px-2 py-1.5 bg-orange-950/40 border border-orange-900/70 text-orange-200">
                <span className="text-orange-400">📍</span>
                <span className="flex-1 truncate">
                  Referencing <strong>{selection.label}</strong> surface @ (
                  {round1(selection.modelPoint[0])}, {round1(selection.modelPoint[1])},{" "}
                  {round1(selection.modelPoint[2])}) mm
                </span>
                <button
                  className="shrink-0 text-orange-300 hover:text-orange-100"
                  onClick={() => setSelection(null)}
                  title="Clear surface reference"
                >
                  ✕
                </button>
              </div>
            )}
            <textarea
              className="w-full bg-neutral-900/70 border border-neutral-800 rounded-lg p-2.5 text-sm resize-none h-24 outline-none focus:border-indigo-500/60 focus:ring-1 focus:ring-indigo-500/40 transition"
              placeholder={
                session.currentScad
                  ? "Refine it… (e.g. 'make it taller', 'add a slot in the side')"
                  : "Describe the object you want to make…"
              }
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              disabled={busy}
            />
            <div className="flex justify-between items-center mt-2 gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                  title="Attach a reference image of the object you want to make"
                  className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-900 hover:text-white disabled:opacity-40"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                  Add image
                </button>
                <span className="text-xs text-neutral-500 truncate">
                  {session.currentScad ? "Click the model to reference a surface · " : ""}
                  Ctrl/Cmd + Enter to send
                </span>
              </div>
              <button
                onClick={submit}
                disabled={busy || (!prompt.trim() && !refImage)}
                className="shrink-0 px-4 py-1.5 text-sm font-medium rounded-lg text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-400 hover:to-violet-500 shadow-lg shadow-indigo-900/40 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none transition"
              >
                {busy ? "Working…" : session.currentScad ? "Refine" : "Generate"}
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onPickImage}
            />
            <input
              ref={importInputRef}
              type="file"
              accept=".stl,.step,.stp,model/stl,model/step"
              className="hidden"
              onChange={onImportPart}
            />
          </div>
        </aside>

        <section className="col-span-8 min-h-0 flex flex-col gap-3">
          <div className={(showScad ? "h-1/2" : "flex-1") + " min-h-0 flex gap-3"}>
            <div className="flex-1 min-w-0 min-h-0">
              <Viewer
                stlBase64={session.stlBase64}
                onReady={(h) => { viewerRef.current = h; }}
                selection={selection ? { worldPoint: selection.worldPoint, normal: selection.normal } : null}
                onPick={onPick}
                onBounds={setModelDims}
                dimensions={dimLines}
              />
            </div>
            {showParams && session.currentScad && (
              <aside className="w-64 shrink-0 min-h-0 flex flex-col bg-neutral-900/40 border border-neutral-800/80 rounded-xl shadow-xl shadow-black/30">
                <div className="px-3 py-2 border-b border-neutral-800 flex items-center justify-between">
                  <span className="text-sm font-medium">Parameters</span>
                  <div className="flex items-center gap-0.5 text-xs">
                    {(["mm", "in"] as const).map((u) => (
                      <button
                        key={u}
                        onClick={() => changeUnit(u)}
                        className={
                          "px-1.5 py-0.5 rounded " +
                          (unit === u
                            ? "bg-neutral-700 text-white"
                            : "text-neutral-500 hover:text-neutral-300")
                        }
                      >
                        {u}
                      </button>
                    ))}
                  </div>
                </div>
                {params.length === 0 ? (
                  <div className="flex-1 p-3 text-xs text-neutral-500">
                    No editable parameters detected in this model. Refine it (e.g. “expose
                    the dimensions as parameters”) to make its sizes adjustable here.
                  </div>
                ) : (
                  <>
                    <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
                      {params.map((p) => {
                        const edit = paramEdits[p.name] ?? "";
                        const changed = editChanged(p, edit, unit);
                        const suffix = unitSuffix(p, unit);
                        return (
                          <label key={p.name} className="block">
                            <span
                              className="block text-xs text-neutral-400 mb-1 truncate"
                              title={`${p.label} (${p.name})`}
                            >
                              {cleanLabel(p.label)}
                              {suffix && <span className="text-neutral-500"> ({suffix})</span>}
                              {p.isVector && (
                                <span className="text-neutral-600"> · {p.value.length}-vector</span>
                              )}
                            </span>
                            <input
                              type={p.isVector ? "text" : "number"}
                              step={p.isVector ? undefined : "any"}
                              value={edit}
                              placeholder={p.isVector ? "e.g. 120, 80, 50" : undefined}
                              onFocus={() => setHighlightParam(p.name)}
                              onChange={(e) =>
                                setParamEdits((m) => ({ ...m, [p.name]: e.target.value }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  applyParams();
                                }
                              }}
                              disabled={busy}
                              className={
                                "w-full bg-neutral-900 border rounded px-2 py-1 text-sm outline-none focus:border-neutral-600 " +
                                (changed ? "border-indigo-600" : "border-neutral-800")
                              }
                            />
                          </label>
                        );
                      })}
                    </div>
                    <div className="border-t border-neutral-800 p-3 flex gap-2">
                      <button
                        onClick={resetParams}
                        disabled={busy || !paramsDirty}
                        className="px-3 py-1.5 text-sm rounded border border-neutral-700 hover:bg-neutral-900 disabled:opacity-40"
                      >
                        Reset
                      </button>
                      <button
                        onClick={applyParams}
                        disabled={busy || !paramsDirty}
                        className="flex-1 px-3 py-1.5 text-sm rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {busy ? "Rendering…" : "Apply"}
                      </button>
                    </div>
                  </>
                )}
              </aside>
            )}
          </div>
          {showScad && session.currentScad && (
            <pre className="h-1/2 min-h-0 overflow-auto text-xs bg-neutral-900/40 border border-neutral-800/80 rounded-xl p-3 whitespace-pre shadow-xl shadow-black/30">
              {session.currentScad}
            </pre>
          )}
        </section>
      </div>

      <footer className="flex items-center justify-between gap-4 px-4 py-1.5 border-t border-neutral-800/80 bg-neutral-950/60 text-xs text-neutral-500">
        <span className="truncate">
          {modelDims
            ? `Model ${round1(modelDims[0])} × ${round1(modelDims[1])} × ${round1(modelDims[2])} mm`
            : "No model yet"}
        </span>
        <span className="flex items-center gap-1.5 shrink-0" title="Gemini tokens used (per project)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-400" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M9 9h6M9 12h6M9 15h3" />
          </svg>
          <span className="text-neutral-400">Tokens</span>
          <span className="text-neutral-600">·</span>
          last{" "}
          <span className="tabular-nums text-neutral-300">
            {session.tokensLast != null ? session.tokensLast.toLocaleString() : "—"}
          </span>
          <span className="text-neutral-600">·</span>
          total{" "}
          <span className="tabular-nums text-neutral-300">
            {session.tokensTotal.toLocaleString()}
          </span>
        </span>
      </footer>
    </main>
  );
}
