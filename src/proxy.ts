import { NextResponse, type NextRequest } from "next/server";
import { checkBasicAuth } from "./server/auth/basic-auth";

export function proxy(request: NextRequest) {
  const decision = checkBasicAuth(request.headers.get("authorization"));

  if (decision === "unconfigured") {
    return new NextResponse("Access protection is not configured.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (decision === "unauthorized") {
    return new NextResponse("Authentication required.", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="HockeyStack assessment", charset="UTF-8"',
        "Cache-Control": "no-store",
      },
    });
  }

  // Basic Auth is replayed by browsers. Check the origin of state-changing
  // requests so unrelated sites cannot submit questions using cached credentials.
  const changesState = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  const requestOrigin = request.headers.get("origin");
  const hasCrossSiteFetch = request.headers.get("sec-fetch-site") === "cross-site";
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const publicHost = forwardedHost || request.headers.get("host");
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const publicProtocol = forwardedProtocol || request.nextUrl.protocol.replace(":", "");
  let expectedOrigin = request.nextUrl.origin;
  if (publicHost) {
    try {
      expectedOrigin = new URL(`${publicProtocol}://${publicHost}`).origin;
    } catch {
      // Keep the request URL as the fallback if proxy metadata is malformed.
    }
  }
  let originDoesNotMatch = false;
  if (requestOrigin !== null) {
    try {
      originDoesNotMatch = new URL(requestOrigin).origin !== expectedOrigin;
    } catch {
      originDoesNotMatch = true;
    }
  }

  if (changesState && (originDoesNotMatch || (requestOrigin === null && hasCrossSiteFetch))) {
    return new NextResponse("Cross-site access is not allowed.", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: "/:path*",
};
