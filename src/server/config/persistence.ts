import "server-only";
import { resolve } from "node:path";
import { openConversationRepository } from "../adapters/persistence/repository";

export function readPersistenceConfig(env: Record<string, string | undefined> = process.env) {
  const databasePath = env.SQLITE_DATABASE_PATH?.trim() || ".data/analyst.sqlite";
  return { databasePath: resolve(/* turbopackIgnore: true */ databasePath) };
}

// Explicit construction: importing configuration never opens or creates a database.
export function createConversationRepository() {
  return openConversationRepository(readPersistenceConfig());
}
