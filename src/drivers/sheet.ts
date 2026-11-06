import { colLetter, quoteSheet } from "../a1.js";
import type { SheetsApiLike } from "../client.js";
import { GSheetError } from "../errors.js";
import type { Cell, ColumnSpec, DateFormat, Driver, RawRow } from "./driver.js";

export interface SheetDriverConfig {
  tabName: string;
  /** false = the tab does not exist yet and init() must create it (when create is allowed). */
  existing: boolean;
  create: boolean;
}

/** Stores rows in a plain tab: header in row 1, data from row 2. */
export class SheetDriver implements Driver {
  readonly kind = "sheet" as const;
  readonly dateFormat: DateFormat = "iso";

  private sheetId?: number;
  private width = 0;

  constructor(
    private readonly api: SheetsApiLike,
    private readonly cfg: SheetDriverConfig,
  ) {}

  private get q() {
    return quoteSheet(this.cfg.tabName);
  }

  async init(
    columns: ColumnSpec[],
    { migrate }: { migrate: boolean },
  ): Promise<string[]> {
    const sheets = await this.api.listSheets();
    let tab = sheets.find((s) => s.title === this.cfg.tabName);

    if (!tab) {
      if (!this.cfg.create)
        throw new GSheetError("SCHEMA", `Tab "${this.cfg.tabName}" not found`);
      const res = await this.api.batchUpdate([
        {
          addSheet: {
            properties: {
              title: this.cfg.tabName,
              gridProperties: { columnCount: Math.max(26, columns.length) },
            },
          },
        },
      ]);
      const sheetId: number = res.replies?.[0]?.addSheet?.properties?.sheetId;
      tab = { sheetId, title: this.cfg.tabName, tables: [] };
    }
    this.sheetId = tab.sheetId;

    const first = await this.api.getValues(`${this.q}!1:1`);
    const existing = (first[0] ?? [])
      .map((c) => String(c ?? ""))
      .filter(Boolean);
    const missing = columns.filter((c) => !existing.includes(c.name));

    if (missing.length && !migrate && existing.length) {
      throw new GSheetError(
        "SCHEMA",
        `Tab "${this.cfg.tabName}" is missing column(s): ${missing.map((m) => m.name).join(", ")}`,
      );
    }

    const header = [...existing, ...missing.map((m) => m.name)];
    if (missing.length) {
      await this.api.updateValues(`${this.q}!A1`, [header]);
    }
    this.width = header.length;
    return header;
  }

  async read(): Promise<RawRow[]> {
    const values = await this.api.getValues(
      `${this.q}!A2:${colLetter(this.width)}`,
    );
    return values.map((v, i) => ({ rowNum: i + 2, values: v }));
  }

  async append(rows: Cell[][]): Promise<void> {
    if (!rows.length) return;
    await this.api.appendValues(
      `${this.q}!A1`,
      rows.map((r) => Array.from({ length: this.width }, (_, i) => r[i] ?? "")),
    );
  }

  async update(rows: { rowNum: number; values: Cell[] }[]): Promise<void> {
    if (!rows.length) return;
    const last = colLetter(this.width);
    await this.api.batchUpdateValues(
      rows.map(({ rowNum, values }) => ({
        range: `${this.q}!A${rowNum}:${last}${rowNum}`,
        values: [Array.from({ length: this.width }, (_, i) => values[i] ?? "")],
      })),
    );
  }

  async remove(rowNums: number[]): Promise<void> {
    if (!rowNums.length) return;
    const requests = [...rowNums]
      .sort((a, b) => b - a)
      .map((rowNum) => ({
        deleteDimension: {
          range: {
            sheetId: this.sheetId,
            dimension: "ROWS",
            startIndex: rowNum - 1,
            endIndex: rowNum,
          },
        },
      }));
    await this.api.batchUpdate(requests);
  }
}
