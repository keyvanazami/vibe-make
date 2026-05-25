"use client";

import { useEffect, useState } from "react";

// Whimsical status lines shown while a generation/render is in flight. Themed
// around OpenSCAD / 3D-printing so they feel relevant, not generic.
const MESSAGES = [
  "Extruding polygons…",
  "Tessellating surfaces…",
  "Carving geometry…",
  "Summoning vertices…",
  "Negotiating with OpenSCAD…",
  "Booleaning solids…",
  "Smoothing curves…",
  "Aligning to the XY plane…",
  "Computing manifolds…",
  "Sculpting…",
  "Measuring twice, cutting once…",
  "Convincing triangles to cooperate…",
  "Polishing edges…",
  "Untangling normals…",
  "Chamfering corners…",
  "Calibrating millimeters…",
  "Rendering the mesh…",
  "Consulting the third dimension…",
];

function pickDifferent(current: string): string {
  if (MESSAGES.length < 2) return MESSAGES[0];
  let next = current;
  while (next === current) {
    next = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
  }
  return next;
}

// When `label` is given, show that fixed text (e.g. "Exporting STL…"); otherwise
// cycle the whimsical generation messages.
export default function WorkingIndicator({ label }: { label?: string }) {
  const [msg, setMsg] = useState(() => MESSAGES[Math.floor(Math.random() * MESSAGES.length)]);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const secTimer = setInterval(() => setSeconds((s) => s + 1), 1000);
    if (label) return () => clearInterval(secTimer);
    const msgTimer = setInterval(() => setMsg((cur) => pickDifferent(cur)), 2500);
    return () => {
      clearInterval(msgTimer);
      clearInterval(secTimer);
    };
  }, [label]);

  return (
    <div className="flex items-center gap-2 text-sm text-neutral-400">
      <span
        className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-neutral-700 border-t-indigo-400 animate-spin"
        aria-hidden
      />
      <span className="italic transition-opacity duration-300">{label ?? msg}</span>
      <span className="text-xs text-neutral-600 tabular-nums">{seconds}s</span>
    </div>
  );
}
