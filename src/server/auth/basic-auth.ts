import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

export type AccessDecision = "allow" | "unauthorized" | "unconfigured";

export function checkBasicAuth(
  authorization: string | null,
  env: NodeJS.ProcessEnv = process.env,
): AccessDecision {
  const username = env.BASIC_AUTH_USERNAME;
  const password = env.BASIC_AUTH_PASSWORD;

  // Local development remains convenient; production must never silently open.
  if (!username && !password && env.NODE_ENV === "development") {
    return "allow";
  }

  if (!username || !password || username.includes(":")) {
    return "unconfigured";
  }

  const match = authorization?.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) {
    return "unauthorized";
  }

  const suppliedCredentials = Buffer.from(match[1], "base64");
  const expectedCredentials = Buffer.from(`${username}:${password}`, "utf8");

  // Fixed-size digests avoid timing differences from password content or length.
  const suppliedDigest = createHash("sha256").update(suppliedCredentials).digest();
  const expectedDigest = createHash("sha256").update(expectedCredentials).digest();

  if (!timingSafeEqual(suppliedDigest, expectedDigest)) {
    return "unauthorized";
  }

  return "allow";
}
