type Cell = string | number | boolean | null;
type DateFormat = "serial" | "iso";
interface ColumnSpec {
    name: string;
    type: FieldType;
    enum?: readonly string[];
}
interface RawRow {
    /** 1-based row number in the spreadsheet. */
    rowNum: number;
    values: unknown[];
}
/** Storage backend for one model: a Sheets Table, a plain tab, or an in-memory fake. */
interface Driver {
    readonly kind: "table" | "sheet";
    /** How Date values are written. Tables use real date serials, plain tabs use ISO strings. */
    readonly dateFormat: DateFormat;
    /** Locate or create the storage, make sure all columns exist, return the header (column order). */
    init(columns: ColumnSpec[], opts: {
        migrate: boolean;
    }): Promise<string[]>;
    /** All data rows (header and footer excluded). May include blank rows. */
    read(): Promise<RawRow[]>;
    append(rows: Cell[][]): Promise<void>;
    update(rows: {
        rowNum: number;
        values: Cell[];
    }[]): Promise<void>;
    remove(rowNums: number[]): Promise<void>;
}

type FieldType = "string" | "number" | "boolean" | "date" | "json";
interface FieldDef {
    type: FieldType;
    required?: boolean;
    unique?: boolean;
    /** A value, or a function returning one. Applied on create when the field is undefined. */
    default?: unknown;
    /** string fields only. Validated on write; becomes a dropdown column in Table mode. */
    enum?: readonly string[];
    /**
     * date fields only. Filled in by the library:
     * "create": set to now when the row is created.
     * "update": set to now when the row is created and on every update.
     * Nothing is added to your sheet unless you declare such a field.
     */
    auto?: "create" | "update";
}
type Schema = Record<string, FieldType | FieldDef>;
type TypeName<F> = F extends FieldType ? F : F extends {
    type: infer T;
} ? T : never;
type EnumOf<F> = F extends {
    enum: readonly (infer E)[];
} ? E : never;
type Base<T> = T extends "string" ? string : T extends "number" ? number : T extends "boolean" ? boolean : T extends "date" ? Date : unknown;
type ValueOf<F> = ([EnumOf<F>] extends [never] ? Base<TypeName<F>> : EnumOf<F>) | (F extends {
    required: true;
} ? never : F extends {
    auto: "create" | "update";
} ? never : null);
type SystemFields = {
    id: string;
};
type Row<S extends Schema> = SystemFields & {
    -readonly [K in keyof S]: ValueOf<S[K]>;
};
type RequiredKeys<S extends Schema> = {
    [K in keyof S]: S[K] extends {
        required: true;
    } ? (S[K] extends {
        default: unknown;
    } ? never : K) : never;
}[keyof S];
type CreateInput<S extends Schema> = {
    id?: string;
} & {
    [K in RequiredKeys<S>]: ValueOf<S[K]>;
} & {
    [K in Exclude<keyof S, RequiredKeys<S>>]?: ValueOf<S[K]>;
};
type UpdateInput<S extends Schema> = {
    -readonly [K in keyof S]?: ValueOf<S[K]>;
};
type InferRow<M> = M extends {
    readonly __schema?: infer S extends Schema;
} ? Row<S> : never;
type Operator<T> = {
    eq?: T;
    ne?: T;
    gt?: T;
    gte?: T;
    lt?: T;
    lte?: T;
    in?: readonly T[];
    notIn?: readonly T[];
    contains?: string;
    startsWith?: string;
    endsWith?: string;
};
type Where<R> = {
    [K in keyof R]?: R[K] | Operator<NonNullable<R[K]>>;
} | ((row: R) => boolean);
type OrderBy<R> = {
    field: keyof R & string;
    dir?: "asc" | "desc";
};
interface FindOptions<R> {
    where?: Where<R>;
    /** Skip the read cache for this call. */
    fresh?: boolean;
    orderBy?: OrderBy<R> | OrderBy<R>[];
    limit?: number;
    offset?: number;
}
interface ModelOptions {
    /** Spreadsheet for this model. Defaults to the GSheetDB's spreadsheetId. */
    spreadsheetId?: string;
    /**
     * Where the data lives.
     * - "auto"  (default): a Sheets Table named `table` if it exists, else a tab named `sheet`,
     *                      else a new tab + Table is created.
     * - "table": Tables only. Never falls back to a plain tab that already holds data.
     * - "sheet": plain tab only (header in row 1).
     */
    source?: "auto" | "table" | "sheet";
    /** Table name. Defaults to the model name. */
    table?: string;
    /** Tab name. Defaults to the model name. */
    sheet?: string;
    /** Create the tab / table when missing. Default true. */
    create?: boolean;
    /** Add schema columns that are missing from the header. Default true. */
    migrate?: boolean;
    /**
     * Name of the column that holds the row id (the `id` property). Default "id".
     * Point it at a column you already have, for example "TransId", and no extra id column is added.
     * Do not also declare that column as a field in the schema.
     */
    idColumn?: string;
    /**
     * Assign an id to rows added by hand in Sheets (they have none), so they can be found by id.
     * Default true with the default "id" column, false when you set `idColumn` (your own ids are not overwritten).
     */
    healIds?: boolean;
    /** In-memory read cache. Writes always read fresh and invalidate it. */
    cache?: {
        ttlMs: number;
    } | false;
    /** Custom storage driver (mainly for tests, see "gsheet-orm/testing"). */
    driver?: Driver;
}

export type { CreateInput as C, Driver as D, FindOptions as F, InferRow as I, ModelOptions as M, OrderBy as O, Row as R, Schema as S, UpdateInput as U, Where as W, DateFormat as a, ColumnSpec as b, RawRow as c, Cell as d, FieldDef as e, FieldType as f, Operator as g, SystemFields as h };
