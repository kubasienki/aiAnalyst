import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readPersistenceConfig } from "./persistence";

describe("persistence configuration", () => {
  it("uses the ignored local database path without opening a connection", () => {
    expect(readPersistenceConfig({})).toEqual({ databasePath: resolve(".data/analyst.sqlite") });
  });

  it("resolves a configured path independently of model and BigQuery configuration", () => {
    expect(readPersistenceConfig({ SQLITE_DATABASE_PATH: " /tmp/assessment-history.sqlite " }))
      .toEqual({ databasePath: "/tmp/assessment-history.sqlite" });
  });
});
