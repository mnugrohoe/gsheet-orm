import { S as Schema, M as ModelOptions, F as FindOptions, R as Row, W as Where, C as CreateInput, U as UpdateInput, D as Driver, a as DateFormat, b as ColumnSpec, c as RawRow, d as Cell } from './types-DtTfM1Qg.cjs';
export { e as FieldDef, f as FieldType, I as InferRow, O as Operator, g as OrderBy } from './types-DtTfM1Qg.cjs';

interface ClientOptions {
    spreadsheetId: string;
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
}
interface SheetMeta {
    sheetId: number;
    title: string;
    tables: TableMeta[];
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
declare class SheetsApi implements SheetsApiLike {
    private readonly opts;
    readonly spreadsheetId: string;
    private _api?;
    private retries;
    private baseDelayMs;
    constructor(opts: ClientOptions);
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

declare class Model<S extends Schema = Schema> {
    readonly name: string;
    private readonly opts;
    private readonly getApi;
    /** Phantom field used by InferRow. Never set at runtime. */
    readonly __schema?: S;
    private readonly fields;
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
    update(where: Where<Row<S>>, data: UpdateInput<S>): Promise<Row<S>[]>;
    updateById(id: string, data: UpdateInput<S>): Promise<Row<S> | null>;
    /** Updates the first match, or creates a new row when nothing matches. */
    upsert(where: Where<Row<S>>, data: CreateInput<S>): Promise<Row<S>>;
    /** Deletes all matching rows and returns how many were removed. */
    delete(where: Where<Row<S>>): Promise<number>;
    deleteById(id: string): Promise<boolean>;
}

declare class GSheetDB {
    readonly api: SheetsApi;
    constructor(opts: ClientOptions);
    /**
     * Define a model. By default it binds to a Sheets Table named `name`, falls back to a tab
     * named `name`, and creates a new tab + Table when neither exists.
     */
    model<const S extends Schema>(name: string, schema: S, opts?: ModelOptions): Model<S>;
}

type ErrorCode = "CONFIG" | "SCHEMA" | "VALIDATION" | "UNIQUE" | "API";
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
    /** Best effort: extends the table range to the right and registers the new columns. */
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

export { Cell, type ClientOptions, ColumnSpec, CreateInput, DateFormat, Driver, type ErrorCode, FindOptions, GSheetDB, GSheetError, Model, ModelOptions, RawRow, Row, Schema, SheetDriver, type SheetMeta, SheetsApi, type SheetsApiLike, TableDriver, type TableMeta, UpdateInput, Where, resolveDriver };
