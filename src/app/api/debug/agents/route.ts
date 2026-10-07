import { NextResponse } from "next/server";
import { listDebugRuns } from "../../../../server/debug/agent-traces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isLocalRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export async function GET(request: Request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
  try {
    return NextResponse.json({ runs: listDebugRuns() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unavailable";
    const status = reason === "not_available" ? 404 : 503;
    return NextResponse.json({ error: reason }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
