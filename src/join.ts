import { GSheetError } from "./errors.js";
import { matches, norm } from "./query.js";
import type { OrderBy, Where } from "./types.js";

/** Anything with findMany: a Model, a ShardedModel, or your own wrapper. */
export interface Queryable<R> {
  findMany(opts?: {
    where?: Where<R>;
    orderBy?: OrderBy<R> | OrderBy<R>[];
  }): Promise<R[]>;
}

export type JoinType = "left" | "inner";

export interface JoinOptions<
  L,
  R,
  As extends string,
  Many extends boolean,
  T extends JoinType,
> {
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

export type Joined<
  L,
  R,
  As extends string,
  Many extends boolean,
  T extends JoinType,
> = L & {
  [K in As]: Many extends true ? R[] : T extends "inner" ? R : R | null;
};

/**
 * Hash join between any two models, including models on different spreadsheets.
 * Reads the left side first, then only the right rows whose key appears on the left.
 */
export async function join<
  L extends object,
  R extends object,
  As extends string,
  Many extends boolean = false,
  T extends JoinType = "left",
>(
  left: Queryable<L>,
  right: Queryable<R>,
  opts: JoinOptions<L, R, As, Many, T>,
): Promise<Joined<L, R, As, Many, T>[]> {
  const [lk, rk] = opts.on;
  const type: JoinType = opts.type ?? "left";
  const leftRows = await left.findMany({
    where: opts.where,
    orderBy: opts.orderBy,
  });

  if (leftRows.length && opts.as in leftRows[0]!) {
    throw new GSheetError(
      "VALIDATION",
      `join: "${opts.as}" collides with a field of the left model`,
    );
  }

  const keys = [
    ...new Set(
      leftRows.map((r) => norm((r as any)[lk])).filter((k) => k != null),
    ),
  ];
  const groups = new Map<unknown, R[]>();

  if (keys.length) {
    const keySet = new Set<unknown>(keys);
    // plain `in` keeps shard pruning possible when the right side is partitioned on this field
    const where = (
      opts.rightWhere
        ? (row: R) =>
            keySet.has(norm((row as any)[rk])) && matches(row, opts.rightWhere)
        : ({ [rk]: { in: keys } } as unknown as Where<R>)
    ) as Where<R>;
    for (const r of await right.findMany({ where })) {
      const k = norm((r as any)[rk]);
      if (k == null) continue;
      const list = groups.get(k);
      list ? list.push(r) : groups.set(k, [r]);
    }
  }

  const out: any[] = [];
  for (const l of leftRows) {
    const lkVal = norm((l as any)[lk]);
    const found = lkVal == null ? [] : (groups.get(lkVal) ?? []);
    if (opts.many) {
      if (!found.length && type === "inner") continue;
      out.push({ ...l, [opts.as]: [...found] });
    } else {
      const first = found[0] ?? null;
      if (!first && type === "inner") continue;
      out.push({ ...l, [opts.as]: first });
    }
  }

  const start = opts.offset ?? 0;
  return out.slice(start, opts.limit != null ? start + opts.limit : undefined);
}
