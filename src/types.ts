import type { Driver } from "./drivers/driver.js";

export type FieldType = "string" | "number" | "boolean" | "date" | "json";

export interface FieldDef {
  type: FieldType;
  required?: boolean;
  unique?: boolean;
  /** A value, or a function returning one. Applied on create when the field is undefined. */
  default?: unknown;
  /** string fields only. Validated on write; becomes a dropdown column in Table mode. */
  enum?: readonly string[];
}

export type Schema = Record<string, FieldType | FieldDef>;

type TypeName<F> = F extends FieldType
  ? F
  : F extends { type: infer T }
    ? T
    : never;
type EnumOf<F> = F extends { enum: readonly (infer E)[] } ? E : never;
type Base<T> = T extends "string"
  ? string
  : T extends "number"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "date"
        ? Date
        : unknown;

export type ValueOf<F> =
  | ([EnumOf<F>] extends [never] ? Base<TypeName<F>> : EnumOf<F>)
  | (F extends { required: true } ? never : null);

export type SystemFields = { id: string; createdAt: Date; updatedAt: Date };

export type Row<S extends Schema> = SystemFields & {
  -readonly [K in keyof S]: ValueOf<S[K]>;
};

type RequiredKeys<S extends Schema> = {
  [K in keyof S]: S[K] extends { required: true }
    ? S[K] extends { default: unknown }
      ? never
      : K
    : never;
}[keyof S];

export type CreateInput<S extends Schema> = { id?: string } & {
  [K in RequiredKeys<S>]: ValueOf<S[K]>;
} & { [K in Exclude<keyof S, RequiredKeys<S>>]?: ValueOf<S[K]> };

export type UpdateInput<S extends Schema> = {
  -readonly [K in keyof S]?: ValueOf<S[K]>;
};

export type InferRow<M> = M extends {
  readonly __schema?: infer S extends Schema;
}
  ? Row<S>
  : never;

export type Operator<T> = {
  eq?: T;
  ne?: T;
  gt?: T;
  gte?: T;
  lt?: T;
  lte?: T;
  in?: readonly T[];
  notIn?: readonly T[];
  contains?: string;
  startsWith?: string;
  endsWith?: string;
};

export type Where<R> =
  | { [K in keyof R]?: R[K] | Operator<NonNullable<R[K]>> }
  | ((row: R) => boolean);

export type OrderBy<R> = { field: keyof R & string; dir?: "asc" | "desc" };

export interface FindOptions<R> {
  where?: Where<R>;
  /** Skip the read cache for this call. */
  fresh?: boolean;
  orderBy?: OrderBy<R> | OrderBy<R>[];
  limit?: number;
  offset?: number;
}

export interface ModelOptions {
  /** Spreadsheet for this model. Defaults to the GSheetDB's spreadsheetId. */
  spreadsheetId?: string;
  /**
   * Where the data lives.
   * - "auto"  (default): a Sheets Table named `table` if it exists, else a tab named `sheet`,
   *                      else a new tab + Table is created.
   * - "table": Tables only. Never falls back to a plain tab that already holds data.
   * - "sheet": plain tab only (header in row 1).
   */
  source?: "auto" | "table" | "sheet";
  /** Table name. Defaults to the model name. */
  table?: string;
  /** Tab name. Defaults to the model name. */
  sheet?: string;
  /** Create the tab / table when missing. Default true. */
  create?: boolean;
  /** Add schema columns that are missing from the header. Default true. */
  migrate?: boolean;
  /** Assign ids to rows added by hand in Sheets (they have no id). Default true. */
  healIds?: boolean;
  /** In-memory read cache. Writes always read fresh and invalidate it. */
  cache?: { ttlMs: number } | false;
  /** Custom storage driver (mainly for tests, see "gsheet-orm/testing"). */
  driver?: Driver;
}
