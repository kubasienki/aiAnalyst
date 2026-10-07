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

  it("allows cross-site safe requests so browsers can load the assessment", () => {
    vi.stubEnv("BASIC_AUTH_USERNAME", credentials.BASIC_AUTH_USERNAME);
    vi.stubEnv("BASIC_AUTH_PASSWORD", credentials.BASIC_AUTH_PASSWORD);
    const request = new NextRequest("https://assessment.example/api/conversations", {
      method: "GET",
      headers: { authorization, "sec-fetch-site": "cross-site" },
    });
    expect(proxy(request).headers.get("x-middleware-next")).toBe("1");
  });

  it("rejects cross-site state changes using the origin header", () => {
    vi.stubEnv("BASIC_AUTH_USERNAME", credentials.BASIC_AUTH_USERNAME);
    vi.stubEnv("BASIC_AUTH_PASSWORD", credentials.BASIC_AUTH_PASSWORD);
    const request = new NextRequest("https://assessment.example/api/conversations", {
      method: "POST",
      headers: { authorization, origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    });
    expect(proxy(request).status).toBe(403);
  });

  it("allows same-origin state changes", () => {
    vi.stubEnv("BASIC_AUTH_USERNAME", credentials.BASIC_AUTH_USERNAME);
    vi.stubEnv("BASIC_AUTH_PASSWORD", credentials.BASIC_AUTH_PASSWORD);
    const request = new NextRequest("https://assessment.example/api/conversations", {
      method: "POST",
      headers: { authorization, origin: "https://assessment.example" },
    });
    expect(proxy(request).headers.get("x-middleware-next")).toBe("1");
  });

  it("matches the public origin when Railway forwards requests over HTTP", () => {
    vi.stubEnv("BASIC_AUTH_USERNAME", credentials.BASIC_AUTH_USERNAME);
    vi.stubEnv("BASIC_AUTH_PASSWORD", credentials.BASIC_AUTH_PASSWORD);
    const request = new NextRequest("http://10.0.0.8:3000/api/conversations", {
      method: "POST",
      headers: {
        authorization,
        origin: "https://assessment.example",
        host: "10.0.0.8:3000",
        "x-forwarded-host": "assessment.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(proxy(request).headers.get("x-middleware-next")).toBe("1");
  });
});
