// Named projects, persisted in localStorage. A project stores the chat history
// (the prompts) and the current SCAD so a user can reload and keep iterating.
// We deliberately do NOT store the rendered STL — it's large and fully derivable
// from the SCAD, so we re-render it on load instead of bloating storage.

import type { ChatTurn } from "@/lib/gemini";

export type Project = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  history: ChatTurn[];
  scad: string;
  tokensTotal?: number; // cumulative LLM tokens spent on this project
};

const KEY = "vibe-make:projects:v1";

export function listProjects(): Project[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Project[];
    if (!Array.isArray(arr)) return [];
    return arr.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function writeAll(projects: Project[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(projects));
  } catch {
    // Quota exceeded — without the STL a project is small, so this is unlikely.
  }
}

export function upsertProject(p: Project): Project[] {
  const all = listProjects();
  const i = all.findIndex((x) => x.id === p.id);
  if (i >= 0) all[i] = p;
  else all.push(p);
  writeAll(all);
  return listProjects();
}

export function deleteProject(id: string): Project[] {
  const all = listProjects().filter((p) => p.id !== id);
  writeAll(all);
  return all;
}

export function newProjectId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
