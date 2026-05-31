"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Mirror of the server-side LogEntry — kept structural so we don't pull a node
// type into a client component.
export type LogEntry = {
  ts: number;
  route: string;
  status: number;
  durationMs: number;
  error?: string;
  errorName?: string;
  errorStack?: string;
  errorStatus?: number;
  errorCause?: string;
  meta?: Record<string, unknown>;
};

function statusClass(status: number): string {
  if (status >= 500) return "bg-red-900/60 text-red-200 border-red-800";
  if (status >= 400) return "bg-amber-900/50 text-amber-200 border-amber-800";
  if (status >= 300) return "bg-sky-900/50 text-sky-200 border-sky-800";
  return "bg-emerald-900/40 text-emerald-200 border-emerald-800/70";
}

function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function LogRow({ e, now }: { e: LogEntry; now: number }) {
  const [open, setOpen] = useState(false);
  const isErr = e.status >= 400;
  const hasDetail = !!(e.error || e.errorStack || e.errorCause || (e.meta && Object.keys(e.meta).length));

  return (
    <div className={`rounded-lg border px-3 py-2 ${isErr ? "bg-neutral-900/80 border-neutral-800" : "bg-neutral-900/40 border-neutral-800/70"}`}>
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`w-full flex items-center gap-3 text-left ${hasDetail ? "cursor-pointer" : "cursor-default"}`}
      >
        <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-mono border ${statusClass(e.status)}`}>
          {e.status}
        </span>
        <span className="text-sm font-medium text-neutral-100">{e.route}</span>
        <span className="text-xs text-neutral-500 font-mono">{fmtDuration(e.durationMs)}</span>
        <span className="flex-1 text-xs text-neutral-500 truncate" title={e.error}>
          {e.error ?? ""}
        </span>
        <span className="text-[11px] text-neutral-600 shrink-0">{fmtAgo(e.ts, now)}</span>
        {hasDetail && (
          <span className="text-neutral-600 text-xs w-4 text-right">{open ? "▾" : "▸"}</span>
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-2 text-xs">
          {e.errorStatus !== undefined && (
            <div className="text-neutral-400">
              <span className="text-neutral-500">Upstream HTTP:</span> {e.errorStatus}
            </div>
          )}
          {e.errorName && e.errorName !== "Error" && (
            <div className="text-neutral-400">
              <span className="text-neutral-500">Error type:</span> {e.errorName}
            </div>
          )}
          {e.errorStack && (
            <details className="text-neutral-400">
              <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">Stack</summary>
              <pre className="mt-1 p-2 rounded bg-black/40 border border-neutral-800 overflow-x-auto whitespace-pre-wrap break-words text-[11px]">{e.errorStack}</pre>
            </details>
          )}
          {e.errorCause && (
            <details className="text-neutral-400">
              <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">Cause</summary>
              <pre className="mt-1 p-2 rounded bg-black/40 border border-neutral-800 overflow-x-auto whitespace-pre-wrap break-words text-[11px]">{e.errorCause}</pre>
            </details>
          )}
          {e.meta && Object.keys(e.meta).length > 0 && (
            <details className="text-neutral-400">
              <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">Meta</summary>
              <pre className="mt-1 p-2 rounded bg-black/40 border border-neutral-800 overflow-x-auto whitespace-pre-wrap break-words text-[11px]">{JSON.stringify(e.meta, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export default function LogPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "errors">("all");
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/logs?limit=200");
      const data = await res.json();
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setNow(Date.now());
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const clear = useCallback(async () => {
    if (!confirm("Clear all server logs?")) return;
    await fetch("/api/logs", { method: "DELETE" });
    await refresh();
  }, [refresh]);

  // Refresh on open and every 3s while open, so a newly-failed request
  // appears without the user having to click Refresh.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = useMemo(() => {
    const filtered = filter === "errors" ? entries.filter((e) => e.status >= 400) : entries;
    return filtered.slice().reverse(); // newest first
  }, [entries, filter]);

  const errCount = entries.filter((e) => e.status >= 400).length;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6" onClick={onClose}>
      <div
        className="w-full max-w-4xl max-h-[85vh] flex flex-col bg-neutral-950 border border-neutral-800 rounded-xl shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800">
          <h2 className="text-base font-semibold text-neutral-100">Server logs</h2>
          <span className="text-xs text-neutral-500">
            {entries.length} entries{errCount > 0 ? ` · ${errCount} error${errCount === 1 ? "" : "s"}` : ""}
          </span>
          <div className="flex-1" />
          <div className="flex rounded-md border border-neutral-800 overflow-hidden text-xs">
            <button
              onClick={() => setFilter("all")}
              className={`px-2.5 py-1 ${filter === "all" ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"}`}
            >All</button>
            <button
              onClick={() => setFilter("errors")}
              className={`px-2.5 py-1 ${filter === "errors" ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"}`}
            >Errors only</button>
          </div>
          <button onClick={refresh} disabled={loading} className="text-xs px-2.5 py-1 rounded-md border border-neutral-800 text-neutral-300 hover:bg-neutral-900 disabled:opacity-50">
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button onClick={clear} className="text-xs px-2.5 py-1 rounded-md border border-neutral-800 text-neutral-400 hover:text-red-300 hover:border-red-900/60">
            Clear
          </button>
          <button onClick={onClose} className="text-xs px-2.5 py-1 rounded-md text-neutral-400 hover:text-neutral-100">
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {shown.length === 0 ? (
            <div className="h-32 grid place-items-center text-sm text-neutral-600">
              {entries.length === 0 ? "No requests logged yet." : "No errors — nice."}
            </div>
          ) : (
            shown.map((e, i) => <LogRow key={`${e.ts}-${i}`} e={e} now={now} />)
          )}
        </div>
        <div className="px-4 py-2 text-[11px] text-neutral-600 border-t border-neutral-800">
          Logs are also written to <code className="text-neutral-400">.tmp/vibe-make.log</code> and the dev server's stderr.
        </div>
      </div>
    </div>
  );
}
