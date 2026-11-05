import { describe, expect, it } from "vitest";
import { matches, sortRows } from "../src/query.js";

const rows = [
  { id: "1", name: "Filter Oil", stock: 5, at: new Date("2026-01-01"), tag: null as string | null },
  { id: "2", name: "Belt", stock: 0, at: new Date("2026-02-01"), tag: "x" },
  { id: "3", name: "Hose", stock: 12, at: new Date("2026-03-01"), tag: "y" },
];

describe("matches", () => {
  it("handles equality, null and predicates", () => {
    expect(rows.filter((r) => matches(r, { stock: 0 })).map((r) => r.id)).toEqual(["2"]);
    expect(rows.filter((r) => matches(r, { tag: null })).map((r) => r.id)).toEqual(["1"]);
    expect(rows.filter((r) => matches(r, (r) => r.stock > 4)).length).toBe(2);
  });

  it("handles operators", () => {
    const ids = (w: any) => rows.filter((r) => matches(r, w)).map((r) => r.id);
    expect(ids({ stock: { gt: 0, lt: 12 } })).toEqual(["1"]);
    expect(ids({ stock: { gte: 5 } })).toEqual(["1", "3"]);
    expect(ids({ name: { contains: "oil" } })).toEqual(["1"]);
    expect(ids({ name: { startsWith: "h" } })).toEqual(["3"]);
    expect(ids({ name: { endsWith: "elt" } })).toEqual(["2"]);
    expect(ids({ id: { in: ["1", "3"] } })).toEqual(["1", "3"]);
    expect(ids({ id: { notIn: ["1", "3"] } })).toEqual(["2"]);
    expect(ids({ stock: { ne: 0 } })).toEqual(["1", "3"]);
  });

  it("compares dates", () => {
    const ids = rows.filter((r) => matches(r, { at: { gte: new Date("2026-02-01") } })).map((r) => r.id);
    expect(ids).toEqual(["2", "3"]);
  });

  it("does not match null against range operators", () => {
    expect(matches({ n: null as number | null }, { n: { lt: 5 } })).toBe(false);
  });
});

describe("sortRows", () => {
  it("sorts asc/desc with nulls last and supports multiple keys", () => {
    expect(sortRows(rows, { field: "stock", dir: "desc" }).map((r) => r.id)).toEqual(["3", "1", "2"]);
    expect(sortRows(rows, { field: "tag" }).map((r) => r.id)).toEqual(["2", "3", "1"]);
    expect(
      sortRows(rows, [{ field: "tag" }, { field: "stock", dir: "desc" }]).map((r) => r.id),
    ).toEqual(["2", "3", "1"]);
  });
});
