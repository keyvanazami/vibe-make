// Lightweight request logger for the API routes.
//
// Each request writes one JSON line to BOTH stderr (so it shows up in the
// `npm run dev` terminal) and `.tmp/vibe-make.log` (so it survives terminal
// scrollback). The /api/logs route reads the file back for the in-app panel.
//
// Design notes:
//   - File writes are fire-and-forget to keep the request path fast. Order
//     across requests can interleave by a few ms; we don't care for dev logs.
//   - When the file grows past MAX_BYTES we truncate to the most-recent half.
//     This is checked every ROTATE_EVERY writes — cheap and bounded.
//   - We try hard to capture every useful field from the thrown error: the
//     @google/genai SDK puts the HTTP status on `.status` and the upstream
//     body on `.cause`, both of which `err.message` alone hides.

import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOG_DIR = join(process.cwd(), ".tmp");
const LOG_FILE = join(LOG_DIR, "vibe-make.log");
const MAX_BYTES = 5 * 1024 * 1024;
const ROTATE_EVERY = 100;

export type LogEntry = {
  ts: number;
  route: string;
  status: number;
  durationMs: number;
  error?: string;
  errorName?: string;
  errorStack?: string;
  errorStatus?: number; // http status surfaced by SDKs (e.g. Gemini 429/500)
  errorCause?: string;  // serialized .cause if present
  meta?: Record<string, unknown>;
};

let dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  if (!dirReady) dirReady = mkdir(LOG_DIR, { recursive: true }).then(() => {});
  return dirReady;
}

let writeCount = 0;
async function maybeRotate(): Promise<void> {
  try {
    const st = await stat(LOG_FILE);
    if (st.size <= MAX_BYTES) return;
    const text = await readFile(LOG_FILE, "utf8");
    const lines = text.split("\n").filter(Boolean);
    const keep = lines.slice(-Math.floor(lines.length / 2));
    await writeFile(LOG_FILE, keep.join("\n") + "\n", "utf8");
  } catch {
    // ignore — logging must never fail the request
  }
}

function serializeError(err: unknown): {
  error: string;
  errorName?: string;
  errorStack?: string;
  errorStatus?: number;
  errorCause?: string;
} {
  if (err instanceof Error) {
    const out: ReturnType<typeof serializeError> = {
      error: err.message,
      errorName: err.name,
      errorStack: err.stack,
    };
    // Many SDKs (including @google/genai) attach an HTTP status and the raw
    // upstream body. Surface both so the panel shows them.
    const anyErr = err as unknown as Record<string, unknown>;
    if (typeof anyErr.status === "number") out.errorStatus = anyErr.status;
    if (typeof anyErr.statusCode === "number" && out.errorStatus == null) {
      out.errorStatus = anyErr.statusCode as number;
    }
    if (err.cause !== undefined && err.cause !== null) {
      try {
        out.errorCause = typeof err.cause === "string"
          ? err.cause
          : JSON.stringify(err.cause, replaceUndefined, 2);
      } catch {
        out.errorCause = String(err.cause);
      }
    }
    return out;
  }
  if (typeof err === "string") return { error: err };
  try { return { error: JSON.stringify(err) }; } catch { return { error: String(err) }; }
}

function replaceUndefined(_k: string, v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
  return v;
}

function dispatch(entry: LogEntry): void {
  const line = JSON.stringify(entry);
  // Synchronous stderr write: shows up immediately in the dev terminal, even
  // if the process exits before async file IO settles.
  try { process.stderr.write(line + "\n"); } catch { /* noop */ }
  // Async file write — best effort.
  void (async () => {
    try {
      await ensureDir();
      await appendFile(LOG_FILE, line + "\n", "utf8");
      if (++writeCount % ROTATE_EVERY === 0) await maybeRotate();
    } catch {
      // Never throw from logging.
    }
  })();
}

// --- Public API -----------------------------------------------------------

export type LogContext = {
  route: string;
  start: number;
  meta: Record<string, unknown>;
};

export function startLog(route: string, meta: Record<string, unknown> = {}): LogContext {
  return { route, start: Date.now(), meta };
}

export function finishLog(ctx: LogContext, status: number, err?: unknown): void {
  const entry: LogEntry = {
    ts: Date.now(),
    route: ctx.route,
    status,
    durationMs: Date.now() - ctx.start,
    meta: Object.keys(ctx.meta).length ? ctx.meta : undefined,
  };
  if (err !== undefined) Object.assign(entry, serializeError(err));
  dispatch(entry);
}

export async function readRecentLogs(limit = 200): Promise<LogEntry[]> {
  try {
    const text = await readFile(LOG_FILE, "utf8");
    const lines = text.split("\n").filter(Boolean);
    const tail = lines.slice(-limit);
    const out: LogEntry[] = [];
    for (const l of tail) {
      try { out.push(JSON.parse(l) as LogEntry); } catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return [];
  }
}

export async function clearLogs(): Promise<void> {
  try {
    await ensureDir();
    await writeFile(LOG_FILE, "", "utf8");
  } catch {
    // ignore
  }
}
