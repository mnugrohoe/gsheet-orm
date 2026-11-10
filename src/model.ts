import { randomUUID } from "node:crypto";
import type { SheetsApiLike } from "./client.js";
import { deserialize, serialize } from "./codec.js";
import type { Cell, ColumnSpec, Driver } from "./drivers/driver.js";
import { resolveDriver } from "./drivers/resolve.js";
import { GSheetError } from "./errors.js";
import { join, type Joined, type JoinOptions, type JoinType, type Queryable } from "./join.js";
import { matches, norm, sortRows } from "./query.js";
import type {
  CreateInput,
  FieldDef,
  FieldType,
  FindOptions,
  ModelOptions,
  Row,
  Schema,
  UpdateInput,
  Where,
} from "./types.js";

const RESERVED = ["id"];

interface Loaded<S extends Schema> {
  row: Row<S>;
  rowNum: number;
  /** Raw cell values, kept so columns this model does not manage are written back untouched. */
  raw: unknown[];
}

type Rec = Record<string, unknown>;

export class Model<S extends Schema = Schema> {
  /** Phantom field used by InferRow. Never set at runtime. */
  declare readonly __schema?: S;

  private readonly fields: Record<string, FieldDef>;
  private readonly idColumn: string;
  private readonly autoFields: string[];
  private readonly managed: Set<string>;
  private readonly columns: ColumnSpec[];
  private driver?: Driver;
  private header: string[] = [];
  private ready?: Promise<void>;
  private cache?: { at: number; rows: Loaded<S>[] };

  constructor(
    readonly name: string,
    schema: S,
    private readonly opts: ModelOptions,
    private readonly getApi: () => SheetsApiLike,
  ) {
    this.idColumn = opts.idColumn ?? "id";
    this.fields = {};
    for (const [key, def] of Object.entries(schema)) {
      if (RESERVED.includes(key)) {
        throw new GSheetError("SCHEMA", `[${name}] "${key}" is reserved: it is the row id`);
      }
      if (key === this.idColumn) {
        throw new GSheetError(
          "SCHEMA",
          `[${name}] "${key}" is the idColumn, so it is the row's \`id\` property. Remove it from the schema.`,
        );
      }
      const f: FieldDef = typeof def === "string" ? { type: def } : def;
      if (f.auto && f.type !== "date") {
        throw new GSheetError("SCHEMA", `[${name}] "${key}": auto needs a date field`);
      }
      this.fields[key] = f;
    }
    this.autoFields = Object.keys(this.fields).filter((k) => this.fields[k]!.auto);
    this.columns = [
      { name: this.idColumn, type: "string" },
      ...Object.entries(this.fields).map(([n, f]) => ({ name: n, type: f.type, enum: f.enum })),
    ];
    this.managed = new Set(this.columns.map((c) => c.name));
  }

  /* ------------------------------ setup ------------------------------ */

  /** "table" or "sheet" once connected (after the first call or sync()). */
  get source(): "table" | "sheet" | undefined {
    return this.driver?.kind;
  }

  /** Connects, creates the tab/table if allowed and adds missing columns. Runs automatically. */
  sync(): Promise<void> {
    this.ready ??= this.init().catch((e) => {
      this.ready = undefined; // allow retry
      throw e;
    });
    return this.ready;
  }

  private async init() {
    const o = this.opts;
    const driver =
      o.driver ??
      (await resolveDriver(this.getApi(), {
        name: this.name,
        source: o.source ?? "auto",
        table: o.table,
        sheet: o.sheet,
        create: o.create ?? true,
      }));
    this.header = await driver.init(this.columns, { migrate: o.migrate ?? true });
    this.driver = driver;
  }

  /* ------------------------------ mapping ------------------------------ */

  /** Property name of a column: the id column is exposed as `id`. */
  private prop(col: string): string {
    return col === this.idColumn ? "id" : col;
  }

  private typeOf(col: string): FieldType {
    return this.columns.find((c) => c.name === col)?.type ?? "string";
  }

  private toRow(raw: unknown[]): Row<S> {
    const row: Rec = {};
    this.header.forEach((col, i) => {
      if (this.managed.has(col)) row[this.prop(col)] = deserialize(raw[i], this.typeOf(col));
    });
    return row as Row<S>;
  }

  private toCells(rec: Rec, base?: unknown[]): Cell[] {
    const driver = this.driver!;
    return this.header.map((col, i) =>
      this.managed.has(col)
        ? serialize(rec[this.prop(col)], this.typeOf(col), driver.dateFormat)
        : ((base?.[i] ?? null) as Cell),
    );
  }

  private async load(fresh = false): Promise<Loaded<S>[]> {
    await this.sync();
    const ttl = this.opts.cache ? this.opts.cache.ttlMs : 0;
    if (!fresh && ttl && this.cache && Date.now() - this.cache.at < ttl) return this.cache.rows;

    const rows = (await this.driver!.read())
      .filter((r) => r.values.some((v) => v !== "" && v != null && v !== false))
      .map((r) => ({ rowNum: r.rowNum, raw: r.values, row: this.toRow(r.values) }));

    // rows typed in by hand in Sheets have no id yet: assign one so they can be updated/deleted
    if (this.opts.healIds ?? this.idColumn === "id") {
      const orphans = rows.filter((r) => !r.row.id);
      if (orphans.length) {
        const now = new Date();
        for (const o of orphans) {
          o.row.id = randomUUID();
          for (const k of this.autoFields) {
            const r = o.row as Rec;
            if (r[k] == null) r[k] = now;
          }
        }
        await this.driver!.update(
          orphans.map((o) => ({ rowNum: o.rowNum, values: this.toCells(o.row as Rec, o.raw) })),
        );
      }
    }

    this.cache = ttl ? { at: Date.now(), rows } : undefined;
    return rows;
  }

  private invalidate() {
    this.cache = undefined;
  }

  /* ------------------------------ validation ------------------------------ */

  private normalize(key: string, def: FieldDef, v: unknown): unknown {
    if (v === null || v === undefined) return null;
    const bad = (what: string) => new GSheetError("VALIDATION", `[${this.name}] "${key}" must be ${what}`);
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
        const d = v instanceof Date ? v : new Date(v as string);
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

  private requireValue(key: string, def: FieldDef, v: unknown) {
    if (def.required && (v === null || v === undefined || v === "")) {
      throw new GSheetError("VALIDATION", `[${this.name}] "${key}" is required`);
    }
  }

  private assertKnown(input: Rec, allowId: boolean) {
    for (const k of Object.keys(input)) {
      if (!(k in this.fields) && !(allowId && k === "id")) {
        throw new GSheetError("VALIDATION", `[${this.name}] unknown field "${k}"`);
      }
    }
  }

  private assertUnique(records: Rec[], existing: Loaded<S>[], only?: string[]) {
    const keys = only ?? ["id", ...Object.keys(this.fields).filter((k) => this.fields[k]!.unique)];
    for (const key of keys) {
      const owners = new Map<unknown, unknown>(
        existing.map((e) => [norm((e.row as Rec)[key]), e.row.id]),
      );
      for (const rec of records) {
        const v = norm(rec[key]);
        if (v == null) continue;
        const owner = owners.get(v);
        if (owner !== undefined && owner !== rec.id) {
          throw new GSheetError("UNIQUE", `[${this.name}] "${key}" must be unique (duplicate: ${String(v)})`);
        }
        owners.set(v, rec.id);
      }
    }
  }

  /* ------------------------------ read ------------------------------ */

  async findMany(opts: FindOptions<Row<S>> = {}): Promise<Row<S>[]> {
    const rows = (await this.load(opts.fresh)).map((l) => l.row).filter((r) => matches(r, opts.where));
    const sorted = sortRows(rows, opts.orderBy);
    const start = opts.offset ?? 0;
    const end = opts.limit != null ? start + opts.limit : undefined;
    return sorted.slice(start, end).map((r) => ({ ...r }));
  }

  async findFirst(where?: Where<Row<S>>): Promise<Row<S> | null> {
    return (await this.findMany({ where, limit: 1 }))[0] ?? null;
  }

  findById(id: string): Promise<Row<S> | null> {
    return this.findFirst({ id } as Where<Row<S>>);
  }

  async count(where?: Where<Row<S>>): Promise<number> {
    return (await this.load()).filter((l) => matches(l.row, where)).length;
  }

  /* ------------------------------ create ------------------------------ */

  async create(data: CreateInput<S>): Promise<Row<S>> {
    return (await this.createMany([data]))[0]!;
  }

  async createMany(items: CreateInput<S>[]): Promise<Row<S>[]> {
    return this.insert(items);
  }

  /**
   * Same as `createMany`. Given ids and values (including `auto` date fields) are kept as they are,
   * which is what you want when moving or back-filling rows, for example when splitting a table into shards.
   */
  async importMany(rows: CreateInput<S>[]): Promise<Row<S>[]> {
    return this.insert(rows);
  }

  private async insert(items: CreateInput<S>[]): Promise<Row<S>[]> {
    if (!items.length) return [];
    await this.sync();
    const now = new Date();

    const records = items.map((item) => {
      const input = item as Rec;
      this.assertKnown(input, true);
      const rec: Rec = {};
      for (const [key, def] of Object.entries(this.fields)) {
        let v = input[key];
        if (v === undefined && def.auto) v = now;
        else if (v === undefined && def.default !== undefined) {
          v = typeof def.default === "function" ? (def.default as () => unknown)() : def.default;
        }
        rec[key] = this.normalize(key, def, v);
        this.requireValue(key, def, rec[key]);
      }
      rec.id = (input.id as string | undefined) ?? randomUUID();
      return rec;
    });

    this.assertUnique(records, await this.load(true));
    await this.driver!.append(records.map((r) => this.toCells(r)));
    this.invalidate();
    return records as unknown as Row<S>[];
  }

  /* ------------------------------ update ------------------------------ */

  async update(where: Where<Row<S>>, data: UpdateInput<S>): Promise<Row<S>[]> {
    const patch = data as Rec;
    this.assertKnown(patch, false);

    const all = await this.load(true);
    const targets = all.filter((l) => matches(l.row, where));
    if (!targets.length) return [];
    return this.applyUpdate(all, targets, patch);
  }

  private async applyUpdate(all: Loaded<S>[], targets: Loaded<S>[], patch: Rec): Promise<Row<S>[]> {
    const clean: Rec = {};
    for (const [key, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      const def = this.fields[key]!;
      clean[key] = this.normalize(key, def, v);
      this.requireValue(key, def, clean[key]);
    }

    const now = new Date();
    const next = targets.map((t) => {
      const rec: Rec = { ...(t.row as Rec), ...clean };
      for (const k of this.autoFields) {
        if (this.fields[k]!.auto === "update" && !(k in clean)) rec[k] = now;
      }
      return { rowNum: t.rowNum, raw: t.raw, rec };
    });

    const touchedUnique = Object.keys(clean).filter((k) => this.fields[k]!.unique);
    if (touchedUnique.length) this.assertUnique(next.map((n) => n.rec), all, touchedUnique);

    await this.driver!.update(next.map((n) => ({ rowNum: n.rowNum, values: this.toCells(n.rec, n.raw) })));
    this.invalidate();
    return next.map((n) => n.rec as unknown as Row<S>);
  }

  private requireId(id: unknown) {
    if (id === null || id === undefined || id === "") {
      throw new GSheetError("VALIDATION", `[${this.name}] an id is required`);
    }
  }

  async updateById(id: string, data: UpdateInput<S>): Promise<Row<S> | null> {
    this.requireId(id);
    return (await this.update({ id } as Where<Row<S>>, data))[0] ?? null;
  }

  /** Updates the first match, or creates a new row when nothing matches. */
  async upsert(where: Where<Row<S>>, data: CreateInput<S>): Promise<Row<S>> {
    const all = await this.load(true);
    const found = all.find((l) => matches(l.row, where));
    if (found) {
      const { id: _ignored, ...rest } = data as Rec;
      this.assertKnown(rest, false);
      return (await this.applyUpdate(all, [found], rest))[0]!;
    }
    return this.create(data);
  }

  /* ------------------------------ delete ------------------------------ */

  /** Deletes all matching rows and returns how many were removed. */
  async delete(where: Where<Row<S>>): Promise<number> {
    const targets = (await this.load(true)).filter((l) => matches(l.row, where));
    if (!targets.length) return 0;
    await this.driver!.remove(targets.map((t) => t.rowNum));
    this.invalidate();
    return targets.length;
  }

  async deleteById(id: string): Promise<boolean> {
    this.requireId(id);
    return (await this.delete({ id } as Where<Row<S>>)) > 0;
  }

  /* ------------------------------ join ------------------------------ */

  /** Joins this model with another one (also across spreadsheets). See `join`. */
  join<R extends object, As extends string, Many extends boolean = false, T extends JoinType = "left">(
    other: Queryable<R>,
    opts: JoinOptions<Row<S>, R, As, Many, T>,
  ): Promise<Joined<Row<S>, R, As, Many, T>[]> {
    return join<Row<S>, R, As, Many, T>(this as unknown as Queryable<Row<S>>, other, opts);
  }
}
