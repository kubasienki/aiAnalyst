import "server-only";
import { jsonValueSchema, type JsonValue } from "../contracts/json";
import { evidenceInputSchema, type EvidenceInput } from "../evidence/contracts";
import { ContextError } from "./contracts";
import { recoverableToolErrorSchema } from "../agent/contracts";

// Shared by history projection and future live tool delivery. Database ownership
// fields stay outside the model payload; analytical provenance stays inside it.
export function projectEvidence(input: EvidenceInput): JsonValue {
  const parsed = evidenceInputSchema.safeParse({
    evidence: input.evidence,
    semanticGuideSnapshot: input.semanticGuideSnapshot,
    declaredScope: input.declaredScope,
    assumptions: input.assumptions,
  });
  if (!parsed.success) {
    throw new ContextError("invalid_history", "The query evidence is invalid.");
  }
  // JSON encoding omits optional undefined properties, just as provider delivery
  // does. Parse back through the JSON contract rather than casting domain types.
  return jsonValueSchema.parse(JSON.parse(JSON.stringify({ ok: true, ...parsed.data })));
}

export function projectUnavailableEvidence(evidenceId: string, content: JsonValue): JsonValue {
  // New feedback is self-contained and replays exactly as delivered. Older
  // records used a wrapper; retain their reference rather than dropping it.
  if (content !== null && typeof content === "object" && !Array.isArray(content) && content.ok === false) {
    const error = recoverableToolErrorSchema.safeParse(content.error);
    if (error.success && error.data.details?.evidenceId === evidenceId) {
      return content;
    }
  }
  return { kind: "evidence_unavailable", evidenceId, content };
}
