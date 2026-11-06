// src/client.ts
import {
  sheets as createSheets,
  auth as googleAuth
} from "@googleapis/sheets";

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
function lazySheets(opts) {
  let api;
  return () => {
    if (api) return api;
    let authClient = opts.auth;
    if (!authClient) {
      const email = opts.credentials?.clientEmail ?? process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const key = (opts.credentials?.privateKey ?? process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
      if (!email || !key) {
        throw new GSheetError(
          "CONFIG",
          "Missing Google credentials. Pass `credentials`/`auth`, or set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY."
        );
      }
      authClient = new googleAuth.JWT({
        email,
        key,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"]
      });
    }
    api = createSheets({ version: "v4", auth: authClient });
    return api;
  };
}
var toGridRange = (r, sheetId) => ({
  sheetId,
  startRowIndex: r?.startRowIndex ?? 0,
  endRowIndex: r?.endRowIndex ?? 0,
  startColumnIndex: r?.startColumnIndex ?? 0,
  endColumnIndex: r?.endColumnIndex ?? 0
});
var SheetsApi = class {
  spreadsheetId;
  getSheets;
  retries;
  baseDelayMs;
  constructor(opts, shared) {
    this.spreadsheetId = opts.spreadsheetId;
    this.getSheets = shared ?? lazySheets(opts);
    const r = opts.retry === false ? { retries: 0 } : opts.retry ?? {};
    this.retries = r.retries ?? 4;
    this.baseDelayMs = r.baseDelayMs ?? 500;
  }
  get api() {
    return this.getSheets();
  }
  async call(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof GSheetError) throw err;
        const status = statusOf(err);
        const network = ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(
          err?.code
        );
        if (attempt < this.retries && (status && RETRYABLE.has(status) || network)) {
          const delay = this.baseDelayMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
          await new Promise((res) => setTimeout(res, delay));
          continue;
        }
        const detail = err?.response?.data?.error?.message ?? err?.message ?? String(err);
        throw new GSheetError(
          "API",
          `Google Sheets API error${status ? ` (${status})` : ""}: ${detail}`,
          { cause: err }
        );
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
import { randomUUID } from "crypto";

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
      if (!this.cfg.create)
        throw new GSheetError("SCHEMA", `Tab "${this.cfg.tabName}" not found`);
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
    const values = await this.api.getValues(
      `${this.q}!A2:${colLetter(this.width)}`
    );
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
        range: {
          sheetId: this.sheetId,
          dimension: "ROWS",
          startIndex: rowNum - 1,
          endIndex: rowNum
        }
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
      const t = s.tables.find(
        (t2) => this.tableId ? t2.tableId === this.tableId : t2.name === this.cfg.tableName
      );
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
            values: Array.from(
              { length: width },
              (_, i) => cellData(r[i] ?? null)
            )
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
      return new TableDriver(api, {
        tableName,
        tabName: table.sheetTitle,
        existing: true
      });
    }
  }
  const tab = sheets.find((s) => s.title === tabName);
  if (spec.source === "sheet" || spec.source === "auto" && tab) {
    return new SheetDriver(api, {
      tabName,
      existing: Boolean(tab),
      create: spec.create
    });
  }
  if (!spec.create) {
    throw new GSheetError(
      "SCHEMA",
      `Table "${tableName}" not found and create is disabled`
    );
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
    if ("gt" in cond && !(comparable(val, norm(cond.gt)) && val > norm(cond.gt)))
      return false;
    if ("gte" in cond && !(comparable(val, norm(cond.gte)) && val >= norm(cond.gte)))
      return false;
    if ("lt" in cond && !(comparable(val, norm(cond.lt)) && val < norm(cond.lt)))
      return false;
    if ("lte" in cond && !(comparable(val, norm(cond.lte)) && val <= norm(cond.lte)))
      return false;
    if (cond.in && !cond.in.map(norm).includes(val))
      return false;
    if (cond.notIn && cond.notIn.map(norm).includes(val))
      return false;
    if (cond.contains !== void 0 && !str(val).includes(str(cond.contains)))
      return false;
    if (cond.startsWith !== void 0 && !str(val).startsWith(str(cond.startsWith)))
      return false;
    if (cond.endsWith !== void 0 && !str(val).endsWith(str(cond.endsWith)))
      return false;
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
function toKey(v, type) {
  if (v === null || v === void 0 || v === "") return null;
  const n = v instanceof Date ? v.getTime() : type === "date" ? new Date(v).getTime() : Number(v);
  return Number.isNaN(n) ? null : n;
}

// src/join.ts
async function join(left, right, opts) {
  const [lk, rk] = opts.on;
  const type = opts.type ?? "left";
  const leftRows = await left.findMany({
    where: opts.where,
    orderBy: opts.orderBy
  });
  if (leftRows.length && opts.as in leftRows[0]) {
    throw new GSheetError(
      "VALIDATION",
      `join: "${opts.as}" collides with a field of the left model`
    );
  }
  const keys = [
    ...new Set(
      leftRows.map((r) => norm(r[lk])).filter((k) => k != null)
    )
  ];
  const groups = /* @__PURE__ */ new Map();
  if (keys.length) {
    const keySet = new Set(keys);
    const where = opts.rightWhere ? (row) => keySet.has(norm(row[rk])) && matches(row, opts.rightWhere) : { [rk]: { in: keys } };
    for (const r of await right.findMany({ where })) {
      const k = norm(r[rk]);
      if (k == null) continue;
      const list = groups.get(k);
      list ? list.push(r) : groups.set(k, [r]);
    }
  }
  const out = [];
  for (const l of leftRows) {
    const lkVal = norm(l[lk]);
    const found = lkVal == null ? [] : groups.get(lkVal) ?? [];
    if (opts.many) {
      if (!found.length && type === "inner") continue;
      out.push({ ...l, [opts.as]: [...found] });
    } else {
      const first = found[0] ?? null;
      if (!first && type === "inner") continue;
      out.push({ ...l, [opts.as]: first });
    }
  }
  const start = opts.offset ?? 0;
  return out.slice(start, opts.limit != null ? start + opts.limit : void 0);
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
        throw new GSheetError(
          "SCHEMA",
          `[${name}] "${key}" is reserved and added automatically`
        );
      }
      this.fields[key] = typeof def === "string" ? { type: def } : def;
    }
    this.columns = [
      { name: "id", type: "string" },
      ...Object.entries(this.fields).map(([n, f]) => ({
        name: n,
        type: f.type,
        enum: f.enum
      })),
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
    this.header = await driver.init(this.columns, {
      migrate: o.migrate ?? true
    });
    this.driver = driver;
  }
  /* ------------------------------ mapping ------------------------------ */
  typeOf(col) {
    return this.columns.find((c) => c.name === col)?.type ?? "string";
  }
  toRow(raw) {
    const row = {};
    this.header.forEach((col, i) => {
      if (this.managed.has(col))
        row[col] = deserialize(raw[i], this.typeOf(col));
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
    if (!fresh && ttl && this.cache && Date.now() - this.cache.at < ttl)
      return this.cache.rows;
    const rows = (await this.driver.read()).filter((r) => r.values.some((v) => v !== "" && v != null && v !== false)).map((r) => ({
      rowNum: r.rowNum,
      raw: r.values,
      row: this.toRow(r.values)
    }));
    if (this.opts.healIds ?? true) {
      const orphans = rows.filter((r) => !r.row.id);
      if (orphans.length) {
        const now = /* @__PURE__ */ new Date();
        for (const o of orphans) {
          o.row.id = randomUUID();
          o.row.createdAt ||= now;
          o.row.updatedAt ||= now;
        }
        await this.driver.update(
          orphans.map((o) => ({
            rowNum: o.rowNum,
            values: this.toCells(o.row, o.raw)
          }))
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
        if (def.enum && !def.enum.includes(v))
          throw bad(`one of: ${def.enum.join(", ")}`);
        return v;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v))
          throw bad("a finite number");
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
      throw new GSheetError(
        "VALIDATION",
        `[${this.name}] "${key}" is required`
      );
    }
  }
  assertKnown(input, allowId, allowTimestamps = false) {
    for (const k of Object.keys(input)) {
      const ok = k in this.fields || allowId && k === "id" || allowTimestamps && (k === "createdAt" || k === "updatedAt");
      if (!ok) {
        throw new GSheetError(
          "VALIDATION",
          `[${this.name}] unknown field "${k}"`
        );
      }
    }
  }
  assertUnique(records, existing, only) {
    const keys = only ?? [
      "id",
      ...Object.keys(this.fields).filter((k) => this.fields[k].unique)
    ];
    for (const key of keys) {
      const owners = new Map(
        existing.map((e) => [norm(e.row[key]), e.row.id])
      );
      for (const rec of records) {
        const v = norm(rec[key]);
        if (v == null) continue;
        const owner = owners.get(v);
        if (owner !== void 0 && owner !== rec.id) {
          throw new GSheetError(
            "UNIQUE",
            `[${this.name}] "${key}" must be unique (duplicate: ${String(v)})`
          );
        }
        owners.set(v, rec.id);
      }
    }
  }
  /* ------------------------------ read ------------------------------ */
  async findMany(opts = {}) {
    const rows = (await this.load(opts.fresh)).map((l) => l.row).filter((r) => matches(r, opts.where));
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
    return this.insert(items, false);
  }
  /**
   * Inserts rows as they are, keeping their id / createdAt / updatedAt when given.
   * Use it to move or back-fill rows (for example when splitting a table into shards).
   */
  async importMany(rows) {
    return this.insert(rows, true);
  }
  async insert(items, keepSystem) {
    if (!items.length) return [];
    await this.sync();
    const now = /* @__PURE__ */ new Date();
    const records = items.map((item) => {
      const input = item;
      this.assertKnown(input, true, keepSystem);
      const rec = {};
      for (const [key, def] of Object.entries(this.fields)) {
        let v = input[key];
        if (v === void 0 && def.default !== void 0) {
          v = typeof def.default === "function" ? def.default() : def.default;
        }
        rec[key] = this.normalize(key, def, v);
        this.requireValue(key, def, rec[key]);
      }
      rec.id = input.id ?? randomUUID();
      rec.createdAt = keepSystem && input.createdAt ? new Date(input.createdAt) : now;
      rec.updatedAt = keepSystem && input.updatedAt ? new Date(input.updatedAt) : now;
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
    const touchedUnique = Object.keys(clean).filter(
      (k) => this.fields[k].unique
    );
    if (touchedUnique.length)
      this.assertUnique(
        next.map((n) => n.rec),
        all,
        touchedUnique
      );
    await this.driver.update(
      next.map((n) => ({
        rowNum: n.rowNum,
        values: this.toCells(n.rec, n.raw)
      }))
    );
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
    const targets = (await this.load(true)).filter(
      (l) => matches(l.row, where)
    );
    if (!targets.length) return 0;
    await this.driver.remove(targets.map((t) => t.rowNum));
    this.invalidate();
    return targets.length;
  }
  async deleteById(id) {
    return await this.delete({ id }) > 0;
  }
  /* ------------------------------ join ------------------------------ */
  /** Joins this model with another one (also across spreadsheets). See `join`. */
  join(other, opts) {
    return join(
      this,
      other,
      opts
    );
  }
};

// src/util.ts
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker)
  );
  return out;
}

// src/sharded.ts
var contains = (s, k) => (s.from === void 0 || k >= s.from) && (s.to === void 0 || k < s.to);
var ShardedModel = class {
  constructor(name, schema, opts, getApi) {
    this.name = name;
    const { partitionBy, shards, concurrency, ...modelOpts } = opts;
    const def = schema[partitionBy];
    const type = typeof def === "string" ? def : def?.type;
    if (type !== "date" && type !== "number") {
      throw new GSheetError("SCHEMA", `[${name}] partitionBy "${partitionBy}" must be a "date" or "number" field in the schema`);
    }
    if (!shards.length) throw new GSheetError("SCHEMA", `[${name}] at least one shard is required`);
    this.field = partitionBy;
    this.fieldType = type;
    this.limit = concurrency ?? 4;
    const bound = (v, what) => {
      if (v === void 0) return void 0;
      const k = toKey(v, type);
      if (k === null) throw new GSheetError("SCHEMA", `[${name}] invalid shard ${what}: ${String(v)}`);
      return k;
    };
    this.shards = shards.map((sd) => {
      let from = bound(sd.from, "from");
      let to = bound(sd.to, "to");
      if (sd.years) {
        if (type !== "date") throw new GSheetError("SCHEMA", `[${name}] "years" needs a date partition field`);
        const [y1, y2] = sd.years;
        from = Date.UTC(y1, 0, 1);
        to = y2 === null ? void 0 : Date.UTC(y2 + 1, 0, 1);
      }
      const label = sd.label ?? sd.spreadsheetId;
      const model = new Model(
        name,
        schema,
        { ...modelOpts, table: sd.table ?? modelOpts.table, sheet: sd.sheet ?? modelOpts.sheet, driver: sd.driver },
        () => getApi(sd.spreadsheetId)
      );
      return { spreadsheetId: sd.spreadsheetId, label, from, to, model };
    }).sort((a, b) => (a.from ?? -Infinity) - (b.from ?? -Infinity));
    for (let i = 0; i < this.shards.length; i++) {
      const s = this.shards[i];
      if (s.from !== void 0 && s.to !== void 0 && s.from >= s.to) {
        throw new GSheetError("SCHEMA", `[${name}] shard "${s.label}" has an empty range`);
      }
      const next = this.shards[i + 1];
      if (next && (s.to === void 0 || s.to > (next.from ?? -Infinity))) {
        throw new GSheetError("SCHEMA", `[${name}] shards "${s.label}" and "${next.label}" overlap`);
      }
    }
  }
  name;
  shards;
  field;
  fieldType;
  limit;
  /* ------------------------------ routing ------------------------------ */
  key(v) {
    return toKey(v, this.fieldType);
  }
  shardFor(value) {
    const k = this.key(value);
    if (k === null) throw new GSheetError("VALIDATION", `[${this.name}] "${this.field}" is required to pick a spreadsheet`);
    const shard = this.shards.find((s) => contains(s, k));
    if (!shard) {
      const shown = value instanceof Date ? value.toISOString() : String(value);
      throw new GSheetError("SHARD", `[${this.name}] no spreadsheet covers ${this.field}=${shown}`);
    }
    return shard;
  }
  pick(where) {
    if (!where || typeof where === "function") return this.shards;
    const cond = where[this.field];
    if (cond === void 0) return this.shards;
    const checks = [];
    if (!isOperator(cond)) {
      const k = this.key(cond);
      if (k === null) return this.shards;
      checks.push((s) => contains(s, k));
    } else {
      const c = cond;
      const num = (v) => this.key(v);
      if (c.eq !== void 0 && num(c.eq) !== null) {
        const k = num(c.eq);
        checks.push((s) => contains(s, k));
      }
      if (Array.isArray(c.in)) {
        const ks = c.in.map(num);
        if (ks.every((k) => k !== null)) checks.push((s) => ks.some((k) => contains(s, k)));
      }
      for (const op of ["gt", "gte"]) {
        const k = c[op] === void 0 ? null : num(c[op]);
        if (k !== null) checks.push((s) => s.to === void 0 || k < s.to);
      }
      for (const op of ["lt", "lte"]) {
        const k = c[op] === void 0 ? null : num(c[op]);
        if (k !== null) {
          checks.push((s) => s.from === void 0 || (op === "lte" ? k >= s.from : k > s.from));
        }
      }
    }
    return checks.length ? this.shards.filter((s) => checks.every((f) => f(s))) : this.shards;
  }
  /** Which spreadsheets a query with this `where` would touch. Handy to check pruning. */
  shardsFor(where) {
    return this.pick(where).map(({ spreadsheetId, label }) => ({ spreadsheetId, label }));
  }
  /** "table" or "sheet" for each spreadsheet, in range order (undefined until connected). */
  get sources() {
    return this.shards.map((s) => ({ label: s.label, source: s.model.source }));
  }
  /** Connects every spreadsheet (creates missing tabs/tables, adds missing columns). */
  async sync() {
    await mapLimit(this.shards, this.limit, (s) => s.model.sync());
  }
  /* ------------------------------ read ------------------------------ */
  async findMany(opts = {}) {
    const shards = this.pick(opts.where);
    if (shards.length === 1) return shards[0].model.findMany(opts);
    const lists = await mapLimit(
      shards,
      this.limit,
      (s) => s.model.findMany({ where: opts.where, fresh: opts.fresh })
    );
    const merged = sortRows(lists.flat(), opts.orderBy);
    const start = opts.offset ?? 0;
    return merged.slice(start, opts.limit != null ? start + opts.limit : void 0);
  }
  async findFirst(where) {
    for (const s of this.pick(where)) {
      const row = await s.model.findFirst(where);
      if (row) return row;
    }
    return null;
  }
  /** Scans newest to oldest. Pass a partition value as `hint` to read a single spreadsheet. */
  findById(id, hint) {
    return this.findByIdIn(id, hint).then((r) => r?.row ?? null);
  }
  async findByIdIn(id, hint) {
    const candidates = hint !== void 0 ? [this.shardFor(hint)] : [...this.shards].reverse();
    for (const shard of candidates) {
      const row = await shard.model.findById(id);
      if (row) return { shard, row };
    }
    return null;
  }
  async count(where) {
    const counts = await mapLimit(this.pick(where), this.limit, (s) => s.model.count(where));
    return counts.reduce((a, b) => a + b, 0);
  }
  /* ------------------------------ paging ------------------------------ */
  /**
   * Cursor paging over the spreadsheets, newest first by default.
   *
   * It reads only the newest spreadsheet until its rows are used up, then moves on to the
   * next one, so a "latest rows" screen costs one spreadsheet read and old years are never
   * touched unless the user keeps paging. Rows are ordered by the partition field, ties by id.
   *
   * The cursor is a position (not an offset), so rows added or removed between two calls do
   * not cause duplicates or gaps. Turn on the model `cache` to avoid re-reading the same
   * spreadsheet for every page.
   */
  async findPage(opts = {}) {
    const pageSize = opts.pageSize ?? 20;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new GSheetError("VALIDATION", `[${this.name}] pageSize must be a positive integer`);
    }
    const order = opts.order ?? "desc";
    const fill = opts.fill ?? true;
    let shards = this.pick(opts.where);
    if (order === "desc") shards = [...shards].reverse();
    let start = 0;
    let after = null;
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor, this.name);
      if (c.o !== order) {
        throw new GSheetError("VALIDATION", `[${this.name}] cursor was made with order "${c.o}", not "${order}"`);
      }
      start = shards.findIndex((sh) => sh.spreadsheetId === c.ss);
      if (start < 0) {
        throw new GSheetError("VALIDATION", `[${this.name}] cursor does not match the spreadsheets of this query`);
      }
      if (c.id !== null) after = { k: c.k, id: c.id };
    }
    const rows = [];
    const readShards = [];
    for (let i = start; i < shards.length; i++) {
      const shard = shards[i];
      readShards.push(shard.label);
      let list = await shard.model.findMany({
        where: opts.where,
        orderBy: [{ field: this.field, dir: order }, { field: "id" }],
        fresh: opts.fresh
      });
      if (i === start && after) {
        const pos = after;
        list = list.filter((r) => this.isAfter(r, pos, order));
      }
      const take = list.slice(0, pageSize - rows.length);
      rows.push(...take);
      if (list.length > take.length) {
        const last = take[take.length - 1];
        const cursor = encodeCursor({ o: order, ss: shard.spreadsheetId, k: this.key(last[this.field]), id: last.id });
        return { rows, cursor, hasMore: true, readShards };
      }
      const next = shards[i + 1];
      if (!next) return { rows, cursor: null, hasMore: false, readShards };
      if (rows.length >= pageSize || !fill && rows.length > 0) {
        const cursor = encodeCursor({ o: order, ss: next.spreadsheetId, k: null, id: null });
        return { rows, cursor, hasMore: true, readShards };
      }
    }
    return { rows, cursor: null, hasMore: false, readShards };
  }
  isAfter(row, pos, order) {
    const k = this.key(row[this.field]);
    if (k === null) return pos.k === null ? row.id > pos.id : true;
    if (pos.k === null) return false;
    if (k === pos.k) return row.id > pos.id;
    return order === "desc" ? k < pos.k : k > pos.k;
  }
  /** Walks all pages lazily. Stop early with `break` and the remaining spreadsheets are never read. */
  async *pages(opts = {}) {
    let cursor = null;
    do {
      const page = await this.findPage({ ...opts, cursor });
      if (page.rows.length) yield page.rows;
      cursor = page.cursor;
    } while (cursor);
  }
  /** The newest `limit` rows (default 20), reading as few spreadsheets as possible. */
  async findLatest(limit = 20, opts = {}) {
    return (await this.findPage({ ...opts, pageSize: limit, order: "desc" })).rows;
  }
  /* ------------------------------ create ------------------------------ */
  async create(data) {
    return (await this.createMany([data]))[0];
  }
  /**
   * Routes each item to its spreadsheet. Spreadsheets cannot share a transaction, so if one
   * spreadsheet fails after another succeeded, the earlier inserts stay.
   */
  async createMany(items) {
    return this.insertRouted(items, false);
  }
  /**
   * Like `createMany`, but keeps `id`, `createdAt` and `updatedAt` when given.
   * Handy to split an existing table over the shards.
   */
  async importMany(rows) {
    return this.insertRouted(rows, true);
  }
  async insertRouted(items, keepSystem) {
    const groups = /* @__PURE__ */ new Map();
    items.forEach((item, index) => {
      const shard = this.shardFor(item[this.field]);
      const list = groups.get(shard);
      list ? list.push({ index, item }) : groups.set(shard, [{ index, item }]);
    });
    const out = new Array(items.length);
    await mapLimit([...groups], this.limit, async ([shard, list]) => {
      const batch = list.map((l) => l.item);
      const rows = keepSystem ? await shard.model.importMany(batch) : await shard.model.createMany(batch);
      rows.forEach((row, i) => out[list[i].index] = row);
    });
    return out;
  }
  /* ------------------------------ update ------------------------------ */
  async update(where, data) {
    return this.updateIn(this.pick(where), where, data);
  }
  async updateById(id, data, hint) {
    const found = await this.findByIdIn(id, hint);
    if (!found) return null;
    return (await this.updateIn([found.shard], { id }, data))[0] ?? null;
  }
  /**
   * Updating the partition field moves the row to the spreadsheet that now owns it:
   * it is inserted there first and deleted from the old one afterwards, so a failure
   * leaves a duplicate rather than losing data.
   */
  async updateIn(shards, where, data) {
    const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== void 0));
    if (!(this.field in patch)) {
      const lists = await mapLimit(shards, this.limit, (s) => s.model.update(where, patch));
      return lists.flat();
    }
    const target = this.shardFor(patch[this.field]);
    const ordered = [...shards].sort((a, b) => Number(b === target) - Number(a === target));
    const results = [];
    for (const shard of ordered) {
      if (shard === target) {
        results.push(...await shard.model.update(where, patch));
        continue;
      }
      const rows = await shard.model.findMany({ where, fresh: true });
      if (!rows.length) continue;
      const ids = new Set(rows.map((r) => r.id));
      const now = /* @__PURE__ */ new Date();
      const moved = await target.model.importMany(
        rows.map((r) => ({ ...r, ...patch, updatedAt: now }))
      );
      await shard.model.delete(((row) => ids.has(row.id)));
      results.push(...moved);
    }
    return results;
  }
  async upsert(where, data) {
    for (const shard of this.pick(where)) {
      const [found] = await shard.model.findMany({ where, limit: 1, fresh: true });
      if (found) {
        const { id: _ignored, ...rest } = data;
        return (await this.updateIn([shard], { id: found.id }, rest))[0];
      }
    }
    return this.create(data);
  }
  /* ------------------------------ delete ------------------------------ */
  async delete(where) {
    const counts = await mapLimit(this.pick(where), this.limit, (s) => s.model.delete(where));
    return counts.reduce((a, b) => a + b, 0);
  }
  async deleteById(id, hint) {
    const found = await this.findByIdIn(id, hint);
    return found ? found.shard.model.deleteById(id) : false;
  }
  /* ------------------------------ join ------------------------------ */
  /** Joins with another model. The other side can be sharded too. See `join`. */
  join(other, opts) {
    return join(this, other, opts);
  }
};
var encodeCursor = (c) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(cursor, model) {
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if ((c.o === "asc" || c.o === "desc") && typeof c.ss === "string") return c;
  } catch {
  }
  throw new GSheetError("VALIDATION", `[${model}] invalid cursor`);
}

// src/db.ts
var GSheetDB = class {
  constructor(opts = {}) {
    this.opts = opts;
    this.getSheets = lazySheets(opts);
  }
  opts;
  apis = /* @__PURE__ */ new Map();
  getSheets;
  /** API handle for one spreadsheet. All spreadsheets share a single Google login. */
  apiFor(spreadsheetId) {
    let api = this.apis.get(spreadsheetId);
    if (!api) {
      api = new SheetsApi({ ...this.opts, spreadsheetId }, this.getSheets);
      this.apis.set(spreadsheetId, api);
    }
    return api;
  }
  /** API handle for the default spreadsheet. */
  get api() {
    if (!this.opts.spreadsheetId) {
      throw new GSheetError(
        "CONFIG",
        "No default spreadsheetId. Pass one to GSheetDB or to the model."
      );
    }
    return this.apiFor(this.opts.spreadsheetId);
  }
  model(name, schema, opts = {}) {
    if ("partitionBy" in opts && opts.partitionBy) {
      if (opts.spreadsheetId) {
        throw new GSheetError(
          "CONFIG",
          `[${name}] "spreadsheetId" cannot be combined with "partitionBy"`
        );
      }
      const shards = opts.shards ?? this.opts.shards;
      if (!shards?.length) {
        throw new GSheetError(
          "CONFIG",
          `[${name}] "partitionBy" needs shards: pass \`shards\` to GSheetDB (or to this model)`
        );
      }
      return this.sharded(name, schema, {
        ...opts,
        shards,
        concurrency: opts.concurrency ?? this.opts.concurrency
      });
    }
    const id = opts.spreadsheetId ?? this.opts.spreadsheetId;
    return new Model(name, schema, opts, () => {
      if (!id)
        throw new GSheetError(
          "CONFIG",
          `[${name}] no spreadsheetId. Pass one to GSheetDB or to the model.`
        );
      return this.apiFor(id);
    });
  }
  /**
   * Same as `db.model(name, schema, { partitionBy, shards })`, always with the shards given here.
   * Use it when this model has its own shard list.
   */
  sharded(name, schema, opts) {
    return new ShardedModel(name, schema, opts, (id) => this.apiFor(id));
  }
};
export {
  GSheetDB,
  GSheetError,
  Model,
  ShardedModel,
  SheetDriver,
  SheetsApi,
  TableDriver,
  join,
  resolveDriver
};
//# sourceMappingURL=index.js.map