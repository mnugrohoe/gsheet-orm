import type { FieldType } from "../types.js";

export type Cell = string | number | boolean | null;
export type DateFormat = "serial" | "iso";

export interface ColumnSpec {
  name: string;
  type: FieldType;
  enum?: readonly string[];
}

export interface RawRow {
  /** 1-based row number in the spreadsheet. */
  rowNum: number;
  values: unknown[];
}

/** Storage backend for one model: a Sheets Table, a plain tab, or an in-memory fake. */
export interface Driver {
  readonly kind: "table" | "sheet";
  /** How Date values are written. Tables use real date serials, plain tabs use ISO strings. */
  readonly dateFormat: DateFormat;
  /** Locate or create the storage, make sure all columns exist, return the header (column order). */
  init(columns: ColumnSpec[], opts: { migrate: boolean }): Promise<string[]>;
  /** All data rows (header and footer excluded). May include blank rows. */
  read(): Promise<RawRow[]>;
  append(rows: Cell[][]): Promise<void>;
  update(rows: { rowNum: number; values: Cell[] }[]): Promise<void>;
  remove(rowNums: number[]): Promise<void>;
}
