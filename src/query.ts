import type { OrderBy, Where } from "./types.js";

const OP_KEYS = new Set([
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
  "endsWith",
]);

export const isOperator = (v: unknown): v is Record<string, any> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  Object.keys(v).length > 0 &&
  Object.keys(v).every((k) => OP_KEYS.has(k));

export const norm = (v: unknown): unknown =>
  v instanceof Date ? v.getTime() : v;

const comparable = (a: unknown, b: unknown): boolean =>
  a != null && b != null && typeof a === typeof b;

const str = (v: unknown) => String(v ?? "").toLowerCase();

export function matches<R extends object>(row: R, where?: Where<R>): boolean {
  if (!where) return true;
  if (typeof where === "function") return where(row);

  for (const [key, cond] of Object.entries(where)) {
    const val = norm((row as Record<string, unknown>)[key]) as any;

    if (!isOperator(cond)) {
      if (val !== norm(cond)) return false;
      continue;
    }

    if ("eq" in cond && val !== norm(cond.eq)) return false;
    if ("ne" in cond && val === norm(cond.ne)) return false;
    if (
      "gt" in cond &&
      !(comparable(val, norm(cond.gt)) && val > (norm(cond.gt) as any))
    )
      return false;
    if (
      "gte" in cond &&
      !(comparable(val, norm(cond.gte)) && val >= (norm(cond.gte) as any))
    )
      return false;
    if (
      "lt" in cond &&
      !(comparable(val, norm(cond.lt)) && val < (norm(cond.lt) as any))
    )
      return false;
    if (
      "lte" in cond &&
      !(comparable(val, norm(cond.lte)) && val <= (norm(cond.lte) as any))
    )
      return false;
    if (cond.in && !(cond.in as unknown[]).map(norm).includes(val))
      return false;
    if (cond.notIn && (cond.notIn as unknown[]).map(norm).includes(val))
      return false;
    if (cond.contains !== undefined && !str(val).includes(str(cond.contains)))
      return false;
    if (
      cond.startsWith !== undefined &&
      !str(val).startsWith(str(cond.startsWith))
    )
      return false;
    if (cond.endsWith !== undefined && !str(val).endsWith(str(cond.endsWith)))
      return false;
  }
  return true;
}

export function sortRows<R extends object>(
  rows: R[],
  orderBy?: OrderBy<R> | OrderBy<R>[],
): R[] {
  if (!orderBy) return rows;
  const keys = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const { field, dir = "asc" } of keys) {
      const m = dir === "asc" ? 1 : -1;
      const x = norm((a as any)[field]) as any;
      const y = norm((b as any)[field]) as any;
      if (x == null && y == null) continue;
      if (x == null) return 1; // nulls last
      if (y == null) return -1;
      if (x > y) return m;
      if (x < y) return -m;
    }
    return 0;
  });
}

/** Turns a Date / ISO string / number into a sortable number. null when it cannot be read. */
export function toKey(v: unknown, type: "date" | "number"): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n =
    v instanceof Date
      ? v.getTime()
      : type === "date"
        ? new Date(v as string | number).getTime()
        : Number(v);
  return Number.isNaN(n) ? null : n;
}
