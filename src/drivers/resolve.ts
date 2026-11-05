import type { SheetsApiLike } from "../client.js";
import { GSheetError } from "../errors.js";
import type { Driver } from "./driver.js";
import { SheetDriver } from "./sheet.js";
import { TableDriver } from "./table.js";

export interface ResolveSpec {
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
export async function resolveDriver(api: SheetsApiLike, spec: ResolveSpec): Promise<Driver> {
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

  if (spec.source === "sheet" || (spec.source === "auto" && tab)) {
    return new SheetDriver(api, { tabName, existing: Boolean(tab), create: spec.create });
  }

  // source "table", or "auto" with nothing found: Tables are preferred
  if (!spec.create) {
    throw new GSheetError("SCHEMA", `Table "${tableName}" not found and create is disabled`);
  }
  return new TableDriver(api, { tableName, tabName, existing: false });
}
