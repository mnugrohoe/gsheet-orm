import { sheets as createSheets, auth as googleAuth, type sheets_v4 } from "@googleapis/sheets";
import { GSheetError } from "./errors.js";

export interface ClientOptions {
  /** Default spreadsheet. Optional when every model passes its own (or uses shards). */
  spreadsheetId?: string;
  /** Service-account credentials. Defaults to env GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY. */
  credentials?: { clientEmail: string; privateKey: string };
  /** Bring your own auth client (GoogleAuth, JWT, OAuth2Client...). Takes precedence over credentials. */
  auth?: unknown;
  /** Retry on 429 / 5xx with exponential backoff. Default { retries: 4, baseDelayMs: 500 }. */
  retry?: { retries?: number; baseDelayMs?: number } | false;
}

export interface TableRange {
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
}

export interface TableMeta {
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

export interface SheetMeta {
  sheetId: number;
  title: string;
  tables: TableMeta[];
  /** Size of the grid, when known. A sheet cannot hold data outside of it. */
  rowCount?: number;
  columnCount?: number;
}

/** The slice of the Sheets API this library uses. Implemented by SheetsApi; fakeable in tests. */
export interface SheetsApiLike {
  listSheets(): Promise<SheetMeta[]>;
  batchUpdate(requests: unknown[]): Promise<any>;
  getValues(range: string): Promise<unknown[][]>;
  updateValues(range: string, values: unknown[][]): Promise<void>;
  batchUpdateValues(data: { range: string; values: unknown[][] }[]): Promise<void>;
  appendValues(range: string, values: unknown[][]): Promise<void>;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

function statusOf(err: any): number | undefined {
  const s = err?.response?.status ?? err?.status ?? err?.code;
  return typeof s === "number" ? s : typeof s === "string" && /^\d+$/.test(s) ? Number(s) : undefined;
}

export type SheetsGetter = () => sheets_v4.Sheets;

/** Builds the Google client once and shares it, so many spreadsheets reuse one login. */
export function lazySheets(opts: Pick<ClientOptions, "credentials" | "auth">): SheetsGetter {
  let api: sheets_v4.Sheets | undefined;
  return () => {
    if (api) return api;
    let authClient = opts.auth;
    if (!authClient) {
      const email = opts.credentials?.clientEmail ?? process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      const key = (opts.credentials?.privateKey ?? process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
      if (!email || !key) {
        throw new GSheetError(
          "CONFIG",
          "Missing Google credentials. Pass `credentials`/`auth`, or set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY.",
        );
      }
      authClient = new googleAuth.JWT({
        email,
        key,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
    }
    api = createSheets({ version: "v4", auth: authClient as any });
    return api;
  };
}

const toGridRange = (r: any, sheetId: number): TableRange => ({
  sheetId,
  startRowIndex: r?.startRowIndex ?? 0,
  endRowIndex: r?.endRowIndex ?? 0,
  startColumnIndex: r?.startColumnIndex ?? 0,
  endColumnIndex: r?.endColumnIndex ?? 0,
});

export class SheetsApi implements SheetsApiLike {
  readonly spreadsheetId: string;
  private getSheets: SheetsGetter;
  private retries: number;
  private baseDelayMs: number;

  constructor(opts: ClientOptions & { spreadsheetId: string }, shared?: SheetsGetter) {
    this.spreadsheetId = opts.spreadsheetId;
    this.getSheets = shared ?? lazySheets(opts);
    const r = opts.retry === false ? { retries: 0 } : (opts.retry ?? {});
    this.retries = r.retries ?? 4;
    this.baseDelayMs = (r as any).baseDelayMs ?? 500;
  }

  private get api(): sheets_v4.Sheets {
    return this.getSheets();
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        if (err instanceof GSheetError) throw err; // e.g. CONFIG: never retry or re-wrap
        const status = statusOf(err);
        const network = ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(err?.code);
        if (attempt < this.retries && ((status && RETRYABLE.has(status)) || network)) {
          const delay = this.baseDelayMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
          await new Promise((res) => setTimeout(res, delay));
          continue;
        }
        const detail = err?.response?.data?.error?.message ?? err?.message ?? String(err);
        throw new GSheetError("API", `Google Sheets API error${status ? ` (${status})` : ""}: ${detail}`, { cause: err });
      }
    }
  }

  async listSheets(): Promise<SheetMeta[]> {
    const res = await this.call(() =>
      this.api.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),tables)",
      }),
    );
    return (res.data.sheets ?? []).map((s: any) => {
      const sheetId: number = s.properties?.sheetId ?? 0;
      const title: string = s.properties?.title ?? "";
      const rowCount: number | undefined = s.properties?.gridProperties?.rowCount ?? undefined;
      const columnCount: number | undefined = s.properties?.gridProperties?.columnCount ?? undefined;
      const tables: TableMeta[] = (s.tables ?? []).map((t: any) => ({
        tableId: t.tableId,
        name: t.name,
        sheetTitle: title,
        range: toGridRange(t.range, sheetId),
        columnProperties: t.columnProperties ?? [],
        hasFooter: Boolean(t.rowsProperties?.footerColorStyle),
        gridRows: rowCount,
        gridColumns: columnCount,
      }));
      return { sheetId, title, tables, rowCount, columnCount };
    });
  }

  async batchUpdate(requests: unknown[]): Promise<any> {
    const res = await this.call(() =>
      this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: requests as any[] },
      }),
    );
    return res.data;
  }

  async getValues(range: string): Promise<unknown[][]> {
    const res = await this.call(() =>
      this.api.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range,
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
    );
    return (res.data.values as unknown[][] | undefined) ?? [];
  }

  async updateValues(range: string, values: unknown[][]): Promise<void> {
    await this.call(() =>
      this.api.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: { values: values as any[][] },
      }),
    );
  }

  async batchUpdateValues(data: { range: string; values: unknown[][] }[]): Promise<void> {
    if (!data.length) return;
    await this.call(() =>
      this.api.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { valueInputOption: "RAW", data: data as any[] },
      }),
    );
  }

  async appendValues(range: string, values: unknown[][]): Promise<void> {
    await this.call(() =>
      this.api.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: values as any[][] },
      }),
    );
  }
}
