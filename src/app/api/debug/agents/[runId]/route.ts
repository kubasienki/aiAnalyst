import { z } from "zod";
import { NextResponse } from "next/server";
import { readDebugRun } from "../../../../../server/debug/agent-traces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const hostname = new URL(request.url).hostname;
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
  try {
    const { runId } = await context.params;
    const run = readDebugRun(z.uuid().parse(runId));
    if (run === null) {
      return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(run, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unavailable";
    const status = reason === "not_available" ? 404 : 503;
    return NextResponse.json({ error: reason }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
