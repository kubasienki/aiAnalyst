import { describe, expect, it } from "vitest";
import { readGoogleCredentials } from "./google-credentials";

describe("deployed Google credentials", () => {
  it("uses ADC when no JSON variable is configured", () => {
    expect(readGoogleCredentials({})).toBeUndefined();
  });

  it("extracts service-account credentials and preserves private-key newlines", () => {
    const credentials = {
      type: "service_account",
      client_email: "assessment@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----\n",
    };
    expect(readGoogleCredentials({
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...credentials, project_id: "example" }),
    })).toEqual(credentials);
  });

  it.each(["", "secret-invalid-json", "null", '{"type":"authorized_user"}',
    '{"type":"service_account","client_email":"secret","private_key":"secret"}'])(
    "rejects malformed credentials without exposing their contents",
    rawCredentials => {
      expect(() => readGoogleCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: rawCredentials }))
        .toThrow("GOOGLE_SERVICE_ACCOUNT_JSON must contain a valid service-account JSON key.");
    },
  );
});
