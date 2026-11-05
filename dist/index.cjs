"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  GSheetDB: () => GSheetDB,
  GSheetError: () => GSheetError,
  Model: () => Model,
  SheetDriver: () => SheetDriver,
  SheetsApi: () => SheetsApi,
  TableDriver: () => TableDriver,
  resolveDriver: () => resolveDriver
});
module.exports = __toCommonJS(src_exports);

// src/client.ts
var import_sheets = require("@googleapis/sheets");

// src/errors.ts
var GSheetError = class extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.name = "GSheetError";
    this.code = code;
  }
};

// src/client.ts
var RETRYABLE = /* @__PURE__ */ new Set([408, 429, 500, 502, 503, 504]);
function statusOf(err) {
  const s = err?.response?.status ?? err?.status ?? err?.code;
  return typeof s === "number" ? s : typeof s === "string" && /^\d+$/.test(s) ? Number(s) : void 0;
}
var toGridRange = (r, sheetId) => ({
  sheetId,
  startRowIndex: r?.startRowIndex ?? 0,
  endRowIndex: r?.endRowIndex ?? 0,
  startColumnIndex: r?.startColumnIndex ?? 0,
  endColumnIndex: r?.endColumnIndex ?? 0
});
var SheetsApi = class {
  constructor(opts) {
    this.opts = opts;
    this.spreadsheetId = opts.spreadsheetId;
    const r = opts.retry === false ? { retries: 0 } : opts.retry ?? {};
    this.retries = r.retries ?? 4;
    this.baseDelayMs = r.baseDelayMs ?? 500;
  }
  opts;
  spreadsheetId;
  _api;
  retries;
  baseDelayMs;
  get api() {
    if (!this._api) {
      let authClient = this.opts.auth;
      if (!authClient) {
        const email = this.opts.credentials?.clientEmail ?? process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
        const key = (this.opts.credentials?.privateKey ?? process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
        if (!email || !key) {
          throw new GSheetError(
            "CONFIG",
            "Missing Google credentials. Pass `credentials`/`auth`, or set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY."
          );
        }
        authClient = new import_sheets.auth.JWT({
          email,
          key,
          scopes: ["https://www.googleapis.com/auth/spreadsheets"]
        });
      }
      this._api = (0, import_sheets.sheets)({ version: "v4", auth: authClient });
    }
    return this._api;
  }
  async call(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof GSheetError) throw err;
        const status = statusOf(err);
        const network = ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(err?.code);
        if (attempt < this.retries && (status && RETRYABLE.has(status) || network)) {
          const delay = this.baseDelayMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
          await new Promise((res) => setTimeout(res, delay));
          continue;
        }
        const detail = err?.response?.data?.error?.message ?? err?.message ?? String(err);
        throw new GSheetError("API", `Google Sheets API error${status ? ` (${status})` : ""}: ${detail}`, { cause: err });
      }
    }
  }
  async listSheets() {
    const res = await this.call(
      () => this.api.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: "sheets(properties(sheetId,title),tables)"
      })
    );
    return (res.data.sheets ?? []).map((s) => {
      const sheetId = s.properties?.sheetId ?? 0;
      const title = s.properties?.title ?? "";
      const tables = (s.tables ?? []).map((t) => ({
        tableId: t.tableId,
        name: t.name,
        sheetTitle: title,
        range: toGridRange(t.range, sheetId),
        columnProperties: t.columnProperties ?? [],
        hasFooter: Boolean(t.rowsProperties?.footerColorStyle)
      }));
      return { sheetId, title, tables };
    });
  }
  async batchUpdate(requests) {
    const res = await this.call(
      () => this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests }
      })
    );
    return res.data;
  }
  async getValues(range) {
    const res = await this.call(
      () => this.api.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range,
        valueRenderOption: "UNFORMATTED_VALUE"
      })
    );
    return res.data.values ?? [];
  }
  async updateValues(range, values) {
    await this.call(
      () => this.api.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: { values }
      })
    );
  }
  async batchUpdateValues(data) {
    if (!data.length) return;
    await this.call(
      () => this.api.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { valueInputOption: "RAW", data }
      })
    );
  }
  async appendValues(range, values) {
    await this.call(
      () => this.api.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values }
      })
    );
  }
};

// src/model.ts
var import_node_crypto = require("crypto");

// src/codec.ts
var EPOCH_OFFSET_DAYS = 25569;
var MS_PER_DAY = 864e5;
var dateToSerial = (d) => d.getTime() / MS_PER_DAY + EPOCH_OFFSET_DAYS;
var serialToDate = (n) => new Date(Math.round((n - EPOCH_OFFSET_DAYS) * MS_PER_DAY));
function serialize(value, type, dateFormat) {
  if (value === null || value === void 0) return null;
  switch (type) {
    case "string":
      return String(value);
    case "number":
      return Number(value);
    case "boolean":
      return Boolean(value);
    case "date": {
      const d = value instanceof Date ? value : new Date(value);
      return dateFormat === "serial" ? dateToSerial(d) : d.toISOString();
    }
    case "json":
      return JSON.stringify(value);
  }
}
function deserialize(raw, type) {
  if (raw === void 0 || raw === null || raw === "") return null;
  switch (type) {
    case "string":
      return String(raw);
    case "number": {
      const n = Number(raw);
      return Number.isNaN(n) ? null : n;
    }
    case "boolean":
      return raw === true || String(raw).toLowerCase() === "true";
    case "date": {
      const d = typeof raw === "number" ? serialToDate(raw) : new Date(String(raw));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    case "json":
      try {
        return JSON.parse(String(raw));
      } catch {
        return null;
      }
  }
}

// src/a1.ts
function colLetter(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
var quoteSheet = (title) => `'${title.replace(/'/g, "''")}'`;

// src/drivers/sheet.ts
var SheetDriver = class {
  constructor(api, cfg) {
    this.api = api;
    this.cfg = cfg;
  }
  api;
  cfg;
  kind = "sheet";
  dateFormat = "iso";
  sheetId;
  width = 0;
  get q() {
    return quoteSheet(this.cfg.tabName);
  }
  async init(columns, { migrate }) {
    const sheets = await this.api.listSheets();
    let tab = sheets.find((s) => s.title === this.cfg.tabName);
    if (!tab) {
      if (!this.cfg.create) throw new GSheetError("SCHEMA", `Tab "${this.cfg.tabName}" not found`);
      const res = await this.api.batchUpdate([
        {
          addSheet: {
            properties: {
              title: this.cfg.tabName,
              gridProperties: { columnCount: Math.max(26, columns.length) }
            }
          }
        }
      ]);
      const sheetId = res.replies?.[0]?.addSheet?.properties?.sheetId;
      tab = { sheetId, title: this.cfg.tabName, tables: [] };
    }
    this.sheetId = tab.sheetId;
    const first = await this.api.getValues(`${this.q}!1:1`);
    const existing = (first[0] ?? []).map((c) => String(c ?? "")).filter(Boolean);
    const missing = columns.filter((c) => !existing.includes(c.name));
    if (missing.length && !migrate && existing.length) {
      throw new GSheetError(
        "SCHEMA",
        `Tab "${this.cfg.tabName}" is missing column(s): ${missing.map((m) => m.name).join(", ")}`
      );
    }
    const header = [...existing, ...missing.map((m) => m.name)];
    if (missing.length) {
      await this.api.updateValues(`${this.q}!A1`, [header]);
    }
    this.width = header.length;
    return header;
  }
  async read() {
    const values = await this.api.getValues(`${this.q}!A2:${colLetter(this.width)}`);
    return values.map((v, i) => ({ rowNum: i + 2, values: v }));
  }
  async append(rows) {
    if (!rows.length) return;
    await this.api.appendValues(
      `${this.q}!A1`,
      rows.map((r) => Array.from({ length: this.width }, (_, i) => r[i] ?? ""))
    );
  }
  async update(rows) {
    if (!rows.length) return;
    const last = colLetter(this.width);
    await this.api.batchUpdateValues(
      rows.map(({ rowNum, values }) => ({
        range: `${this.q}!A${rowNum}:${last}${rowNum}`,
        values: [Array.from({ length: this.width }, (_, i) => values[i] ?? "")]
      }))
    );
  }
  async remove(rowNums) {
    if (!rowNums.length) return;
    const requests = [...rowNums].sort((a, b) => b - a).map((rowNum) => ({
      deleteDimension: {
        range: { sheetId: this.sheetId, dimension: "ROWS", startIndex: rowNum - 1, endIndex: rowNum }
      }
    }));
    await this.api.batchUpdate(requests);
  }
};

// src/drivers/table.ts
var COLUMN_TYPE = {
  string: "TEXT",
  number: "DOUBLE",
  boolean: "BOOLEAN",
  date: "DATE_TIME",
  json: "TEXT"
};
function columnProperty(c, index) {
  return {
    columnIndex: index,
    columnName: c.name,
    columnType: c.enum ? "DROPDOWN" : COLUMN_TYPE[c.type],
    ...c.enum ? {
      dataValidationRule: {
        condition: {
          type: "ONE_OF_LIST",
          values: c.enum.map((v) => ({ userEnteredValue: v }))
        }
      }
    } : {}
  };
}
var cellData = (v) => v === null ? {} : typeof v === "number" ? { userEnteredValue: { numberValue: v } } : typeof v === "boolean" ? { userEnteredValue: { boolValue: v } } : { userEnteredValue: { stringValue: v } };
var TableDriver = class {
  constructor(api, cfg) {
    this.api = api;
    this.cfg = cfg;
  }
  api;
  cfg;
  kind = "table";
  dateFormat = "serial";
  tableId;
  meta;
  async init(columns, { migrate }) {
    if (!this.cfg.existing) await this.createTable(columns);
    let meta = await this.fetchMeta();
    let header = await this.readHeader(meta);
    const missing = columns.filter((c) => !header.includes(c.name));
    if (missing.length) {
      if (!migrate) {
        throw new GSheetError(
          "SCHEMA",
          `Table "${this.cfg.tableName}" is missing column(s): ${missing.map((m) => m.name).join(", ")}`
        );
      }
      await this.addColumns(meta, header.length, missing);
      meta = await this.fetchMeta();
      header = await this.readHeader(meta);
    }
    return header;
  }
  async createTable(columns) {
    const sheets = await this.api.listSheets();
    const tab = sheets.find((s) => s.title === this.cfg.tabName);
    const q = quoteSheet(this.cfg.tabName);
    let sheetId;
    if (tab) {
      sheetId = tab.sheetId;
      const first = await this.api.getValues(`${q}!1:1`);
      if (first[0]?.some((c) => c !== "" && c != null)) {
        throw new GSheetError(
          "SCHEMA",
          `Tab "${this.cfg.tabName}" already has data but no Table named "${this.cfg.tableName}". Use source: "sheet" (or "auto"), or convert the range to a table in Google Sheets first.`
        );
      }
    } else {
      const res = await this.api.batchUpdate([
        {
          addSheet: {
            properties: {
              title: this.cfg.tabName,
              gridProperties: { columnCount: Math.max(26, columns.length) }
            }
          }
        }
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
              endRowIndex: 2,
              // header + one empty row; appendCells fills it first
              startColumnIndex: 0,
              endColumnIndex: columns.length
            },
            columnProperties: columns.map(columnProperty)
          }
        }
      }
    ]);
  }
  async fetchMeta() {
    const sheets = await this.api.listSheets();
    for (const s of sheets) {
      const t = s.tables.find((t2) => this.tableId ? t2.tableId === this.tableId : t2.name === this.cfg.tableName);
      if (t) {
        this.tableId = t.tableId;
        this.meta = t;
        return t;
      }
    }
    throw new GSheetError("SCHEMA", `Table "${this.cfg.tableName}" not found`);
  }
  async readHeader(meta) {
    const r = meta.range;
    const q = quoteSheet(meta.sheetTitle);
    const row = r.startRowIndex + 1;
    const rows = await this.api.getValues(
      `${q}!${colLetter(r.startColumnIndex + 1)}${row}:${colLetter(r.endColumnIndex)}${row}`
    );
    const fromCells = (rows[0] ?? []).map((c) => String(c ?? ""));
    if (fromCells.some(Boolean)) return fromCells;
    return [...meta.columnProperties].sort((a, b) => a.columnIndex - b.columnIndex).map((c) => String(c.columnName));
  }
  /** Best effort: extends the table range to the right and registers the new columns. */
  async addColumns(meta, currentWidth, missing) {
    const r = meta.range;
    const q = quoteSheet(meta.sheetTitle);
    await this.api.updateValues(
      `${q}!${colLetter(r.endColumnIndex + 1)}${r.startRowIndex + 1}`,
      [missing.map((m) => m.name)]
    );
    await this.api.batchUpdate([
      {
        updateTable: {
          table: {
            tableId: meta.tableId,
            range: { ...r, endColumnIndex: r.endColumnIndex + missing.length },
            columnProperties: [
              ...meta.columnProperties,
              ...missing.map((m, i) => columnProperty(m, currentWidth + i))
            ]
          },
          fields: "range,columnProperties"
        }
      }
    ]);
  }
  async read() {
    const meta = await this.fetchMeta();
    const r = meta.range;
    const firstRow = r.startRowIndex + 2;
    const lastRow = r.endRowIndex - (meta.hasFooter ? 1 : 0);
    if (lastRow < firstRow) return [];
    const q = quoteSheet(meta.sheetTitle);
    const values = await this.api.getValues(
      `${q}!${colLetter(r.startColumnIndex + 1)}${firstRow}:${colLetter(r.endColumnIndex)}${lastRow}`
    );
    return values.map((v, i) => ({ rowNum: firstRow + i, values: v }));
  }
  width(meta) {
    return meta.range.endColumnIndex - meta.range.startColumnIndex;
  }
  async append(rows) {
    if (!rows.length) return;
    const meta = this.meta ?? await this.fetchMeta();
    const width = this.width(meta);
    await this.api.batchUpdate([
      {
        appendCells: {
          tableId: meta.tableId,
          rows: rows.map((r) => ({
            values: Array.from({ length: width }, (_, i) => cellData(r[i] ?? null))
          })),
          fields: "userEnteredValue"
        }
      }
    ]);
  }
  async update(rows) {
    if (!rows.length) return;
    const meta = this.meta ?? await this.fetchMeta();
    const r = meta.range;
    const q = quoteSheet(meta.sheetTitle);
    const width = this.width(meta);
    await this.api.batchUpdateValues(
      rows.map(({ rowNum, values }) => ({
        range: `${q}!${colLetter(r.startColumnIndex + 1)}${rowNum}:${colLetter(r.endColumnIndex)}${rowNum}`,
        values: [Array.from({ length: width }, (_, i) => values[i] ?? "")]
      }))
    );
  }
  async remove(rowNums) {
    if (!rowNums.length) return;
    const meta = this.meta ?? await this.fetchMeta();
    const r = meta.range;
    const requests = [...rowNums].sort((a, b) => b - a).map((rowNum) => ({
      deleteRange: {
        range: {
          sheetId: r.sheetId,
          startRowIndex: rowNum - 1,
          endRowIndex: rowNum,
          startColumnIndex: r.startColumnIndex,
          endColumnIndex: r.endColumnIndex
        },
        shiftDimension: "ROWS"
      }
    }));
    await this.api.batchUpdate(requests);
  }
};

// src/drivers/resolve.ts
async function resolveDriver(api, spec) {
  const tableName = spec.table ?? spec.name;
  const tabName = spec.sheet ?? spec.name;
  const sheets = await api.listSheets();
  if (spec.source !== "sheet") {
    const table = sheets.flatMap((s) => s.tables).find((t) => t.name === tableName);
    if (table) {
      return new TableDriver(api, { tableName, tabName: table.sheetTitle, existing: true });
    }
  }
  const tab = sheets.find((s) => s.title === tabName);
  if (spec.source === "sheet" || spec.source === "auto" && tab) {
    return new SheetDriver(api, { tabName, existing: Boolean(tab), create: spec.create });
  }
  if (!spec.create) {
    throw new GSheetError("SCHEMA", `Table "${tableName}" not found and create is disabled`);
  }
  return new TableDriver(api, { tableName, tabName, existing: false });
}

// src/query.ts
var OP_KEYS = /* @__PURE__ */ new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "endsWith"
]);
var isOperator = (v) => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date) && Object.keys(v).length > 0 && Object.keys(v).every((k) => OP_KEYS.has(k));
var norm = (v) => v instanceof Date ? v.getTime() : v;
var comparable = (a, b) => a != null && b != null && typeof a === typeof b;
var str = (v) => String(v ?? "").toLowerCase();
function matches(row, where) {
  if (!where) return true;
  if (typeof where === "function") return where(row);
  for (const [key, cond] of Object.entries(where)) {
    const val = norm(row[key]);
    if (!isOperator(cond)) {
      if (val !== norm(cond)) return false;
      continue;
    }
    if ("eq" in cond && val !== norm(cond.eq)) return false;
    if ("ne" in cond && val === norm(cond.ne)) return false;
    if ("gt" in cond && !(comparable(val, norm(cond.gt)) && val > norm(cond.gt))) return false;
    if ("gte" in cond && !(comparable(val, norm(cond.gte)) && val >= norm(cond.gte))) return false;
    if ("lt" in cond && !(comparable(val, norm(cond.lt)) && val < norm(cond.lt))) return false;
    if ("lte" in cond && !(comparable(val, norm(cond.lte)) && val <= norm(cond.lte))) return false;
    if (cond.in && !cond.in.map(norm).includes(val)) return false;
    if (cond.notIn && cond.notIn.map(norm).includes(val)) return false;
    if (cond.contains !== void 0 && !str(val).includes(str(cond.contains))) return false;
    if (cond.startsWith !== void 0 && !str(val).startsWith(str(cond.startsWith))) return false;
    if (cond.endsWith !== void 0 && !str(val).endsWith(str(cond.endsWith))) return false;
  }
  return true;
}
function sortRows(rows, orderBy) {
  if (!orderBy) return rows;
  const keys = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const { field, dir = "asc" } of keys) {
      const m = dir === "asc" ? 1 : -1;
      const x = norm(a[field]);
      const y = norm(b[field]);
      if (x == null && y == null) continue;
      if (x == null) return 1;
      if (y == null) return -1;
      if (x > y) return m;
      if (x < y) return -m;
    }
    return 0;
  });
}

// src/model.ts
var RESERVED = ["id", "createdAt", "updatedAt"];
var Model = class {
  constructor(name, schema, opts, getApi) {
    this.name = name;
    this.opts = opts;
    this.getApi = getApi;
    this.fields = {};
    for (const [key, def] of Object.entries(schema)) {
      if (RESERVED.includes(key)) {
        throw new GSheetError("SCHEMA", `[${name}] "${key}" is reserved and added automatically`);
      }
      this.fields[key] = typeof def === "string" ? { type: def } : def;
    }
    this.columns = [
      { name: "id", type: "string" },
      ...Object.entries(this.fields).map(([n, f]) => ({ name: n, type: f.type, enum: f.enum })),
      { name: "createdAt", type: "date" },
      { name: "updatedAt", type: "date" }
    ];
    this.managed = new Set(this.columns.map((c) => c.name));
  }
  name;
  opts;
  getApi;
  fields;
  managed;
  columns;
  driver;
  header = [];
  ready;
  cache;
  /* ------------------------------ setup ------------------------------ */
  /** "table" or "sheet" once connected (after the first call or sync()). */
  get source() {
    return this.driver?.kind;
  }
  /** Connects, creates the tab/table if allowed and adds missing columns. Runs automatically. */
  sync() {
    this.ready ??= this.init().catch((e) => {
      this.ready = void 0;
      throw e;
    });
    return this.ready;
  }
  async init() {
    const o = this.opts;
    const driver = o.driver ?? await resolveDriver(this.getApi(), {
      name: this.name,
      source: o.source ?? "auto",
      table: o.table,
      sheet: o.sheet,
      create: o.create ?? true
    });
    this.header = await driver.init(this.columns, { migrate: o.migrate ?? true });
    this.driver = driver;
  }
  /* ------------------------------ mapping ------------------------------ */
  typeOf(col) {
    return this.columns.find((c) => c.name === col)?.type ?? "string";
  }
  toRow(raw) {
    const row = {};
    this.header.forEach((col, i) => {
      if (this.managed.has(col)) row[col] = deserialize(raw[i], this.typeOf(col));
    });
    return row;
  }
  toCells(rec, base) {
    const driver = this.driver;
    return this.header.map(
      (col, i) => this.managed.has(col) ? serialize(rec[col], this.typeOf(col), driver.dateFormat) : base?.[i] ?? null
    );
  }
  async load(fresh = false) {
    await this.sync();
    const ttl = this.opts.cache ? this.opts.cache.ttlMs : 0;
    if (!fresh && ttl && this.cache && Date.now() - this.cache.at < ttl) return this.cache.rows;
    const rows = (await this.driver.read()).filter((r) => r.values.some((v) => v !== "" && v != null && v !== false)).map((r) => ({ rowNum: r.rowNum, raw: r.values, row: this.toRow(r.values) }));
    if (this.opts.healIds ?? true) {
      const orphans = rows.filter((r) => !r.row.id);
      if (orphans.length) {
        const now = /* @__PURE__ */ new Date();
        for (const o of orphans) {
          o.row.id = (0, import_node_crypto.randomUUID)();
          o.row.createdAt ||= now;
          o.row.updatedAt ||= now;
        }
        await this.driver.update(
          orphans.map((o) => ({ rowNum: o.rowNum, values: this.toCells(o.row, o.raw) }))
        );
      }
    }
    this.cache = ttl ? { at: Date.now(), rows } : void 0;
    return rows;
  }
  invalidate() {
    this.cache = void 0;
  }
  /* ------------------------------ validation ------------------------------ */
  normalize(key, def, v) {
    if (v === null || v === void 0) return null;
    const bad = (what) => new GSheetError("VALIDATION", `[${this.name}] "${key}" must be ${what}`);
    switch (def.type) {
      case "string":
        if (typeof v !== "string") throw bad("a string");
        if (def.enum && !def.enum.includes(v)) throw bad(`one of: ${def.enum.join(", ")}`);
        return v;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) throw bad("a finite number");
        return v;
      case "boolean":
        if (typeof v !== "boolean") throw bad("a boolean");
        return v;
      case "date": {
        const d = v instanceof Date ? v : new Date(v);
        if (Number.isNaN(d.getTime())) throw bad("a valid date");
        return d;
      }
      case "json":
        try {
          JSON.stringify(v);
        } catch {
          throw bad("JSON-serializable");
        }
        return v;
    }
  }
  requireValue(key, def, v) {
    if (def.required && (v === null || v === void 0 || v === "")) {
      throw new GSheetError("VALIDATION", `[${this.name}] "${key}" is required`);
    }
  }
  assertKnown(input, allowId) {
    for (const k of Object.keys(input)) {
      if (!(k in this.fields) && !(allowId && k === "id")) {
        throw new GSheetError("VALIDATION", `[${this.name}] unknown field "${k}"`);
      }
    }
  }
  assertUnique(records, existing, only) {
    const keys = only ?? ["id", ...Object.keys(this.fields).filter((k) => this.fields[k].unique)];
    for (const key of keys) {
      const owners = new Map(
        existing.map((e) => [norm(e.row[key]), e.row.id])
      );
      for (const rec of records) {
        const v = norm(rec[key]);
        if (v == null) continue;
        const owner = owners.get(v);
        if (owner !== void 0 && owner !== rec.id) {
          throw new GSheetError("UNIQUE", `[${this.name}] "${key}" must be unique (duplicate: ${String(v)})`);
        }
        owners.set(v, rec.id);
      }
    }
  }
  /* ------------------------------ read ------------------------------ */
  async findMany(opts = {}) {
    const rows = (await this.load()).map((l) => l.row).filter((r) => matches(r, opts.where));
    const sorted = sortRows(rows, opts.orderBy);
    const start = opts.offset ?? 0;
    const end = opts.limit != null ? start + opts.limit : void 0;
    return sorted.slice(start, end).map((r) => ({ ...r }));
  }
  async findFirst(where) {
    return (await this.findMany({ where, limit: 1 }))[0] ?? null;
  }
  findById(id) {
    return this.findFirst({ id });
  }
  async count(where) {
    return (await this.load()).filter((l) => matches(l.row, where)).length;
  }
  /* ------------------------------ create ------------------------------ */
  async create(data) {
    return (await this.createMany([data]))[0];
  }
  async createMany(items) {
    if (!items.length) return [];
    await this.sync();
    const now = /* @__PURE__ */ new Date();
    const records = items.map((item) => {
      const input = item;
      this.assertKnown(input, true);
      const rec = {};
      for (const [key, def] of Object.entries(this.fields)) {
        let v = input[key];
        if (v === void 0 && def.default !== void 0) {
          v = typeof def.default === "function" ? def.default() : def.default;
        }
        rec[key] = this.normalize(key, def, v);
        this.requireValue(key, def, rec[key]);
      }
      rec.id = input.id ?? (0, import_node_crypto.randomUUID)();
      rec.createdAt = now;
      rec.updatedAt = now;
      return rec;
    });
    this.assertUnique(records, await this.load(true));
    await this.driver.append(records.map((r) => this.toCells(r)));
    this.invalidate();
    return records;
  }
  /* ------------------------------ update ------------------------------ */
  async update(where, data) {
    const patch = data;
    this.assertKnown(patch, false);
    const all = await this.load(true);
    const targets = all.filter((l) => matches(l.row, where));
    if (!targets.length) return [];
    const clean = {};
    for (const [key, v] of Object.entries(patch)) {
      if (v === void 0) continue;
      const def = this.fields[key];
      clean[key] = this.normalize(key, def, v);
      this.requireValue(key, def, clean[key]);
    }
    const now = /* @__PURE__ */ new Date();
    const next = targets.map((t) => ({
      rowNum: t.rowNum,
      raw: t.raw,
      rec: { ...t.row, ...clean, updatedAt: now }
    }));
    const touchedUnique = Object.keys(clean).filter((k) => this.fields[k].unique);
    if (touchedUnique.length) this.assertUnique(next.map((n) => n.rec), all, touchedUnique);
    await this.driver.update(next.map((n) => ({ rowNum: n.rowNum, values: this.toCells(n.rec, n.raw) })));
    this.invalidate();
    return next.map((n) => n.rec);
  }
  async updateById(id, data) {
    return (await this.update({ id }, data))[0] ?? null;
  }
  /** Updates the first match, or creates a new row when nothing matches. */
  async upsert(where, data) {
    const found = (await this.load(true)).find((l) => matches(l.row, where));
    if (found) {
      const { id: _ignored, ...rest } = data;
      return await this.updateById(found.row.id, rest);
    }
    return this.create(data);
  }
  /* ------------------------------ delete ------------------------------ */
  /** Deletes all matching rows and returns how many were removed. */
  async delete(where) {
    const targets = (await this.load(true)).filter((l) => matches(l.row, where));
    if (!targets.length) return 0;
    await this.driver.remove(targets.map((t) => t.rowNum));
    this.invalidate();
    return targets.length;
  }
  async deleteById(id) {
    return await this.delete({ id }) > 0;
  }
};

// src/db.ts
var GSheetDB = class {
  api;
  constructor(opts) {
    this.api = new SheetsApi(opts);
  }
  /**
   * Define a model. By default it binds to a Sheets Table named `name`, falls back to a tab
   * named `name`, and creates a new tab + Table when neither exists.
   */
  model(name, schema, opts = {}) {
    return new Model(name, schema, opts, () => this.api);
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  GSheetDB,
  GSheetError,
  Model,
  SheetDriver,
  SheetsApi,
  TableDriver,
  resolveDriver
});
//# sourceMappingURL=index.cjs.map