import type { FieldType } from "./types.js";
import type { Cell, DateFormat } from "./drivers/driver.js";

/** Google Sheets serial dates count days since 1899-12-30. We read/write them as UTC. */
const EPOCH_OFFSET_DAYS = 25569; // days between 1899-12-30 and 1970-01-01
const MS_PER_DAY = 86_400_000;

export const dateToSerial = (d: Date): number =>
  d.getTime() / MS_PER_DAY + EPOCH_OFFSET_DAYS;
export const serialToDate = (n: number): Date =>
  new Date(Math.round((n - EPOCH_OFFSET_DAYS) * MS_PER_DAY));

export function serialize(
  value: unknown,
  type: FieldType,
  dateFormat: DateFormat,
): Cell {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "string":
      return String(value);
    case "number":
      return Number(value);
    case "boolean":
      return Boolean(value);
    case "date": {
      const d = value instanceof Date ? value : new Date(value as string);
      return dateFormat === "serial" ? dateToSerial(d) : d.toISOString();
    }
    case "json":
      return JSON.stringify(value);
  }
}

export function deserialize(raw: unknown, type: FieldType): unknown {
  if (raw === undefined || raw === null || raw === "") return null;
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
      const d =
        typeof raw === "number" ? serialToDate(raw) : new Date(String(raw));
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
