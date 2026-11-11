import { sheets_v4 } from '@googleapis/sheets';
import { W as Where, O as OrderBy, S as Schema, M as ModelOptions, F as FindOptions, R as Row, C as CreateInput, U as UpdateInput, D as Driver, a as DateFormat, b as ColumnSpec, c as RawRow, d as Cell } from './types-BfjImFSN.js';
export { e as FieldDef, f as FieldType, I as InferRow, g as Operator, h as SystemFields } from './types-BfjImFSN.js';

interface ClientOptions {
    /** Default spreadsheet. Optional when every model passes its own (or uses shards). */
    spreadsheetId?: string;
    /** Service-account credentials. Defaults to env GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY. */
    credentials?: {
        clientEmail: string;
        privateKey: string;
    };
    /** Bring your own auth client (GoogleAuth, JWT, OAuth2Client...). Takes precedence over credentials. */
    auth?: unknown;
    /** Retry on 429 / 5xx with exponential backoff. Default { retries: 4, baseDelayMs: 500 }. */
    retry?: {
        retries?: number;
        baseDelayMs?: number;
    } | false;
}
interface TableRange {
    sheetId: number;
    startRowIndex: number;
    endRowIndex: number;
    startColumnIndex: number;
    endColumnIndex: number;
}
interface TableMeta {
    tableId: string;
    name: string;
    sheetTitle: string;
    range: TableRange;
    columnProperties: any[];
    hasFooter: boolean;
    /** Size of the sheet grid the table sits on (rows / columns), when known. */
    gridRows?: number;
    gridColumns?: number;
}
interface SheetMeta {
    sheetId: number;
    title: string;
    tables: TableMeta[];
    /** Size of the grid, when known. A sheet cannot hold data outside of it. */
    rowCount?: number;
    columnCount?: number;
}
/** The slice of the Sheets API this library uses. Implemented by SheetsApi; fakeable in tests. */
interface SheetsApiLike {
    listSheets(): Promise<SheetMeta[]>;
    batchUpdate(requests: unknown[]): Promise<any>;
    getValues(range: string): Promise<unknown[][]>;
    updateValues(range: string, values: unknown[][]): Promise<void>;
    batchUpdateValues(data: {
        range: string;
        values: unknown[][];
    }[]): Promise<void>;
    appendValues(range: string, values: unknown[][]): Promise<void>;
}
type SheetsGetter = () => sheets_v4.Sheets;
declare class SheetsApi implements SheetsApiLike {
    readonly spreadsheetId: string;
    private getSheets;
    private retries;
    private baseDelayMs;
    constructor(opts: ClientOptions & {
        spreadsheetId: string;
    }, shared?: SheetsGetter);
    private get api();
    private call;
    listSheets(): Promise<SheetMeta[]>;
    batchUpdate(requests: unknown[]): Promise<any>;
    getValues(range: string): Promise<unknown[][]>;
    updateValues(range: string, values: unknown[][]): Promise<void>;
    batchUpdateValues(data: {
        range: string;
        values: unknown[][];
    }[]): Promise<void>;
    appendValues(range: string, values: unknown[][]): Promise<void>;
}

/** Anything with findMany: a Model, a ShardedModel, or your own wrapper. */
interface Queryable<R> {
    findMany(opts?: {
        where?: Where<R>;
        orderBy?: OrderBy<R> | OrderBy<R>[];
    }): Promise<R[]>;
}
type JoinType = "left" | "inner";
interface JoinOptions<L, R, As extends string, Many extends boolean, T extends JoinType> {
    /** [field on the left model, field on the right model] */
    on: [keyof L & string, keyof R & string];
    /** Property that receives the joined row(s). */
    as: As;
    /** "left" keeps unmatched left rows (default), "inner" drops them. */
    type?: T;
    /** true: `as` is an array of all matches. false (default): the first match, or null. */
    many?: Many;
    where?: Where<L>;
    rightWhere?: Where<R>;
    orderBy?: OrderBy<L> | OrderBy<L>[];
    limit?: number;
    offset?: number;
}
type Joined<L, R, As extends string, Many extends boolean, T extends JoinType> = L & {
    [K in As]: Many extends true ? R[] : T extends "inner" ? R : R | null;
};
/**
 * Hash join between any two models, including models on different spreadsheets.
 * Reads the left side first, then only the right rows whose key appears on the left.
 */
declare function join<L extends object, R extends object, As extends string, Many extends boolean = false, T extends JoinType = "left">(left: Queryable<L>, right: Queryable<R>, opts: JoinOptions<L, R, As, Many, T>): Promise<Joined<L, R, As, Many, T>[]>;

declare class Model<S extends Schema = Schema> {
    readonly name: string;
    private readonly opts;
    private readonly getApi;
    /** Phantom field used by InferRow. Never set at runtime. */
    readonly __schema?: S;
    private readonly fields;
    private readonly idColumn;
    private readonly autoFields;
    private readonly managed;
    private readonly columns;
    private driver?;
    private header;
    private ready?;
    private cache?;
    constructor(name: string, schema: S, opts: ModelOptions, getApi: () => SheetsApiLike);
    /** "table" or "sheet" once connected (after the first call or sync()). */
    get source(): "table" | "sheet" | undefined;
    /** Connects, creates the tab/table if allowed and adds missing columns. Runs automatically. */
    sync(): Promise<void>;
    private init;
    /** Property name of a column: the id column is exposed as `id`. */
    private prop;
    private typeOf;
    private toRow;
    private toCells;
    private load;
    private invalidate;
    private normalize;
    private requireValue;
    private assertKnown;
    private assertUnique;
    findMany(opts?: FindOptions<Row<S>>): Promise<Row<S>[]>;
    findFirst(where?: Where<Row<S>>): Promise<Row<S> | null>;
    findById(id: string): Promise<Row<S> | null>;
    count(where?: Where<Row<S>>): Promise<number>;
    create(data: CreateInput<S>): Promise<Row<S>>;
    createMany(items: CreateInput<S>[]): Promise<Row<S>[]>;
    /**
     * Same as `createMany`. Given ids and values (including `auto` date fields) are kept as they are,
     * which is what you want when moving or back-filling rows, for example when splitting a table into shards.
     */
    importMany(rows: CreateInput<S>[]): Promise<Row<S>[]>;
    private insert;
    update(where: Where<Row<S>>, data: UpdateInput<S>): Promise<Row<S>[]>;
    private applyUpdate;
    private requireId;
    updateById(id: string, data: UpdateInput<S>): Promise<Row<S> | null>;
    /** Updates the first match, or creates a new row when nothing matches. */
    upsert(where: Where<Row<S>>, data: CreateInput<S>): Promise<Row<S>>;
    /** Deletes all matching rows and returns how many were removed. */
    delete(where: Where<Row<S>>): Promise<number>;
    deleteById(id: string): Promise<boolean>;
    /** Joins this model with another one (also across spreadsheets). See `join`. */
    join<R extends object, As extends string, Many extends boolean = false, T extends JoinType = "left">(other: Queryable<R>, opts: JoinOptions<Row<S>, R, As, Many, T>): Promise<Joined<Row<S>, R, As, Many, T>[]>;
}

interface ShardDef {
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
interface ShardedOptions extends Omit<ModelOptions, "spreadsheetId" | "driver"> {
    /** Field the rows are split by. Must be a "date" or "number" field in the schema. */
    partitionBy: string;
    shards: ShardDef[];
    /** Max spreadsheets queried in parallel. Default 4. */
    concurrency?: number;
}
interface FindPageOptions<R> {
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
interface Page<R> {
    rows: R[];
    /** Pass this as `cursor` to get the next page. null means there is nothing more to read. */
    cursor: string | null;
    /** true when `cursor` is set. Older spreadsheets that were not read yet count as "maybe more". */
    hasMore: boolean;
    /** Labels of the spreadsheets that were read for this page. */
    readShards: string[];
}
/** Options of `db.model` when the model is split over the db-level (or its own) shards. */
type PartitionedModelOptions = Omit<ShardedOptions, "shards"> & {
    /** Overrides the shards declared on GSheetDB for this model only. */
    shards?: ShardDef[];
};
/**
 * One logical model stored over several spreadsheets, split by a date or number field.
 * Writes go to the shard that owns the row, reads only touch the shards that can match,
 * and results from several shards are merged (sorted, offset and limited as a whole).
 */
declare class ShardedModel<S extends Schema = Schema> {
    readonly name: string;
    readonly __schema?: S;
    private readonly shards;
    private readonly field;
    private readonly fieldType;
    private readonly limit;
    private readonly autoUpdate;
    constructor(name: string, schema: S, opts: ShardedOptions, getApi: (spreadsheetId: string) => SheetsApiLike);
    private key;
    private shardFor;
    private pick;
    /** Which spreadsheets a query with this `where` would touch. Handy to check pruning. */
    shardsFor(where?: Where<Row<S>>): {
        spreadsheetId: string;
        label: string;
    }[];
    /** "table" or "sheet" for each spreadsheet, in range order (undefined until connected). */
    get sources(): {
        label: string;
        source: "table" | "sheet" | undefined;
    }[];
    /** Connects every spreadsheet (creates missing tabs/tables, adds missing columns). */
    sync(): Promise<void>;
    findMany(opts?: FindOptions<Row<S>>): Promise<Row<S>[]>;
    findFirst(where?: Where<Row<S>>): Promise<Row<S> | null>;
    /** Scans newest to oldest. Pass a partition value as `hint` to read a single spreadsheet. */
    findById(id: string, hint?: unknown): Promise<Row<S> | null>;
    private findByIdIn;
    count(where?: Where<Row<S>>): Promise<number>;
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
    findPage(opts?: FindPageOptions<Row<S>>): Promise<Page<Row<S>>>;
    private isAfter;
    /** Walks all pages lazily. Stop early with `break` and the remaining spreadsheets are never read. */
    pages(opts?: Omit<FindPageOptions<Row<S>>, "cursor">): AsyncGenerator<Row<S>[], void, undefined>;
    /** The newest `limit` rows (default 20), reading as few spreadsheets as possible. */
    findLatest(limit?: number, opts?: {
        where?: Where<Row<S>>;
        fresh?: boolean;
    }): Promise<Row<S>[]>;
    create(data: CreateInput<S>): Promise<Row<S>>;
    /**
     * Routes each item to its spreadsheet. Spreadsheets cannot share a transaction, so if one
     * spreadsheet fails after another succeeded, the earlier inserts stay.
     */
    createMany(items: CreateInput<S>[]): Promise<Row<S>[]>;
    /**
     * Same as `createMany`: given ids and values (including `auto` date fields) are kept as they are.
     * Handy to split an existing table over the shards.
     */
    importMany(rows: CreateInput<S>[]): Promise<Row<S>[]>;
    private insertRouted;
    update(where: Where<Row<S>>, data: UpdateInput<S>): Promise<Row<S>[]>;
    updateById(id: string, data: UpdateInput<S>, hint?: unknown): Promise<Row<S> | null>;
    /**
     * Updating the partition field moves the row to the spreadsheet that now owns it:
     * it is inserted there first and deleted from the old one afterwards, so a failure
     * leaves a duplicate rather than losing data.
     */
    private updateIn;
    upsert(where: Where<Row<S>>, data: CreateInput<S>): Promise<Row<S>>;
    delete(where: Where<Row<S>>): Promise<number>;
    deleteById(id: string, hint?: unknown): Promise<boolean>;
    /** Joins with another model. The other side can be sharded too. See `join`. */
    join<R extends object, As extends string, Many extends boolean = false, T extends JoinType = "left">(other: Queryable<R>, opts: JoinOptions<Row<S>, R, As, Many, T>): Promise<Joined<Row<S>, R, As, Many, T>[]>;
}

interface GSheetDBOptions extends ClientOptions {
    /**
     * Spreadsheets this database is split over, by range (for example one per year).
     * Models opt in with `db.model(name, schema, { partitionBy: "field" })`.
     * Models without `partitionBy` keep using `spreadsheetId`.
     */
    shards?: ShardDef[];
    /** Max spreadsheets queried in parallel by sharded models. Default 4. */
    concurrency?: number;
}
declare class GSheetDB {
    private readonly opts;
    private readonly apis;
    private readonly getSheets;
    constructor(opts?: GSheetDBOptions);
    /** API handle for one spreadsheet. All spreadsheets share a single Google login. */
    apiFor(spreadsheetId: string): SheetsApi;
    /** API handle for the default spreadsheet. */
    get api(): SheetsApi;
    /**
     * Define a model. It has the same methods whether or not it is sharded.
     *
     * - Without `partitionBy`: one spreadsheet (`options.spreadsheetId`, else the default one).
     *   It binds to a Sheets Table named `name`, falls back to a tab named `name`, and creates a
     *   Table when neither exists.
     * - With `partitionBy`: rows are split over the shards declared on `GSheetDB`
     *   (or on this model) by that date or number field, and routed automatically.
     */
    model<const S extends Schema>(name: string, schema: S, opts: PartitionedModelOptions): ShardedModel<S>;
    model<const S extends Schema>(name: string, schema: S, opts?: ModelOptions): Model<S>;
    /**
     * Same as `db.model(name, schema, { partitionBy, shards })`, always with the shards given here.
     * Use it when this model has its own shard list.
     */
    sharded<const S extends Schema>(name: string, schema: S, opts: ShardedOptions): ShardedModel<S>;
}

type ErrorCode = "CONFIG" | "SCHEMA" | "VALIDATION" | "UNIQUE" | "SHARD" | "API";
declare class GSheetError extends Error {
    readonly code: ErrorCode;
    constructor(code: ErrorCode, message: string, options?: {
        cause?: unknown;
    });
}

interface ResolveSpec {
    name: string;
    source: "auto" | "table" | "sheet";
    table?: string;
    sheet?: string;
    create: boolean;
}
/**
 * Picks the storage backend. Tables always win:
 *   1. a Table named `table` (anywhere in the spreadsheet)
 *   2. a plain tab named `sheet`        (auto / sheet only)
 *   3. create tab + Table               (auto / table) or tab only (sheet)
 */
declare function resolveDriver(api: SheetsApiLike, spec: ResolveSpec): Promise<Driver>;

interface TableDriverConfig {
    tableName: string;
    tabName: string;
    /** false = the table does not exist yet and init() must create it. */
    existing: boolean;
}
/** Stores rows in a Google Sheets Table (header + typed columns + auto-expanding range). */
declare class TableDriver implements Driver {
    private readonly api;
    private readonly cfg;
    readonly kind: "table";
    readonly dateFormat: DateFormat;
    private tableId?;
    private meta?;
    constructor(api: SheetsApiLike, cfg: TableDriverConfig);
    init(columns: ColumnSpec[], { migrate }: {
        migrate: boolean;
    }): Promise<string[]>;
    private createTable;
    private fetchMeta;
    private readHeader;
    /**
     * Extends the table to the right to make room for new columns.
     *
     * Only the table `range` is updated. The definitions of the existing columns (dropdowns that point
     * at other tables, column types, ...) are not sent back, because Google rejects some of them in the
     * form it returns them (for example `=Person[Name]`). New columns get the default column type in Sheets.
     */
    private addColumns;
    read(): Promise<RawRow[]>;
    private width;
    append(rows: Cell[][]): Promise<void>;
    update(rows: {
        rowNum: number;
        values: Cell[];
    }[]): Promise<void>;
    remove(rowNums: number[]): Promise<void>;
}

interface SheetDriverConfig {
    tabName: string;
    /** false = the tab does not exist yet and init() must create it (when create is allowed). */
    existing: boolean;
    create: boolean;
}
/** Stores rows in a plain tab: header in row 1, data from row 2. */
declare class SheetDriver implements Driver {
    private readonly api;
    private readonly cfg;
    readonly kind: "sheet";
    readonly dateFormat: DateFormat;
    private sheetId?;
    private width;
    constructor(api: SheetsApiLike, cfg: SheetDriverConfig);
    private get q();
    init(columns: ColumnSpec[], { migrate }: {
        migrate: boolean;
    }): Promise<string[]>;
    read(): Promise<RawRow[]>;
    append(rows: Cell[][]): Promise<void>;
    update(rows: {
        rowNum: number;
        values: Cell[];
    }[]): Promise<void>;
    remove(rowNums: number[]): Promise<void>;
}

export { Cell, type ClientOptions, ColumnSpec, CreateInput, DateFormat, Driver, type ErrorCode, FindOptions, type FindPageOptions, GSheetDB, type GSheetDBOptions, GSheetError, type JoinOptions, type JoinType, type Joined, Model, ModelOptions, OrderBy, type Page, type PartitionedModelOptions, type Queryable, RawRow, Row, Schema, type ShardDef, ShardedModel, type ShardedOptions, SheetDriver, type SheetMeta, SheetsApi, type SheetsApiLike, TableDriver, type TableMeta, UpdateInput, Where, join, resolveDriver };
