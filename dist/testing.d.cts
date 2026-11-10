import { D as Driver, a as DateFormat, b as ColumnSpec, c as RawRow, d as Cell } from './types-BfjImFSN.cjs';

/**
 * In-memory driver for unit-testing code that uses gsheet-orm without touching Google.
 *
 *   const User = db.model("users", schema, { driver: new MemoryDriver() });
 */
declare class MemoryDriver implements Driver {
    readonly kind: "table" | "sheet";
    readonly dateFormat: DateFormat;
    header: string[];
    rows: unknown[][];
    constructor(opts?: {
        kind?: "table" | "sheet";
        header?: string[];
        rows?: unknown[][];
    });
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

export { MemoryDriver };
