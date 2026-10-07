import "server-only";

import { z } from "zod";

const serviceAccountSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.email(),
  private_key: z.string().min(1),
});

export function readGoogleCredentials(env: Record<string, string | undefined> = process.env) {
  const rawCredentials = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (rawCredentials === undefined) {
    // Keep ADC support for local development and attached Google identities.
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(rawCredentials);
    return serviceAccountSchema.parse(parsed);
  } catch {
    // JSON and schema errors can contain credential values; never expose them.
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must contain a valid service-account JSON key.");
  }
}
