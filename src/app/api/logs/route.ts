import { NextRequest, NextResponse } from "next/server";
import { readRecentLogs, clearLogs } from "@/lib/log";

export const runtime = "nodejs";

// GET /api/logs?limit=200  — newest at the end
export async function GET(req: NextRequest) {
  const limitParam = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, 1000)
    : 200;
  const entries = await readRecentLogs(limit);
  return NextResponse.json({ entries });
}

// DELETE /api/logs — wipe the log file
export async function DELETE() {
  await clearLogs();
  return NextResponse.json({ ok: true });
}
