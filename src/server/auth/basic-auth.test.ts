import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../../proxy";
import { checkBasicAuth } from "./basic-auth";

const credentials = {
  NODE_ENV: "production" as const,
  BASIC_AUTH_USERNAME: "reviewer",
  BASIC_AUTH_PASSWORD: "assessment:password",
};
const authorization = `Basic ${Buffer.from("reviewer:assessment:password").toString("base64")}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("assessment access protection", () => {
  it("accepts the configured credentials, including colons in passwords", () => {
    expect(checkBasicAuth(authorization, credentials)).toBe("allow");
  });

  it.each([null, "Bearer token", "Basic !!!", "Basic cmV2aWV3ZXI6d3Jvbmc="])(
    "rejects absent, malformed, or incorrect credentials: %s",
    header => {
      expect(checkBasicAuth(header, credentials)).toBe("unauthorized");
    },
  );

  it("fails closed in production for absent or partially configured protection", () => {
    expect(checkBasicAuth(null, { NODE_ENV: "production" })).toBe("unconfigured");
    expect(checkBasicAuth(null, { ...credentials, BASIC_AUTH_PASSWORD: "" })).toBe("unconfigured");
    expect(checkBasicAuth(null, { ...credentials, BASIC_AUTH_USERNAME: "invalid:user" })).toBe("unconfigured");
  });

  it("permits unconfigured development but rejects partial configuration", () => {
    expect(checkBasicAuth(null, { NODE_ENV: "development" })).toBe("allow");
    expect(checkBasicAuth(null, {
      NODE_ENV: "development",
      BASIC_AUTH_USERNAME: "reviewer",
    })).toBe("unconfigured");
  });

  it.each(["/", "/api/conversations", "/api/debug/agents", "/_next/static/example.js"])(
    "challenges requests to %s and forwards authenticated requests",
    path => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("BASIC_AUTH_USERNAME", credentials.BASIC_AUTH_USERNAME);
      vi.stubEnv("BASIC_AUTH_PASSWORD", credentials.BASIC_AUTH_PASSWORD);
      const url = `https://assessment.example${path}`;
      const rejected = proxy(new NextRequest(url));
      expect(rejected.status).toBe(401);
      expect(rejected.headers.get("www-authenticate")).toContain("Basic");
      const accepted = proxy(new NextRequest(url, { headers: { authorization } }));
      expect(accepted.headers.get("x-middleware-next")).toBe("1");
      expect(accepted.headers.get("cache-control")).toBe("private, no-store");
    },
  );

  it("rejects cross-site requests even with valid credentials", () => {
    vi.stubEnv("BASIC_AUTH_USERNAME", credentials.BASIC_AUTH_USERNAME);
    vi.stubEnv("BASIC_AUTH_PASSWORD", credentials.BASIC_AUTH_PASSWORD);
    const request = new NextRequest("https://assessment.example/api/conversations", {
      method: "POST",
      headers: { authorization, "sec-fetch-site": "cross-site" },
    });
    expect(proxy(request).status).toBe(403);
  });
});
