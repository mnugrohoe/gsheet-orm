import { colLetter, quoteSheet } from "../a1.js";
import type { SheetsApiLike, TableMeta } from "../client.js";
import { GSheetError } from "../errors.js";
import { ROW_BUFFER, addColumnsRequest, addRowsRequest, isGridError } from "./grow.js";
import type { Cell, ColumnSpec, DateFormat, Driver, RawRow } from "./driver.js";

const COLUMN_TYPE = {
  string: "TEXT",
  number: "DOUBLE",
  boolean: "BOOLEAN",
  date: "DATE_TIME",
  json: "TEXT",
} as const;

export function columnProperty(c: ColumnSpec, index: number) {
  return {
    columnIndex: index,
    columnName: c.name,
    columnType: c.enum ? "DROPDOWN" : COLUMN_TYPE[c.type],
    ...(c.enum
      ? {
          dataValidationRule: {
            condition: {
              type: "ONE_OF_LIST",
              values: c.enum.map((v) => ({ userEnteredValue: v })),
            },
          },
        }
      : {}),
  };
}

const cellData = (v: Cell) =>
  v === null
    ? {}
    : typeof v === "number"
      ? { userEnteredValue: { numberValue: v } }
      : typeof v === "boolean"
        ? { userEnteredValue: { boolValue: v } }
        : { userEnteredValue: { stringValue: v } };

export interface TableDriverConfig {
  tableName: string;
  tabName: string;
  /** false = the table does not exist yet and init() must create it. */
  existing: boolean;
}

/** Stores rows in a Google Sheets Table (header + typed columns + auto-expanding range). */
export class TableDriver implements Driver {
  readonly kind = "table" as const;
  readonly dateFormat: DateFormat = "serial";

  private tableId?: string;
  private meta?: TableMeta;

  constructor(
    private readonly api: SheetsApiLike,
    private readonly cfg: TableDriverConfig,
  ) {}

  async init(columns: ColumnSpec[], { migrate }: { migrate: boolean }): Promise<string[]> {
    if (!this.cfg.existing) await this.createTable(columns);

    let meta = await this.fetchMeta();
    let header = await this.readHeader(meta);

    const missing = columns.filter((c) => !header.includes(c.name));
    if (missing.length) {
      if (!migrate) {
        throw new GSheetError(
          "SCHEMA",
          `Table "${this.cfg.tableName}" is missing column(s): ${missing.map((m) => m.name).join(", ")}`,
        );
      }
      await this.addColumns(meta, missing);
      meta = await this.fetchMeta();
      header = await this.readHeader(meta);
    }
    return header;
  }

  private async createTable(columns: ColumnSpec[]) {
    const sheets = await this.api.listSheets();
    const tab = sheets.find((s) => s.title === this.cfg.tabName);
    const q = quoteSheet(this.cfg.tabName);
    let sheetId: number;

    if (tab) {
      sheetId = tab.sheetId;
      const grow = [];
      if (tab.columnCount !== undefined && columns.length > tab.columnCount) {
        grow.push(addColumnsRequest(sheetId, columns.length - tab.columnCount));
      }
      if (tab.rowCount !== undefined && tab.rowCount < 2) grow.push(addRowsRequest(sheetId, 2 - tab.rowCount));
      if (grow.length) await this.api.batchUpdate(grow);
      const first = await this.api.getValues(`${q}!1:1`);
      if (first[0]?.some((c) => c !== "" && c != null)) {
        throw new GSheetError(
          "SCHEMA",
          `Tab "${this.cfg.tabName}" already has data but no Table named "${this.cfg.tableName}". ` +
            `Use source: "sheet" (or "auto"), or convert the range to a table in Google Sheets first.`,
        );
      }
    } else {
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
      sheetId = res.replies?.[0]?.addSheet?.properties?.sheetId;
    }

    await this.api.updateValues(`${q}!A1`, [columns.map((c) => c.name)]);
    await this.api.batchUpdate([
      {
        addTable: {
          table: {
            name: this.cfg.tableName,
            range: {
              sheetId,
              startRowIndex: 0,
              endRowIndex: 2, // header + one empty row; appendCells fills it first
              startColumnIndex: 0,
              endColumnIndex: columns.length,
            },
            columnProperties: columns.map(columnProperty),
          },
        },
      },
    ]);
  }

  private async fetchMeta(): Promise<TableMeta> {
    const sheets = await this.api.listSheets();
    for (const s of sheets) {
      const t = s.tables.find((t) => (this.tableId ? t.tableId === this.tableId : t.name === this.cfg.tableName));
      if (t) {
        this.tableId = t.tableId;
        this.meta = t;
        return t;
      }
    }
    throw new GSheetError("SCHEMA", `Table "${this.cfg.tableName}" not found`);
  }

  private async readHeader(meta: TableMeta): Promise<string[]> {
    const r = meta.range;
    const q = quoteSheet(meta.sheetTitle);
    const row = r.startRowIndex + 1;
    const rows = await this.api.getValues(
      `${q}!${colLetter(r.startColumnIndex + 1)}${row}:${colLetter(r.endColumnIndex)}${row}`,
    );
    const fromCells = (rows[0] ?? []).map((c) => String(c ?? ""));
    if (fromCells.some(Boolean)) return fromCells;
    return [...meta.columnProperties]
      .sort((a, b) => a.columnIndex - b.columnIndex)
      .map((c) => String(c.columnName));
  }

  /**
   * Extends the table to the right to make room for new columns.
   *
   * Only the table `range` is updated. The definitions of the existing columns (dropdowns that point
   * at other tables, column types, ...) are not sent back, because Google rejects some of them in the
   * form it returns them (for example `=Person[Name]`). New columns get the default column type in Sheets.
   */
  private async addColumns(meta: TableMeta, missing: ColumnSpec[]) {
    const names = missing.map((m) => m.name).join(", ");
    try {
      const r = meta.range;
      const q = quoteSheet(meta.sheetTitle);
      // the table grows to the right: make sure the sheet has the columns for it
      const needCols = r.endColumnIndex + missing.length;
      if (meta.gridColumns !== undefined && needCols > meta.gridColumns) {
        await this.api.batchUpdate([addColumnsRequest(r.sheetId, needCols - meta.gridColumns)]);
      }
      await this.api.updateValues(
        `${q}!${colLetter(r.endColumnIndex + 1)}${r.startRowIndex + 1}`,
        [missing.map((m) => m.name)],
      );
      await this.api.batchUpdate([
        {
          updateTable: {
            table: {
              tableId: meta.tableId,
              range: { ...r, endColumnIndex: r.endColumnIndex + missing.length },
            },
            fields: "range",
          },
        },
      ]);
    } catch (err) {
      throw new GSheetError(
        "SCHEMA",
        `Could not add column(s) ${names} to Table "${this.cfg.tableName}": ${err instanceof Error ? err.message : String(err)}. ` +
          `Add the column(s) in Google Sheets yourself and set migrate: false, or point idColumn at a column you already have.`,
        { cause: err },
      );
    }
  }

  async read(): Promise<RawRow[]> {
    const meta = await this.fetchMeta();
    const r = meta.range;
    const firstRow = r.startRowIndex + 2; // 1-based, first row after the header
    const lastRow = r.endRowIndex - (meta.hasFooter ? 1 : 0); // 1-based, inclusive
    if (lastRow < firstRow) return [];
    const q = quoteSheet(meta.sheetTitle);
    const values = await this.api.getValues(
      `${q}!${colLetter(r.startColumnIndex + 1)}${firstRow}:${colLetter(r.endColumnIndex)}${lastRow}`,
    );
    return values.map((v, i) => ({ rowNum: firstRow + i, values: v }));
  }

  private width(meta: TableMeta) {
    return meta.range.endColumnIndex - meta.range.startColumnIndex;
  }

  async append(rows: Cell[][]): Promise<void> {
    if (!rows.length) return;
    const meta = this.meta ?? (await this.fetchMeta());
    const width = this.width(meta);
    const sheetId = meta.range.sheetId;

    // the table grows downwards: make sure the sheet has the rows for it
    const needRows = meta.range.endRowIndex + rows.length;
    if (meta.gridRows !== undefined && needRows > meta.gridRows) {
      await this.api.batchUpdate([addRowsRequest(sheetId, needRows - meta.gridRows + ROW_BUFFER)]);
    }

    const request = [
      {
        appendCells: {
          tableId: meta.tableId,
          rows: rows.map((r) => ({
            values: Array.from({ length: width }, (_, i) => cellData(r[i] ?? null)),
          })),
          fields: "userEnteredValue",
        },
      },
    ];
    try {
      await this.api.batchUpdate(request);
    } catch (err) {
      if (!isGridError(err)) throw err;
      // size unknown or changed by someone else: grow once and retry
      await this.api.batchUpdate([addRowsRequest(sheetId, rows.length + ROW_BUFFER)]);
      await this.api.batchUpdate(request);
    }
  }

  async update(rows: { rowNum: number; values: Cell[] }[]): Promise<void> {
    if (!rows.length) return;
    const meta = this.meta ?? (await this.fetchMeta());
    const r = meta.range;
    const q = quoteSheet(meta.sheetTitle);
    const width = this.width(meta);
    await this.api.batchUpdateValues(
      rows.map(({ rowNum, values }) => ({
        range: `${q}!${colLetter(r.startColumnIndex + 1)}${rowNum}:${colLetter(r.endColumnIndex)}${rowNum}`,
        values: [Array.from({ length: width }, (_, i) => values[i] ?? "")],
      })),
    );
  }

  async remove(rowNums: number[]): Promise<void> {
    if (!rowNums.length) return;
    const meta = this.meta ?? (await this.fetchMeta());
    const r = meta.range;
    // bottom-up so earlier row numbers stay valid
    const requests = [...rowNums]
      .sort((a, b) => b - a)
      .map((rowNum) => ({
        deleteRange: {
          range: {
            sheetId: r.sheetId,
            startRowIndex: rowNum - 1,
            endRowIndex: rowNum,
            startColumnIndex: r.startColumnIndex,
            endColumnIndex: r.endColumnIndex,
          },
          shiftDimension: "ROWS",
        },
      }));
    await this.api.batchUpdate(requests);
  }
}
