import { beforeEach, describe, expect, it } from "vitest";
import { GSheetDB } from "../src/index.js";
import { MemoryDriver } from "../src/testing.js";

class SpyDriver extends MemoryDriver {
  reads = 0;
  override async read() {
    this.reads++;
    return super.read();
  }
}

const schema = {
  ref: { type: "string", required: true },
  date: { type: "date", required: true },
} as const;

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

let drv: { old: SpyDriver; y24: SpyDriver; y25: SpyDriver };
let db: GSheetDB;

function build(extra: object = {}) {
  drv = { old: new SpyDriver(), y24: new SpyDriver(), y25: new SpyDriver() };
  db = new GSheetDB({
    shards: [
      { spreadsheetId: "ss-old", years: [2022, 2023], label: "2022-23", driver: drv.old },
      { spreadsheetId: "ss-24", years: [2024, 2024], label: "2024", driver: drv.y24 },
      { spreadsheetId: "ss-25", years: [2025, null], label: "2025+", driver: drv.y25 },
    ],
  });
  return db.model("orders", schema, { partitionBy: "date", ...extra });
}

const reads = () => [drv.old.reads, drv.y24.reads, drv.y25.reads];
const reset = () => Object.values(drv).forEach((d) => (d.reads = 0));

async function seed(Orders: ReturnType<typeof build>) {
  // 3 rows in 2022-23, 4 in 2024, 5 in 2025+  (12 in total)
  const rows = [
    ...[1, 2, 3].map((n) => ({ ref: `o${n}`, date: iso(2022 + (n % 2), n, 10) })),
    ...[1, 2, 3, 4].map((n) => ({ ref: `p${n}`, date: iso(2024, n * 2, 5) })),
    ...[1, 2, 3, 4, 5].map((n) => ({ ref: `q${n}`, date: iso(2025, n, 15) })),
  ];
  await Orders.createMany(rows);
  reset();
}

let Orders: ReturnType<typeof build>;
beforeEach(async () => {
  Orders = build();
  await seed(Orders);
});

describe("findPage: newest first, lazy across spreadsheets", () => {
  it("reads only the newest spreadsheet for the first page", async () => {
    const page = await Orders.findPage({ pageSize: 3 });
    expect(page.rows.map((r) => r.ref)).toEqual(["q5", "q4", "q3"]);
    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBeTruthy();
    expect(page.readShards).toEqual(["2025+"]);
    expect(reads()).toEqual([0, 0, 1]); // 2024 and 2022-23 untouched
  });

  it("moves to the next spreadsheet only when the current one is used up (and fills the page)", async () => {
    const p1 = await Orders.findPage({ pageSize: 3 });
    reset();
    const p2 = await Orders.findPage({ pageSize: 3, cursor: p1.cursor });
    expect(p2.rows.map((r) => r.ref)).toEqual(["q2", "q1", "p4"]); // 2 left in 2025+, then 1 from 2024
    expect(p2.readShards).toEqual(["2025+", "2024"]);
    expect(reads()).toEqual([0, 1, 1]);
    expect(drv.old.reads).toBe(0); // oldest still untouched
  });

  it("walks every row exactly once, in descending date order", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let calls = 0;
    do {
      const page: Awaited<ReturnType<typeof Orders.findPage>> = await Orders.findPage({ pageSize: 5, cursor });
      seen.push(...page.rows.map((r) => r.ref));
      cursor = page.cursor;
      calls++;
    } while (cursor);
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    expect(calls).toBe(3); // 5 + 5 + 2
    const all = await Orders.findMany({ orderBy: { field: "date", dir: "desc" } });
    expect(seen).toEqual(all.map((r) => r.ref));
  });

  it("the last page has no cursor", async () => {
    const page = await Orders.findPage({ pageSize: 50 });
    expect(page.rows).toHaveLength(12);
    expect(page.cursor).toBeNull();
    expect(page.hasMore).toBe(false);
    expect(page.readShards).toEqual(["2025+", "2024", "2022-23"]);
  });

  it("fill: false returns the short page and defers the next spreadsheet", async () => {
    const p1 = await Orders.findPage({ pageSize: 4, fill: false }); // 4 of the 5 in 2025+
    const p2 = await Orders.findPage({ pageSize: 4, fill: false, cursor: p1.cursor }); // only 1 left
    expect(p2.rows.map((r) => r.ref)).toEqual(["q1"]);
    expect(p2.readShards).toEqual(["2025+"]);
    expect(p2.cursor).toBeTruthy(); // points at 2024
    reset();
    const p3 = await Orders.findPage({ pageSize: 4, fill: false, cursor: p2.cursor });
    expect(p3.rows.map((r) => r.ref)).toEqual(["p4", "p3", "p2", "p1"]);
    expect(reads()).toEqual([0, 1, 0]);
  });

  it("a page that ends exactly at a spreadsheet boundary does not read the next one yet", async () => {
    const page = await Orders.findPage({ pageSize: 5 }); // exactly the 5 rows of 2025+
    expect(page.rows).toHaveLength(5);
    expect(page.readShards).toEqual(["2025+"]);
    expect(reads()).toEqual([0, 0, 1]);
    expect(page.cursor).toBeTruthy();
    expect(page.hasMore).toBe(true);
  });

  it("order: asc starts from the oldest spreadsheet", async () => {
    const page = await Orders.findPage({ pageSize: 2, order: "asc" });
    expect(page.readShards).toEqual(["2022-23"]);
    expect(page.rows.map((r) => r.date.getTime())).toEqual(
      [...page.rows.map((r) => r.date.getTime())].sort((a, b) => a - b),
    );
    expect(reads()).toEqual([1, 0, 0]);
  });

  it("only considers spreadsheets that can match the where", async () => {
    const page = await Orders.findPage({ pageSize: 50, where: { date: { gte: iso(2024, 1, 1) } } });
    expect(page.rows).toHaveLength(9);
    expect(page.readShards).toEqual(["2025+", "2024"]);
    expect(drv.old.reads).toBe(0);
  });

  it("applies where filters inside each spreadsheet", async () => {
    const page = await Orders.findPage({ pageSize: 3, where: { ref: { startsWith: "p" } } });
    expect(page.rows.map((r) => r.ref)).toEqual(["p4", "p3", "p2"]);
    expect(page.readShards).toEqual(["2025+", "2024"]); // 2025+ has none, so it moved on
  });

  it("keeps a stable position when rows are added between pages", async () => {
    const p1 = await Orders.findPage({ pageSize: 3 });
    await Orders.create({ ref: "NEW", date: iso(2025, 12, 31) }); // newer than everything
    const p2 = await Orders.findPage({ pageSize: 3, cursor: p1.cursor });
    expect(p2.rows.map((r) => r.ref)).toEqual(["q2", "q1", "p4"]); // no duplicate, no gap
  });

  it("rows with the same date are ordered by id and never repeated", async () => {
    const T = build();
    await T.createMany([1, 2, 3, 4, 5, 6].map((n) => ({ ref: `s${n}`, date: iso(2025, 6, 1) })));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof T.findPage>> = await T.findPage({ pageSize: 2, cursor });
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.cursor;
    } while (cursor);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it("rejects bad input", async () => {
    await expect(Orders.findPage({ pageSize: 0 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(Orders.findPage({ cursor: "garbage" })).rejects.toMatchObject({ code: "VALIDATION" });
    const p = await Orders.findPage({ pageSize: 2 });
    await expect(Orders.findPage({ cursor: p.cursor, order: "asc" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      Orders.findPage({ cursor: p.cursor, where: { date: { lt: iso(2024, 1, 1) } } }),
    ).rejects.toMatchObject({ code: "VALIDATION" }); // the cursor's spreadsheet is not part of this query
  });
});

describe("pages() and findLatest()", () => {
  it("pages() is lazy: breaking early never reads older spreadsheets", async () => {
    for await (const rows of Orders.pages({ pageSize: 2 })) {
      expect(rows.map((r) => r.ref)).toEqual(["q5", "q4"]);
      break;
    }
    expect(reads()).toEqual([0, 0, 1]);
  });

  it("pages() yields everything when consumed fully", async () => {
    let total = 0;
    for await (const rows of Orders.pages({ pageSize: 4 })) total += rows.length;
    expect(total).toBe(12);
  });

  it("findLatest returns the newest rows from as few spreadsheets as needed", async () => {
    expect((await Orders.findLatest(3)).map((r) => r.ref)).toEqual(["q5", "q4", "q3"]);
    expect(reads()).toEqual([0, 0, 1]);
    reset();
    expect((await Orders.findLatest(7)).map((r) => r.ref)).toEqual(["q5", "q4", "q3", "q2", "q1", "p4", "p3"]);
    expect(reads()).toEqual([0, 1, 1]);
  });
});

describe("paging with the model cache", () => {
  it("reads each spreadsheet once while paging through it", async () => {
    const C = build({ cache: { ttlMs: 60_000 } });
    await seed(C);
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof C.findPage>> = await C.findPage({ pageSize: 2, cursor });
      cursor = page.cursor;
    } while (cursor);
    expect(reads()).toEqual([1, 1, 1]); // 6 pages, 3 reads
  });
});
