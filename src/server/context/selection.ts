import "server-only";
import { ContextError, type ContextSelection, type ReconstructedHistory } from "./contracts";

// V1 retains complete history. Future compaction changes selection, not storage
// or reconstruction; complete tool interactions remain indivisible.
export function selectContext(history: ReconstructedHistory): ContextSelection {
  const selection: ContextSelection = { interactions: [], excludedInteractions: [] };
  for (const interaction of history.interactions) {
    if (interaction.complete) {
      selection.interactions.push(interaction);
      continue;
    }
    const run = history.runs.get(interaction.runId);
    const assistant = interaction.events[0];
    if (!run || run.status === "running" || !assistant) {
      throw new ContextError("invalid_history", "A model continuation requires all active tool results.");
    }
    selection.excludedInteractions.push({
      runId: run.id,
      assistantEventId: assistant.id,
      eventIds: interaction.events.map(event => event.id),
      reason: "incomplete_interaction",
    });
  }
  return selection;
}
