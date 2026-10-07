import { z } from "zod";

// Every record in this application is identified by a UUID. Kept here so the
// conversation, evidence and analysis contracts share one definition without
// depending on each other.
export const identitySchema = z.uuid();
