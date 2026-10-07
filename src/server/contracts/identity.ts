import { z } from "zod";

// Every record in this application is identified by a UUID. Kept here so the
// conversation, evidence and analysis contracts share one definition without
// depending on each other.
export const identitySchema = z.uuid();

// Provider request IDs and BigQuery job IDs are logged and stored, so only
// accept a conservative character set that cannot carry markup or newlines.
const EXTERNAL_IDENTIFIER = /^[a-zA-Z0-9._:/-]{1,200}$/;

export const externalIdentifierSchema = z.string().regex(EXTERNAL_IDENTIFIER);

export function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && EXTERNAL_IDENTIFIER.test(value) ? value : undefined;
}
