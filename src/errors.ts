export type ErrorCode = "CONFIG" | "SCHEMA" | "VALIDATION" | "UNIQUE" | "SHARD" | "API";

export class GSheetError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GSheetError";
    this.code = code;
  }
}
