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

  // Browsers can replay Basic Auth automatically. Reject cross-site requests
  // before they can submit paid analytical work or read assessment history.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
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
