import type {
  Cell,
  ColumnSpec,
  DateFormat,
  Driver,
  RawRow,
} from "./drivers/driver.js";

/**
 * In-memory driver for unit-testing code that uses gsheet-orm without touching Google.
 *
 *   const User = db.model("users", schema, { driver: new MemoryDriver() });
 */
export class MemoryDriver implements Driver {
  readonly kind: "table" | "sheet";
  readonly dateFormat: DateFormat;
  header: string[] = [];
  rows: unknown[][] = [];

  constructor(
    opts: {
      kind?: "table" | "sheet";
      header?: string[];
      rows?: unknown[][];
    } = {},
  ) {
    this.kind = opts.kind ?? "sheet";
    this.dateFormat = this.kind === "table" ? "serial" : "iso";
    this.header = opts.header ?? [];
    this.rows = opts.rows ?? [];
  }

  async init(
    columns: ColumnSpec[],
    { migrate }: { migrate: boolean },
  ): Promise<string[]> {
    const missing = columns
      .map((c) => c.name)
      .filter((n) => !this.header.includes(n));
    if (missing.length && migrate) this.header = [...this.header, ...missing];
    return [...this.header];
  }

  async read(): Promise<RawRow[]> {
    return this.rows.map((values, i) => ({
      rowNum: i + 2,
      values: [...values],
    }));
  }

  async append(rows: Cell[][]): Promise<void> {
    this.rows.push(...rows.map((r) => [...r]));
  }

  async update(rows: { rowNum: number; values: Cell[] }[]): Promise<void> {
    for (const { rowNum, values } of rows) this.rows[rowNum - 2] = [...values];
  }

  async remove(rowNums: number[]): Promise<void> {
    for (const n of [...rowNums].sort((a, b) => b - a))
      this.rows.splice(n - 2, 1);
  }
}
