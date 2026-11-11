import type { SheetsApiLike } from "./client.js";
import type { Driver } from "./drivers/driver.js";
import { GSheetError } from "./errors.js";
import { join, type Joined, type JoinOptions, type JoinType, type Queryable } from "./join.js";
import { Model } from "./model.js";
import { isOperator, sortRows, toKey } from "./query.js";
import type {
  CreateInput,
  FindOptions,
  ModelOptions,
  Row,
  Schema,
  UpdateInput,
  Where,
} from "./types.js";
import { mapLimit } from "./util.js";

export interface ShardDef {
  spreadsheetId: string;
  /** Inclusive start of the range (Date, ISO string or number). Omit for "everything before `to`". */
  from?: Date | string | number;
  /** Exclusive end of the range. Omit for open-ended (for example the current year onwards). */
  to?: Date | string | number;
  /** Shorthand for date fields: whole years, inclusive, in UTC. `[2023, 2024]`, or `[2025, null]` for open-ended. */
  years?: [number, number | null];
  /** Name used in errors and in `shardsFor()`. */
  label?: string;
  /** Per-shard overrides, e.g. a tab called "items_2024". */
  table?: string;
  sheet?: string;
  /** Custom driver for this shard (tests). */
  driver?: Driver;
}

export interface ShardedOptions extends Omit<ModelOptions, "spreadsheetId" | "driver"> {
  /** Field the rows are split by. Must be a "date" or "number" field in the schema. */
  partitionBy: string;
  shards: ShardDef[];
  /** Max spreadsheets queried in parallel. Default 4. */
  concurrency?: number;
}

export interface FindPageOptions<R> {
  where?: Where<R>;
  /** Rows per page. Default 20. */
  pageSize?: number;
  /** `cursor` of the previous page. Omit or pass null for the first page. */
  cursor?: string | null;
  /** "desc" (default): newest spreadsheet and newest rows first. "asc": oldest first. */
  order?: "asc" | "desc";
  /**
   * true (default): when a spreadsheet runs out mid-page, read the next one to fill the page.
   * false: return the short page as it is, and read the next spreadsheet on the next call.
   */
  fill?: boolean;
  /** Skip the read cache. */
  fresh?: boolean;
}

export interface Page<R> {
  rows: R[];
  /** Pass this as `cursor` to get the next page. null means there is nothing more to read. */
  cursor: string | null;
  /** true when `cursor` is set. Older spreadsheets that were not read yet count as "maybe more". */
  hasMore: boolean;
  /** Labels of the spreadsheets that were read for this page. */
  readShards: string[];
}

/** Options of `db.model` when the model is split over the db-level (or its own) shards. */
export type PartitionedModelOptions = Omit<ShardedOptions, "shards"> & {
  /** Overrides the shards declared on GSheetDB for this model only. */
  shards?: ShardDef[];
};

interface Shard<S extends Schema> {
  spreadsheetId: string;
  label: string;
  from?: number;
  to?: number;
  model: Model<S>;
}

type Rec = Record<string, unknown>;

const contains = (s: { from?: number; to?: number }, k: number) =>
  (s.from === undefined || k >= s.from) && (s.to === undefined || k < s.to);

/**
 * One logical model stored over several spreadsheets, split by a date or number field.
 * Writes go to the shard that owns the row, reads only touch the shards that can match,
 * and results from several shards are merged (sorted, offset and limited as a whole).
 */
export class ShardedModel<S extends Schema = Schema> {
  declare readonly __schema?: S;

  private readonly shards: Shard<S>[];
  private readonly field: string;
  private readonly fieldType: "date" | "number";
  private readonly limit: number;
  private readonly autoUpdate: string[];

  constructor(
    readonly name: string,
    schema: S,
    opts: ShardedOptions,
    getApi: (spreadsheetId: string) => SheetsApiLike,
  ) {
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
    this.autoUpdate = Object.entries(schema)
      .filter(([, d]) => typeof d !== "string" && d.auto === "update")
      .map(([k]) => k);

    const bound = (v: Date | string | number | undefined, what: string): number | undefined => {
      if (v === undefined) return undefined;
      const k = toKey(v, type);
      if (k === null) throw new GSheetError("SCHEMA", `[${name}] invalid shard ${what}: ${String(v)}`);
      return k;
    };

    this.shards = shards
      .map((sd): Shard<S> => {
        let from = bound(sd.from, "from");
        let to = bound(sd.to, "to");
        if (sd.years) {
          if (type !== "date") throw new GSheetError("SCHEMA", `[${name}] "years" needs a date partition field`);
          const [y1, y2] = sd.years;
          from = Date.UTC(y1, 0, 1);
          to = y2 === null ? undefined : Date.UTC(y2 + 1, 0, 1);
        }
        const label = sd.label ?? sd.spreadsheetId;
        const model = new Model<S>(
          name,
          schema,
          { ...modelOpts, table: sd.table ?? modelOpts.table, sheet: sd.sheet ?? modelOpts.sheet, driver: sd.driver },
          () => getApi(sd.spreadsheetId),
        );
        return { spreadsheetId: sd.spreadsheetId, label, from, to, model };
      })
      .sort((a, b) => (a.from ?? -Infinity) - (b.from ?? -Infinity));

    for (let i = 0; i < this.shards.length; i++) {
      const s = this.shards[i]!;
      if (s.from !== undefined && s.to !== undefined && s.from >= s.to) {
        throw new GSheetError("SCHEMA", `[${name}] shard "${s.label}" has an empty range`);
      }
      const next = this.shards[i + 1];
      if (next && (s.to === undefined || s.to > (next.from ?? -Infinity))) {
        throw new GSheetError("SCHEMA", `[${name}] shards "${s.label}" and "${next.label}" overlap`);
      }
    }
  }

  /* ------------------------------ routing ------------------------------ */

  private key(v: unknown): number | null {
    return toKey(v, this.fieldType);
  }

  private shardFor(value: unknown): Shard<S> {
    const k = this.key(value);
    if (k === null) throw new GSheetError("VALIDATION", `[${this.name}] "${this.field}" is required to pick a spreadsheet`);
    const shard = this.shards.find((s) => contains(s, k));
    if (!shard) {
      const shown = value instanceof Date ? value.toISOString() : String(value);
      throw new GSheetError("SHARD", `[${this.name}] no spreadsheet covers ${this.field}=${shown}`);
    }
    return shard;
  }

  private pick(where?: Where<Row<S>>): Shard<S>[] {
    if (!where || typeof where === "function") return this.shards;
    const cond = (where as Rec)[this.field];
    if (cond === undefined) return this.shards;

    const checks: ((s: Shard<S>) => boolean)[] = [];
    if (!isOperator(cond)) {
      const k = this.key(cond);
      if (k === null) return this.shards;
      checks.push((s) => contains(s, k));
    } else {
      const c = cond as Rec;
      const num = (v: unknown) => this.key(v);
      if (c.eq !== undefined && num(c.eq) !== null) {
        const k = num(c.eq)!;
        checks.push((s) => contains(s, k));
      }
      if (Array.isArray(c.in)) {
        const ks = c.in.map(num);
        if (ks.every((k) => k !== null)) checks.push((s) => ks.some((k) => contains(s, k!)));
      }
      for (const op of ["gt", "gte"] as const) {
        const k = c[op] === undefined ? null : num(c[op]);
        if (k !== null) checks.push((s) => s.to === undefined || k < s.to);
      }
      for (const op of ["lt", "lte"] as const) {
        const k = c[op] === undefined ? null : num(c[op]);
        if (k !== null) {
          checks.push((s) => s.from === undefined || (op === "lte" ? k >= s.from : k > s.from));
        }
      }
    }
    return checks.length ? this.shards.filter((s) => checks.every((f) => f(s))) : this.shards;
  }

  /** Which spreadsheets a query with this `where` would touch. Handy to check pruning. */
  shardsFor(where?: Where<Row<S>>): { spreadsheetId: string; label: string }[] {
    return this.pick(where).map(({ spreadsheetId, label }) => ({ spreadsheetId, label }));
  }

  /** "table" or "sheet" for each spreadsheet, in range order (undefined until connected). */
  get sources() {
    return this.shards.map((s) => ({ label: s.label, source: s.model.source }));
  }

  /** Connects every spreadsheet (creates missing tabs/tables, adds missing columns). */
  async sync(): Promise<void> {
    await mapLimit(this.shards, this.limit, (s) => s.model.sync());
  }

  /* ------------------------------ read ------------------------------ */

  async findMany(opts: FindOptions<Row<S>> = {}): Promise<Row<S>[]> {
    const shards = this.pick(opts.where);
    if (shards.length === 1) return shards[0]!.model.findMany(opts);

    const lists = await mapLimit(shards, this.limit, (s) =>
      s.model.findMany({ where: opts.where, fresh: opts.fresh }),
    );
    const merged = sortRows(lists.flat(), opts.orderBy);
    const start = opts.offset ?? 0;
    return merged.slice(start, opts.limit != null ? start + opts.limit : undefined);
  }

  async findFirst(where?: Where<Row<S>>): Promise<Row<S> | null> {
    for (const s of this.pick(where)) {
      const row = await s.model.findFirst(where);
      if (row) return row;
    }
    return null;
  }

  /** Scans newest to oldest. Pass a partition value as `hint` to read a single spreadsheet. */
  findById(id: string, hint?: unknown): Promise<Row<S> | null> {
    return this.findByIdIn(id, hint).then((r) => r?.row ?? null);
  }

  private async findByIdIn(id: string, hint?: unknown): Promise<{ shard: Shard<S>; row: Row<S> } | null> {
    const candidates = hint !== undefined ? [this.shardFor(hint)] : [...this.shards].reverse();
    for (const shard of candidates) {
      const row = await shard.model.findById(id);
      if (row) return { shard, row };
    }
    return null;
  }

  async count(where?: Where<Row<S>>): Promise<number> {
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
  async findPage(opts: FindPageOptions<Row<S>> = {}): Promise<Page<Row<S>>> {
    const pageSize = opts.pageSize ?? 20;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new GSheetError("VALIDATION", `[${this.name}] pageSize must be a positive integer`);
    }
    const order = opts.order ?? "desc";
    const fill = opts.fill ?? true;

    let shards = this.pick(opts.where);
    if (order === "desc") shards = [...shards].reverse();

    let start = 0;
    let after: { k: number | null; id: string } | null = null;
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

    const rows: Row<S>[] = [];
    const readShards: string[] = [];

    for (let i = start; i < shards.length; i++) {
      const shard = shards[i]!;
      readShards.push(shard.label);

      let list = await shard.model.findMany({
        where: opts.where,
        orderBy: [{ field: this.field, dir: order }, { field: "id" }] as never,
        fresh: opts.fresh,
      });
      if (i === start && after) {
        const pos = after;
        list = list.filter((r) => this.isAfter(r, pos, order));
      }

      const take = list.slice(0, pageSize - rows.length);
      rows.push(...take);

      if (list.length > take.length) {
        const last = take[take.length - 1]!;
        if (!last.id) {
          throw new GSheetError(
            "VALIDATION",
            `[${this.name}] findPage needs an id on every row it pages through. Fill the id column, or set healIds: true.`,
          );
        }
        const cursor = encodeCursor({ o: order, ss: shard.spreadsheetId, k: this.key((last as Rec)[this.field]), id: last.id });
        return { rows, cursor, hasMore: true, readShards };
      }

      // this spreadsheet is used up
      const next = shards[i + 1];
      if (!next) return { rows, cursor: null, hasMore: false, readShards };
      if (rows.length >= pageSize || (!fill && rows.length > 0)) {
        const cursor = encodeCursor({ o: order, ss: next.spreadsheetId, k: null, id: null });
        return { rows, cursor, hasMore: true, readShards };
      }
    }
    return { rows, cursor: null, hasMore: false, readShards };
  }

  private isAfter(row: Row<S>, pos: { k: number | null; id: string }, order: "asc" | "desc"): boolean {
    const k = this.key((row as Rec)[this.field]);
    // empty partition values sort last in both directions
    if (k === null) return pos.k === null ? row.id > pos.id : true;
    if (pos.k === null) return false;
    if (k === pos.k) return row.id > pos.id;
    return order === "desc" ? k < pos.k : k > pos.k;
  }

  /** Walks all pages lazily. Stop early with `break` and the remaining spreadsheets are never read. */
  async *pages(opts: Omit<FindPageOptions<Row<S>>, "cursor"> = {}): AsyncGenerator<Row<S>[], void, undefined> {
    let cursor: string | null = null;
    do {
      const page: Page<Row<S>> = await this.findPage({ ...opts, cursor });
      if (page.rows.length) yield page.rows;
      cursor = page.cursor;
    } while (cursor);
  }

  /** The newest `limit` rows (default 20), reading as few spreadsheets as possible. */
  async findLatest(limit = 20, opts: { where?: Where<Row<S>>; fresh?: boolean } = {}): Promise<Row<S>[]> {
    return (await this.findPage({ ...opts, pageSize: limit, order: "desc" })).rows;
  }

  /* ------------------------------ create ------------------------------ */

  async create(data: CreateInput<S>): Promise<Row<S>> {
    return (await this.createMany([data]))[0]!;
  }

  /**
   * Routes each item to its spreadsheet. Spreadsheets cannot share a transaction, so if one
   * spreadsheet fails after another succeeded, the earlier inserts stay.
   */
  async createMany(items: CreateInput<S>[]): Promise<Row<S>[]> {
    return this.insertRouted(items);
  }

  /**
   * Same as `createMany`: given ids and values (including `auto` date fields) are kept as they are.
   * Handy to split an existing table over the shards.
   */
  async importMany(rows: CreateInput<S>[]): Promise<Row<S>[]> {
    return this.insertRouted(rows);
  }

  private async insertRouted(items: CreateInput<S>[]): Promise<Row<S>[]> {
    const groups = new Map<Shard<S>, { index: number; item: CreateInput<S> }[]>();
    items.forEach((item, index) => {
      const shard = this.shardFor((item as Rec)[this.field]);
      const list = groups.get(shard);
      list ? list.push({ index, item }) : groups.set(shard, [{ index, item }]);
    });

    const out = new Array<Row<S>>(items.length);
    await mapLimit([...groups], this.limit, async ([shard, list]) => {
      const rows = await shard.model.createMany(list.map((l) => l.item));
      rows.forEach((row, i) => (out[list[i]!.index] = row));
    });
    return out;
  }

  /* ------------------------------ update ------------------------------ */

  async update(where: Where<Row<S>>, data: UpdateInput<S>): Promise<Row<S>[]> {
    return this.updateIn(this.pick(where), where, data);
  }

  async updateById(id: string, data: UpdateInput<S>, hint?: unknown): Promise<Row<S> | null> {
    const found = await this.findByIdIn(id, hint);
    if (!found) return null;
    return (await this.updateIn([found.shard], { id } as Where<Row<S>>, data))[0] ?? null;
  }

  /**
   * Updating the partition field moves the row to the spreadsheet that now owns it:
   * it is inserted there first and deleted from the old one afterwards, so a failure
   * leaves a duplicate rather than losing data.
   */
  private async updateIn(shards: Shard<S>[], where: Where<Row<S>>, data: UpdateInput<S>): Promise<Row<S>[]> {
    const patch = Object.fromEntries(Object.entries(data as Rec).filter(([, v]) => v !== undefined));
    if (!(this.field in patch)) {
      const lists = await mapLimit(shards, this.limit, (s) => s.model.update(where, patch as UpdateInput<S>));
      return lists.flat();
    }

    const target = this.shardFor(patch[this.field]);
    const ordered = [...shards].sort((a, b) => Number(b === target) - Number(a === target));
    const results: Row<S>[] = [];

    for (const shard of ordered) {
      if (shard === target) {
        results.push(...(await shard.model.update(where, patch as UpdateInput<S>)));
        continue;
      }
      const rows = await shard.model.findMany({ where, fresh: true });
      if (!rows.length) continue;
      const ids = new Set(rows.map((r) => r.id));
      const now = new Date();
      const moved = await target.model.importMany(
        rows.map((r) => {
          const next: Rec = { ...r, ...patch };
          for (const k of this.autoUpdate) if (!(k in patch)) next[k] = now;
          return next as unknown as CreateInput<S>;
        }),
      );
      await shard.model.delete(((row: Row<S>) => ids.has(row.id)) as Where<Row<S>>);
      results.push(...moved);
    }
    return results;
  }

  async upsert(where: Where<Row<S>>, data: CreateInput<S>): Promise<Row<S>> {
    for (const shard of this.pick(where)) {
      const [found] = await shard.model.findMany({ where, limit: 1, fresh: true });
      if (found) {
        if (!found.id) {
          throw new GSheetError("VALIDATION", `[${this.name}] the matching row has no id, so it cannot be updated by upsert`);
        }
        const { id: _ignored, ...rest } = data as Rec;
        return (await this.updateIn([shard], { id: found.id } as Where<Row<S>>, rest as UpdateInput<S>))[0]!;
      }
    }
    return this.create(data);
  }

  /* ------------------------------ delete ------------------------------ */

  async delete(where: Where<Row<S>>): Promise<number> {
    const counts = await mapLimit(this.pick(where), this.limit, (s) => s.model.delete(where));
    return counts.reduce((a, b) => a + b, 0);
  }

  async deleteById(id: string, hint?: unknown): Promise<boolean> {
    const found = await this.findByIdIn(id, hint);
    return found ? found.shard.model.deleteById(id) : false;
  }

  /* ------------------------------ join ------------------------------ */

  /** Joins with another model. The other side can be sharded too. See `join`. */
  join<R extends object, As extends string, Many extends boolean = false, T extends JoinType = "left">(
    other: Queryable<R>,
    opts: JoinOptions<Row<S>, R, As, Many, T>,
  ): Promise<Joined<Row<S>, R, As, Many, T>[]> {
    return join<Row<S>, R, As, Many, T>(this as unknown as Queryable<Row<S>>, other, opts);
  }
}

interface CursorData {
  o: "asc" | "desc";
  ss: string;
  k: number | null;
  id: string | null;
}

const encodeCursor = (c: CursorData): string => Buffer.from(JSON.stringify(c)).toString("base64url");

function decodeCursor(cursor: string, model: string): CursorData {
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorData;
    if ((c.o === "asc" || c.o === "desc") && typeof c.ss === "string") return c;
  } catch {
    /* fall through */
  }
  throw new GSheetError("VALIDATION", `[${model}] invalid cursor`);
}
