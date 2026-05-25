"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { ViewerHandle } from "@/components/Viewer";

const Viewer = dynamic(() => import("@/components/Viewer"), { ssr: false });

type ChatTurn = { role: "user" | "assistant"; text: string };

type SessionState = {
  history: ChatTurn[];
  currentScad: string | null;
  stlBase64: string | null;
};

const STORAGE_KEY = "vibe-make:session:v1";

const EMPTY: SessionState = { history: [], currentScad: null, stlBase64: null };

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

export default function Home() {
  const [session, setSession] = useState<SessionState>(EMPTY);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScad, setShowScad] = useState(false);
  const viewerRef = useRef<ViewerHandle | null>(null);

  useEffect(() => { setSession(loadSession()); }, []);
  useEffect(() => { saveSession(session); }, [session]);

  const submit = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);

    const userTurn: ChatTurn = { role: "user", text: prompt.trim() };
    const previewImageBase64 =
      session.currentScad && viewerRef.current ? viewerRef.current.capturePng() : null;

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: userTurn.text,
          currentScad: session.currentScad,
          previewImageBase64,
          history: session.history,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || `Request failed (${res.status})`);
        if (data.scad) {
          setSession((s) => ({
            history: [...s.history, userTurn, { role: "assistant", text: "(SCAD generated but failed to render)" }],
            currentScad: data.scad,
            stlBase64: s.stlBase64,
          }));
        }
        return;
      }

      setSession((s) => ({
        history: [...s.history, userTurn, { role: "assistant", text: "Updated the model." }],
        currentScad: data.scad,
        stlBase64: data.stlBase64,
      }));
      setPrompt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }, [prompt, busy, session]);

  const onExport = useCallback(
    async (format: "stl" | "obj" | "scad") => {
      if (!session.currentScad) return;
      try {
        const res = await fetch("/api/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scad: session.currentScad, format, filename: "vibe-make" }),
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
        a.download = `vibe-make.${format}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Download failed");
      }
    },
    [session.currentScad]
  );

  const onNewProject = useCallback(() => {
    if (!confirm("Start a new project? Current work will be cleared.")) return;
    setSession(EMPTY);
    setPrompt("");
    setError(null);
  }, []);

  return (
    <main className="h-screen w-screen flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
        <h1 className="text-lg font-semibold tracking-tight">vibe-make</h1>
        <div className="flex gap-2 text-sm">
          <button
            className="px-3 py-1.5 rounded border border-neutral-700 hover:bg-neutral-900 disabled:opacity-40"
            disabled={!session.currentScad}
            onClick={() => setShowScad((v) => !v)}
          >
            {showScad ? "Hide SCAD" : "Show SCAD"}
          </button>
          <button
            className="px-3 py-1.5 rounded border border-neutral-700 hover:bg-neutral-900 disabled:opacity-40"
            disabled={!session.currentScad}
            onClick={() => onExport("stl")}
          >
            Export STL
          </button>
          <button
            className="px-3 py-1.5 rounded border border-neutral-700 hover:bg-neutral-900 disabled:opacity-40"
            disabled={!session.currentScad}
            onClick={() => onExport("obj")}
          >
            Export OBJ
          </button>
          <button
            className="px-3 py-1.5 rounded border border-neutral-700 hover:bg-neutral-900 disabled:opacity-40"
            disabled={!session.currentScad}
            onClick={() => onExport("scad")}
          >
            Export SCAD
          </button>
          <button
            className="px-3 py-1.5 rounded border border-neutral-700 hover:bg-neutral-900"
            onClick={onNewProject}
          >
            New
          </button>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-12 gap-3 p-3 min-h-0">
        <aside className="col-span-4 flex flex-col min-h-0 bg-neutral-950 border border-neutral-800 rounded-lg">
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {session.history.length === 0 && (
              <div className="text-sm text-neutral-500">
                Describe what you want to make. Example:
                <br />
                <em className="text-neutral-400">
                  &quot;A hexagonal pen holder, 80mm tall, 40mm inner diameter, 3mm walls&quot;
                </em>
              </div>
            )}
            {session.history.map((m, i) => (
              <div
                key={i}
                className={
                  "text-sm rounded px-3 py-2 " +
                  (m.role === "user"
                    ? "bg-neutral-900 border border-neutral-800"
                    : "bg-neutral-800/40 border border-neutral-800 text-neutral-300")
                }
              >
                <div className="text-xs uppercase tracking-wide text-neutral-500 mb-1">
                  {m.role}
                </div>
                {m.text}
              </div>
            ))}
            {busy && (
              <div className="text-sm text-neutral-400 italic">Thinking and rendering…</div>
            )}
            {error && (
              <div className="text-sm rounded px-3 py-2 bg-red-950/40 border border-red-900 text-red-200 whitespace-pre-wrap">
                {error}
              </div>
            )}
          </div>

          <div className="border-t border-neutral-800 p-3">
            <textarea
              className="w-full bg-neutral-900 border border-neutral-800 rounded p-2 text-sm resize-none h-24 outline-none focus:border-neutral-600"
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
            <div className="flex justify-between items-center mt-2">
              <span className="text-xs text-neutral-500">Ctrl/Cmd + Enter to send</span>
              <button
                onClick={submit}
                disabled={busy || !prompt.trim()}
                className="px-4 py-1.5 text-sm rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy ? "Working…" : session.currentScad ? "Refine" : "Generate"}
              </button>
            </div>
          </div>
        </aside>

        <section className="col-span-8 min-h-0 flex flex-col gap-3">
          <div className={showScad ? "h-1/2 min-h-0" : "flex-1 min-h-0"}>
            <Viewer
              stlBase64={session.stlBase64}
              onReady={(h) => { viewerRef.current = h; }}
            />
          </div>
          {showScad && session.currentScad && (
            <pre className="h-1/2 min-h-0 overflow-auto text-xs bg-neutral-950 border border-neutral-800 rounded p-3 whitespace-pre">
              {session.currentScad}
            </pre>
          )}
        </section>
      </div>
    </main>
  );
}
