import type { QueryErrorCode } from "./types";

export class DataQueryError extends Error {
  constructor(public readonly code: QueryErrorCode, message: string) {
    super(message);
    this.name = "DataQueryError";
  }
}
