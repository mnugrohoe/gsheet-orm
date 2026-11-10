import { describe, expect, it } from "vitest";
import {
  GSheetDB,
  GSheetError,
  SheetDriver,
  TableDriver,
  resolveDriver,
  type SheetMeta,
  type SheetsApiLike,
  type TableMeta,
} from "../src/index.js";

const tableMeta = (over: Partial<TableMeta> = {}): TableMeta => ({
  tableId: "t1",
  name: "items",
  sheetTitle: "Items Tab",
  range: { sheetId: 7, startRowIndex: 2, endRowIndex: 6, startColumnIndex: 1, endColumnIndex: 4 },
  columnProperties: [],
  hasFooter: false,
  ...over,
});

/** Scripted fake: returns canned data and records every call. */
class FakeApi implements SheetsApiLike {
  calls: { op: string; args: unknown[] }[] = [];
  sheets: SheetMeta[];
  values: Record<string, unknown[][]> = {};

  constructor(sheets: SheetMeta[] = []) {
    this.sheets = sheets;
  }
  private rec(op: string, ...args: unknown[]) {
    this.calls.push({ op, args });
  }
  async listSheets() {
    this.rec("listSheets");
    return this.sheets;
  }
  async batchUpdate(requests: unknown[]) {
    this.rec("batchUpdate", requests);
    return { replies: [{ addSheet: { properties: { sheetId: 99 } } }] };
  }
  async getValues(range: string) {
    this.rec("getValues", range);
    return this.values[range] ?? [];
  }
  async updateValues(range: string, values: unknown[][]) {
    this.rec("updateValues", range, values);
  }
  async batchUpdateValues(data: { range: string; values: unknown[][] }[]) {
    this.rec("batchUpdateValues", data);
  }
  async appendValues(range: string, values: unknown[][]) {
    this.rec("appendValues", range, values);
  }
  of(op: string) {
    return this.calls.filter((c) => c.op === op);
  }
}

const base = { name: "items", source: "auto", create: true } as const;
const cols = [
  { name: "id", type: "string" as const },
  { name: "name", type: "string" as const },
  { name: "stock", type: "number" as const },
];

describe("resolveDriver", () => {
  it("prefers a Table over a tab with the same name", async () => {
    const api = new FakeApi([
      { sheetId: 1, title: "items", tables: [] },
      { sheetId: 7, title: "Items Tab", tables: [tableMeta()] },
    ]);
    expect(await resolveDriver(api, base)).toBeInstanceOf(TableDriver);
  });

  it("falls back to a plain tab when no table exists", async () => {
    const api = new FakeApi([{ sheetId: 1, title: "items", tables: [] }]);
    expect(await resolveDriver(api, base)).toBeInstanceOf(SheetDriver);
  });

  it("creates a Table when nothing exists (auto and table)", async () => {
    expect(await resolveDriver(new FakeApi(), base)).toBeInstanceOf(TableDriver);
    expect(await resolveDriver(new FakeApi(), { ...base, source: "table" })).toBeInstanceOf(TableDriver);
  });

  it('source "sheet" ignores tables', async () => {
    const api = new FakeApi([{ sheetId: 7, title: "items", tables: [tableMeta({ sheetTitle: "items" })] }]);
    expect(await resolveDriver(api, { ...base, source: "sheet" })).toBeInstanceOf(SheetDriver);
  });

  it("honours custom table / sheet names", async () => {
    const api = new FakeApi([{ sheetId: 7, title: "Items Tab", tables: [tableMeta({ name: "tbl_items" })] }]);
    expect(await resolveDriver(api, { ...base, table: "tbl_items" })).toBeInstanceOf(TableDriver);
  });

  it("refuses to create when create is false", async () => {
    await expect(resolveDriver(new FakeApi(), { ...base, create: false })).rejects.toBeInstanceOf(GSheetError);
  });
});

describe("TableDriver", () => {
  const api = () => {
    const a = new FakeApi([{ sheetId: 7, title: "Items Tab", tables: [tableMeta()] }]);
    a.values["'Items Tab'!B3:D3"] = [["id", "name", "stock"]]; // header row (startRowIndex 2 -> row 3)
    return a;
  };

  it("reads data rows below the header with correct row numbers", async () => {
    const a = api();
    a.values["'Items Tab'!B4:D6"] = [["a", "A", 1], ["b", "B", 2]];
    const d = new TableDriver(a, { tableName: "items", tabName: "Items Tab", existing: true });
    expect(await d.init(cols, { migrate: true })).toEqual(["id", "name", "stock"]);
    expect(await d.read()).toEqual([
      { rowNum: 4, values: ["a", "A", 1] },
      { rowNum: 5, values: ["b", "B", 2] },
    ]);
  });

  it("excludes the footer row", async () => {
    const a = api();
    a.sheets[0]!.tables[0] = tableMeta({ hasFooter: true });
    const d = new TableDriver(a, { tableName: "items", tabName: "Items Tab", existing: true });
    await d.init(cols, { migrate: true });
    await d.read();
    expect(a.of("getValues").at(-1)!.args[0]).toBe("'Items Tab'!B4:D5");
  });

  it("appends with appendCells + tableId and typed values", async () => {
    const a = api();
    const d = new TableDriver(a, { tableName: "items", tabName: "Items Tab", existing: true });
    await d.init(cols, { migrate: true });
    await d.append([["x", "=1+1", 5], ["y", null, true]]);
    const [req] = a.of("batchUpdate").at(-1)!.args[0] as any[];
    expect(req.appendCells.tableId).toBe("t1");
    expect(req.appendCells.rows[0].values).toEqual([
      { userEnteredValue: { stringValue: "x" } },
      { userEnteredValue: { stringValue: "=1+1" } }, // stays text, never a formula
      { userEnteredValue: { numberValue: 5 } },
    ]);
    expect(req.appendCells.rows[1].values[1]).toEqual({});
    expect(req.appendCells.rows[1].values[2]).toEqual({ userEnteredValue: { boolValue: true } });
  });

  it("updates inside the table columns only", async () => {
    const a = api();
    const d = new TableDriver(a, { tableName: "items", tabName: "Items Tab", existing: true });
    await d.init(cols, { migrate: true });
    await d.update([{ rowNum: 5, values: ["b", "B2", 3] }]);
    expect(a.of("batchUpdateValues")[0]!.args[0]).toEqual([
      { range: "'Items Tab'!B5:D5", values: [["b", "B2", 3]] },
    ]);
  });

  it("removes rows bottom-up with deleteRange shifting rows", async () => {
    const a = api();
    const d = new TableDriver(a, { tableName: "items", tabName: "Items Tab", existing: true });
    await d.init(cols, { migrate: true });
    await d.remove([4, 6, 5]);
    const reqs = a.of("batchUpdate").at(-1)!.args[0] as any[];
    expect(reqs.map((r) => r.deleteRange.range.startRowIndex)).toEqual([5, 4, 3]);
    expect(reqs[0].deleteRange.shiftDimension).toBe("ROWS");
    expect(reqs[0].deleteRange.range).toMatchObject({ sheetId: 7, startColumnIndex: 1, endColumnIndex: 4 });
  });

  it("throws SCHEMA on missing columns when migrate is false", async () => {
    const d = new TableDriver(api(), { tableName: "items", tabName: "Items Tab", existing: true });
    await expect(
      d.init([...cols, { name: "extra", type: "string" }], { migrate: false }),
    ).rejects.toMatchObject({ code: "SCHEMA" });
  });

  it("creates a typed table on a new tab, dropdown for enums", async () => {
    const a = new FakeApi();
    // after creation the fake must report the table so init() can read it back
    const origBatch = a.batchUpdate.bind(a);
    a.batchUpdate = async (reqs: unknown[]) => {
      const res = await origBatch(reqs);
      if ((reqs[0] as any).addTable) {
        a.sheets = [{ sheetId: 99, title: "items", tables: [tableMeta({ sheetTitle: "items", range: { sheetId: 99, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 } })] }];
        a.values["'items'!A1:C1"] = [["id", "status", "n"]];
      }
      return res;
    };
    const d = new TableDriver(a, { tableName: "items", tabName: "items", existing: false });
    await d.init(
      [
        { name: "id", type: "string" },
        { name: "status", type: "string", enum: ["a", "b"] },
        { name: "n", type: "number" },
      ],
      { migrate: true },
    );
    const add = a.of("batchUpdate").map((c) => (c.args[0] as any[])[0]).find((r) => r.addTable).addTable.table;
    expect(add.name).toBe("items");
    expect(add.range).toMatchObject({ sheetId: 99, startRowIndex: 0, endRowIndex: 2, endColumnIndex: 3 });
    expect(add.columnProperties.map((c: any) => c.columnType)).toEqual(["TEXT", "DROPDOWN", "DOUBLE"]);
    expect(add.columnProperties[1].dataValidationRule.condition.type).toBe("ONE_OF_LIST");
    expect(a.of("updateValues")[0]!.args).toEqual(["'items'!A1", [["id", "status", "n"]]]);
  });

  it("refuses to create a table over an existing tab that holds data", async () => {
    const a = new FakeApi([{ sheetId: 1, title: "items", tables: [] }]);
    a.values["'items'!1:1"] = [["something"]];
    const d = new TableDriver(a, { tableName: "items", tabName: "items", existing: false });
    await expect(d.init(cols, { migrate: true })).rejects.toThrow(/already has data/);
  });
});

describe("SheetDriver", () => {
  const make = (header: string[]) => {
    const a = new FakeApi([{ sheetId: 3, title: "items", tables: [] }]);
    a.values["'items'!1:1"] = [header];
    a.values["'items'!A2:C"] = [["a", "A", 1], [], ["c", "C", 3]];
    return { a, d: new SheetDriver(a, { tabName: "items", existing: true, create: true }) };
  };

  it("reads from row 2 keeping blank rows so row numbers stay right", async () => {
    const { d } = make(["id", "name", "stock"]);
    await d.init(cols, { migrate: true });
    expect((await d.read()).map((r) => r.rowNum)).toEqual([2, 3, 4]);
  });

  it("adds missing header columns, keeping existing order", async () => {
    const { a, d } = make(["name", "id"]);
    const header = await d.init(cols, { migrate: true });
    expect(header).toEqual(["name", "id", "stock"]);
    expect(a.of("updateValues")[0]!.args).toEqual(["'items'!A1", [["name", "id", "stock"]]]);
  });

  it("deletes rows bottom-up via deleteDimension", async () => {
    const { a, d } = make(["id", "name", "stock"]);
    await d.init(cols, { migrate: true });
    await d.remove([2, 4]);
    const reqs = a.of("batchUpdate").at(-1)!.args[0] as any[];
    expect(reqs.map((r) => r.deleteDimension.range.startIndex)).toEqual([3, 1]);
    expect(reqs[0].deleteDimension.range.sheetId).toBe(3);
  });

  it("creates a missing tab", async () => {
    const a = new FakeApi();
    const d = new SheetDriver(a, { tabName: "items", existing: false, create: true });
    await d.init(cols, { migrate: true });
    expect((a.of("batchUpdate")[0]!.args[0] as any[])[0].addSheet.properties.title).toBe("items");
    expect(a.of("updateValues")[0]!.args[1]).toEqual([["id", "name", "stock"]]);
  });
});

describe("GSheetDB", () => {
  it("throws a CONFIG error lazily when credentials are missing", async () => {
    const saved = { ...process.env };
    delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_PRIVATE_KEY;
    const db = new GSheetDB({ spreadsheetId: "x" }); // constructing must not throw
    const M = db.model("m", { a: "string" });
    await expect(M.findMany()).rejects.toMatchObject({ code: "CONFIG" });
    process.env = saved;
  });
});

describe("grids grow by themselves", () => {
  const gridError = () =>
    new GSheetError("API", "Google Sheets API error (400): Range ('Items Tab'!A7:D7) exceeds grid limits. Max rows: 6, max columns: 4");

  const tableApi = (grid: { rows: number; cols: number }) => {
    const a = new FakeApi([
      {
        sheetId: 7,
        title: "Items Tab",
        rowCount: grid.rows,
        columnCount: grid.cols,
        tables: [tableMeta({ gridRows: grid.rows, gridColumns: grid.cols })],
      },
    ]);
    a.values["'Items Tab'!B3:D3"] = [["id", "name", "stock"]];
    return a;
  };
  const dimension = (a: FakeApi) =>
    a.of("batchUpdate").flatMap((c) => c.args[0] as any[]).filter((r) => r.appendDimension).map((r) => r.appendDimension);

  it("table: adds rows before appending when the table touches the bottom of the sheet", async () => {
    const a = tableApi({ rows: 6, cols: 4 }); // table ends at row 6, the grid is 6 rows
    const d = new TableDriver(a, { tableName: "items", tabName: "Items Tab", existing: true });
    await d.init(cols, { migrate: true });
    await d.append([["a", "A", 1], ["b", "B", 2]]);
    const calls = a.of("batchUpdate").map((c) => (c.args[0] as any[])[0]);
    expect(dimension(a)).toEqual([{ sheetId: 7, dimension: "ROWS", length: 2 + 100 + 0 }]);
    expect(calls.findIndex((r) => r.appendDimension)).toBeLessThan(calls.findIndex((r) => r.appendCells));
  });

  it("table: does not grow when there is room", async () => {
    const a = tableApi({ rows: 1000, cols: 26 });
    const d = new TableDriver(a, { tableName: "items", tabName: "Items Tab", existing: true });
    await d.init(cols, { migrate: true });
    await d.append([["a", "A", 1]]);
    expect(dimension(a)).toEqual([]);
  });

  it("table: grows and retries once when Google reports the grid limit", async () => {
    const a = tableApi({ rows: 1000, cols: 26 });
    let first = true;
    const orig = a.batchUpdate.bind(a);
    a.batchUpdate = async (reqs: unknown[]) => {
      if (first && (reqs[0] as any).appendCells) {
        first = false;
        throw gridError();
      }
      return orig(reqs);
    };
    const d = new TableDriver(a, { tableName: "items", tabName: "Items Tab", existing: true });
    await d.init(cols, { migrate: true });
    await d.append([["a", "A", 1]]);
    expect(dimension(a)).toHaveLength(1);
    expect(a.of("batchUpdate").filter((c) => (c.args[0] as any[])[0].appendCells)).toHaveLength(1); // the retry (the failed one threw before recording)
  });

  it("table: other errors are not swallowed", async () => {
    const a = tableApi({ rows: 1000, cols: 26 });
    const orig = a.batchUpdate.bind(a);
    a.batchUpdate = async (reqs: unknown[]) => {
      if ((reqs[0] as any).appendCells) throw new GSheetError("API", "Google Sheets API error (403): no permission");
      return orig(reqs);
    };
    const d = new TableDriver(a, { tableName: "items", tabName: "Items Tab", existing: true });
    await d.init(cols, { migrate: true });
    await expect(d.append([["a", "A", 1]])).rejects.toThrow(/no permission/);
  });

  it("table: adds columns before extending the table to the right", async () => {
    const a = tableApi({ rows: 1000, cols: 4 }); // table already uses all 4 columns
    const d = new TableDriver(a, { tableName: "items", tabName: "Items Tab", existing: true });
    await d.init([...cols, { name: "extra", type: "string" }], { migrate: true });
    expect(dimension(a)).toEqual([{ sheetId: 7, dimension: "COLUMNS", length: 1 }]);
    const order = a.calls.map((c) => c.op === "batchUpdate" ? ((c.args[0] as any[])[0].appendDimension ? "grow" : "updateTable") : c.op);
    expect(order.indexOf("grow")).toBeLessThan(order.indexOf("updateValues"));
  });

  it("table: makes room on an existing empty tab that is narrower than the schema", async () => {
    const a = new FakeApi([{ sheetId: 1, title: "items", rowCount: 1, columnCount: 2, tables: [] }]);
    a.values["'items'!1:1"] = [];
    const orig = a.batchUpdate.bind(a);
    a.batchUpdate = async (reqs: unknown[]) => {
      const res = await orig(reqs);
      if ((reqs[0] as any).addTable) {
        a.sheets = [{ sheetId: 1, title: "items", tables: [tableMeta({ sheetTitle: "items", range: { sheetId: 1, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 } })] }];
        a.values["'items'!A1:C1"] = [["id", "name", "stock"]];
      }
      return res;
    };
    const d = new TableDriver(a, { tableName: "items", tabName: "items", existing: false });
    await d.init(cols, { migrate: true });
    expect(dimension(a)).toEqual([
      { sheetId: 1, dimension: "COLUMNS", length: 1 },
      { sheetId: 1, dimension: "ROWS", length: 1 },
    ]);
  });

  it("sheet: adds columns when the header is wider than the grid", async () => {
    const a = new FakeApi([{ sheetId: 3, title: "items", rowCount: 1000, columnCount: 2, tables: [] }]);
    a.values["'items'!1:1"] = [["id", "name"]];
    const d = new SheetDriver(a, { tabName: "items", existing: true, create: true });
    await d.init(cols, { migrate: true });
    expect(dimension(a)).toEqual([{ sheetId: 3, dimension: "COLUMNS", length: 1 }]);
    const order = a.calls.map((c) => c.op === "batchUpdate" ? "grow" : c.op);
    expect(order.indexOf("grow")).toBeLessThan(order.indexOf("updateValues"));
  });

  it("sheet: grows rows and retries once when the grid limit is hit", async () => {
    const a = new FakeApi([{ sheetId: 3, title: "items", rowCount: 6, columnCount: 26, tables: [] }]);
    a.values["'items'!1:1"] = [["id", "name", "stock"]];
    const orig = a.appendValues.bind(a);
    let first = true;
    a.appendValues = async (range: string, values: unknown[][]) => {
      if (first) {
        first = false;
        throw gridError();
      }
      return orig(range, values);
    };
    const d = new SheetDriver(a, { tabName: "items", existing: true, create: true });
    await d.init(cols, { migrate: true });
    await d.append([["a", "A", 1]]);
    expect(dimension(a)).toEqual([{ sheetId: 3, dimension: "ROWS", length: 1 + 100 }]);
    expect(a.of("appendValues")).toHaveLength(1);
  });
});
