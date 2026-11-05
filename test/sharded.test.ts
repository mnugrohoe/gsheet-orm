import { beforeEach, describe, expect, it } from "vitest";
import { GSheetDB, GSheetError, join } from "../src/index.js";
import { MemoryDriver } from "../src/testing.js";

class SpyDriver extends MemoryDriver {
  reads = 0;
  override async read() {
    this.reads++;
    return super.read();
  }
}

const db = new GSheetDB({ spreadsheetId: "default" });
const d = (iso: string) => new Date(iso);

const orderSchema = {
  orderNo: { type: "string", required: true, unique: true },
  customerId: "string",
  date: { type: "date", required: true },
  total: { type: "number", default: 0 },
} as const;

let drivers: Record<"a" | "b" | "c", SpyDriver>;
let Orders: ReturnType<typeof makeOrders>;

function makeOrders() {
  return db.sharded("orders", orderSchema, {
    partitionBy: "date",
    shards: [
      { spreadsheetId: "ss-2024", years: [2024, 2024], label: "2024", driver: drivers.b },
      { spreadsheetId: "ss-2025", years: [2025, null], label: "2025+", driver: drivers.c },
      { spreadsheetId: "ss-old", years: [2022, 2023], label: "2022-23", driver: drivers.a },
    ],
  });
}

const resetReads = () => Object.values(drivers).forEach((x) => (x.reads = 0));
const readsPerShard = () => [drivers.a.reads, drivers.b.reads, drivers.c.reads];

beforeEach(() => {
  drivers = { a: new SpyDriver(), b: new SpyDriver(), c: new SpyDriver() };
  Orders = makeOrders();
});

describe("ShardedModel: routing writes", () => {
  it("writes each row to the spreadsheet that owns its date", async () => {
    await Orders.createMany([
      { orderNo: "O1", date: d("2022-06-01") },
      { orderNo: "O2", date: d("2024-02-01") },
      { orderNo: "O3", date: d("2026-01-15") },
      { orderNo: "O4", date: d("2023-12-31T23:59:59Z") },
    ]);
    expect(drivers.a.rows).toHaveLength(2); // 2022-23
    expect(drivers.b.rows).toHaveLength(1); // 2024
    expect(drivers.c.rows).toHaveLength(1); // 2025+ (open ended)
  });

  it("keeps the input order in createMany's result", async () => {
    const rows = await Orders.createMany([
      { orderNo: "O1", date: d("2025-01-01") },
      { orderNo: "O2", date: d("2022-01-01") },
      { orderNo: "O3", date: d("2024-01-01") },
    ]);
    expect(rows.map((r) => r.orderNo)).toEqual(["O1", "O2", "O3"]);
  });

  it("uses year boundaries in UTC, start inclusive and end exclusive", async () => {
    await Orders.createMany([
      { orderNo: "A", date: d("2024-01-01T00:00:00Z") },
      { orderNo: "B", date: d("2023-12-31T23:59:59.999Z") },
    ]);
    expect(drivers.b.rows).toHaveLength(1);
    expect(drivers.a.rows).toHaveLength(1);
  });

  it("accepts ISO strings for the partition value", async () => {
    await Orders.create({ orderNo: "S", date: "2024-05-05T00:00:00Z" as any });
    expect(drivers.b.rows).toHaveLength(1);
  });

  it("throws SHARD when no spreadsheet covers the value", async () => {
    await expect(Orders.create({ orderNo: "X", date: d("2019-01-01") })).rejects.toMatchObject({ code: "SHARD" });
  });

  it("rejects a missing partition value", async () => {
    await expect(Orders.create({ orderNo: "X" } as any)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("ShardedModel: reading", () => {
  beforeEach(async () => {
    await Orders.createMany([
      { orderNo: "O1", date: d("2022-03-01"), total: 10, customerId: "c1" },
      { orderNo: "O2", date: d("2023-09-01"), total: 30, customerId: "c2" },
      { orderNo: "O3", date: d("2024-01-20"), total: 20, customerId: "c1" },
      { orderNo: "O4", date: d("2024-11-20"), total: 5, customerId: "c3" },
      { orderNo: "O5", date: d("2025-04-01"), total: 40, customerId: "c2" },
    ]);
    resetReads();
  });

  it("only reads the spreadsheets a date filter can match", async () => {
    await Orders.findMany({ where: { date: { gte: d("2024-03-01"), lt: d("2025-01-01") } } });
    expect(readsPerShard()).toEqual([0, 1, 0]);

    resetReads();
    await Orders.findMany({ where: { date: d("2022-03-01") } }); // equality
    expect(readsPerShard()).toEqual([1, 0, 0]);

    resetReads();
    await Orders.findMany({ where: { date: { gte: d("2024-06-01") } } });
    expect(readsPerShard()).toEqual([0, 1, 1]);

    resetReads();
    await Orders.findMany({ where: { date: { lt: d("2024-01-01") } } }); // exclusive end hits the boundary
    expect(readsPerShard()).toEqual([1, 0, 0]);

    resetReads();
    await Orders.findMany({ where: { date: { in: [d("2022-01-01"), d("2025-01-01")] } } });
    expect(readsPerShard()).toEqual([1, 0, 1]);
  });

  it("reads everything when the filter is not on the partition field or is a function", async () => {
    await Orders.findMany({ where: { customerId: "c1" } });
    expect(readsPerShard()).toEqual([1, 1, 1]);
    resetReads();
    await Orders.findMany({ where: (r) => (r.total ?? 0) > 1 });
    expect(readsPerShard()).toEqual([1, 1, 1]);
  });

  it("reports the plan with shardsFor()", () => {
    expect(Orders.shardsFor({ date: { gte: d("2025-02-01") } }).map((s) => s.label)).toEqual(["2025+"]);
    expect(Orders.shardsFor().map((s) => s.label)).toEqual(["2022-23", "2024", "2025+"]);
  });

  it("merges, sorts, offsets and limits across spreadsheets as a whole", async () => {
    const top = await Orders.findMany({ orderBy: { field: "total", dir: "desc" }, limit: 3 });
    expect(top.map((r) => r.orderNo)).toEqual(["O5", "O2", "O3"]);
    const page = await Orders.findMany({ orderBy: { field: "total" }, offset: 1, limit: 2 });
    expect(page.map((r) => r.orderNo)).toEqual(["O1", "O3"]);
  });

  it("returns rows in range order when no orderBy is given", async () => {
    expect((await Orders.findMany()).map((r) => r.orderNo)).toEqual(["O1", "O2", "O3", "O4", "O5"]);
  });

  it("counts and finds first across spreadsheets", async () => {
    expect(await Orders.count()).toBe(5);
    expect(await Orders.count({ customerId: "c2" })).toBe(2);
    expect((await Orders.findFirst({ customerId: "c3" }))!.orderNo).toBe("O4");
    expect(await Orders.findFirst({ customerId: "zzz" })).toBeNull();
  });

  it("findById scans newest to oldest, a hint reads one spreadsheet", async () => {
    const o2 = (await Orders.findFirst({ orderNo: "O2" }))!;
    resetReads();
    expect((await Orders.findById(o2.id))!.orderNo).toBe("O2");
    expect(readsPerShard()).toEqual([1, 1, 1]); // newest first: 2025+, 2024, then 2022-23

    resetReads();
    expect((await Orders.findById(o2.id, d("2023-09-01")))!.orderNo).toBe("O2");
    expect(readsPerShard()).toEqual([1, 0, 0]);

    expect(await Orders.findById("nope")).toBeNull();
  });
});

describe("ShardedModel: update, move, upsert, delete", () => {
  it("updates rows in place across spreadsheets", async () => {
    await Orders.createMany([
      { orderNo: "O1", date: d("2022-03-01"), customerId: "c1" },
      { orderNo: "O2", date: d("2025-03-01"), customerId: "c1" },
    ]);
    const updated = await Orders.update({ customerId: "c1" }, { total: 99 });
    expect(updated).toHaveLength(2);
    expect((await Orders.findMany({ where: { total: 99 } })).length).toBe(2);
  });

  it("moves a row to another spreadsheet when its partition value changes", async () => {
    const o = await Orders.create({ orderNo: "M1", date: d("2022-03-01"), total: 7 });
    const moved = await Orders.updateById(o.id, { date: d("2025-07-01") });
    expect(moved!.id).toBe(o.id);
    expect(drivers.a.rows).toHaveLength(0);
    expect(drivers.c.rows).toHaveLength(1);
    const found = (await Orders.findById(o.id))!;
    expect(found.total).toBe(7);
    expect(found.createdAt.getTime()).toBe(o.createdAt.getTime()); // history kept
    expect(found.updatedAt.getTime()).toBeGreaterThanOrEqual(o.updatedAt.getTime());
  });

  it("does not delete the source row when the move target rejects it", async () => {
    await Orders.create({ orderNo: "DUP", date: d("2025-01-01") });
    const o = await Orders.create({ orderNo: "DUP2", date: d("2022-01-01") });
    // clash on the unique orderNo in the target spreadsheet
    await expect(Orders.updateById(o.id, { orderNo: "DUP", date: d("2025-02-01") })).rejects.toMatchObject({ code: "UNIQUE" });
    expect(drivers.a.rows).toHaveLength(1);
  });

  it("refuses to move a row to a date no spreadsheet covers", async () => {
    const o = await Orders.create({ orderNo: "N1", date: d("2024-01-01") });
    await expect(Orders.updateById(o.id, { date: d("2010-01-01") })).rejects.toMatchObject({ code: "SHARD" });
    expect(drivers.b.rows).toHaveLength(1);
  });

  it("upserts into the right spreadsheet", async () => {
    const a = await Orders.upsert({ orderNo: "U1" }, { orderNo: "U1", date: d("2024-04-04"), total: 1 });
    const b = await Orders.upsert({ orderNo: "U1" }, { orderNo: "U1", date: d("2024-04-04"), total: 2 });
    expect(b.id).toBe(a.id);
    expect(await Orders.count()).toBe(1);
    expect((await Orders.findById(a.id))!.total).toBe(2);
  });

  it("deletes across spreadsheets and by id", async () => {
    const rows = await Orders.createMany([
      { orderNo: "D1", date: d("2022-01-01"), total: 0 },
      { orderNo: "D2", date: d("2024-01-01"), total: 0 },
      { orderNo: "D3", date: d("2025-01-01"), total: 5 },
    ]);
    expect(await Orders.delete({ total: 0 })).toBe(2);
    expect(await Orders.deleteById(rows[2]!.id)).toBe(true);
    expect(await Orders.deleteById("nope")).toBe(false);
    expect(await Orders.count()).toBe(0);
  });
});

describe("ShardedModel: configuration", () => {
  const s = (over: object) => ({ spreadsheetId: "x", driver: new MemoryDriver(), ...over });

  it("rejects overlapping ranges and empty ranges", () => {
    const mk = (shards: any[]) => db.sharded("o", orderSchema, { partitionBy: "date", shards });
    expect(() => mk([s({ years: [2022, 2024] }), s({ years: [2024, 2025] })])).toThrow(/overlap/);
    expect(() => mk([s({ years: [2022, null] }), s({ years: [2025, 2026] })])).toThrow(/overlap/);
    expect(() => mk([s({ from: 5, to: 5 })])).toThrow(GSheetError);
  });

  it("requires a date or number partition field", () => {
    expect(() => db.sharded("o", orderSchema, { partitionBy: "customerId", shards: [s({})] })).toThrow(/date.*number/);
    expect(() => db.sharded("o", orderSchema, { partitionBy: "nope", shards: [s({})] })).toThrow(GSheetError);
  });

  it("supports numeric partitions with from / to", async () => {
    const M = db.sharded("n", { n: { type: "number", required: true } } as const, {
      partitionBy: "n",
      shards: [
        s({ to: 100, driver: new SpyDriver() }),
        s({ from: 100, driver: new SpyDriver() }),
      ],
    });
    await M.createMany([{ n: 5 }, { n: 100 }, { n: 250 }]);
    expect(M.shardsFor({ n: { gte: 100 } })).toHaveLength(1);
    expect(await M.count()).toBe(3);
  });

  it("connects every spreadsheet and reports each source", async () => {
    await Orders.sync();
    expect(Orders.sources.map((x) => x.label)).toEqual(["2022-23", "2024", "2025+"]);
    expect(Orders.sources.every((x) => x.source === "sheet")).toBe(true);
  });
});

describe("GSheetDB with several spreadsheets", () => {
  it("shares one Google client between spreadsheets", () => {
    const x = new GSheetDB({});
    expect(x.apiFor("a")).toBe(x.apiFor("a"));
    expect(x.apiFor("a")).not.toBe(x.apiFor("b"));
    expect(() => x.api).toThrow(/default spreadsheetId/);
  });
});

describe("join", () => {
  const customerSchema = { name: { type: "string", required: true }, tier: "string" } as const;
  let Customers: ReturnType<typeof makeCustomers>;
  const makeCustomers = () => db.model("customers", customerSchema, { driver: new MemoryDriver({ kind: "table" }) });

  beforeEach(async () => {
    Customers = makeCustomers();
    const cs = await Customers.createMany([
      { id: "c1", name: "Acme", tier: "gold" },
      { id: "c2", name: "Borneo", tier: "basic" },
    ]);
    expect(cs).toHaveLength(2);
    await Orders.createMany([
      { orderNo: "O1", date: d("2022-03-01"), customerId: "c1", total: 10 },
      { orderNo: "O2", date: d("2024-05-01"), customerId: "c2", total: 20 },
      { orderNo: "O3", date: d("2025-05-01"), customerId: "c1", total: 30 },
      { orderNo: "O4", date: d("2025-06-01"), customerId: "ghost", total: 40 },
      { orderNo: "O5", date: d("2025-07-01"), total: 50 }, // no customer
    ]);
  });

  it("left-joins sharded orders to a customers model on another spreadsheet", async () => {
    const rows = await Orders.join(Customers, { on: ["customerId", "id"], as: "customer", orderBy: { field: "orderNo" } });
    expect(rows.map((r) => [r.orderNo, r.customer?.name ?? null])).toEqual([
      ["O1", "Acme"], ["O2", "Borneo"], ["O3", "Acme"], ["O4", null], ["O5", null],
    ]);
  });

  it("inner join drops unmatched rows", async () => {
    const rows = await Orders.join(Customers, { on: ["customerId", "id"], as: "customer", type: "inner" });
    expect(rows.map((r) => r.orderNo)).toEqual(["O1", "O2", "O3"]);
    expect(rows[0]!.customer.name).toBe("Acme"); // typed as non-null for inner joins
  });

  it("one-to-many from the other side with many: true", async () => {
    const rows = await Customers.join(Orders, { on: ["id", "customerId"], as: "orders", many: true });
    const acme = rows.find((r) => r.name === "Acme")!;
    expect(acme.orders.map((o) => o.orderNo).sort()).toEqual(["O1", "O3"]);
  });

  it("filters both sides and paginates the result", async () => {
    const rows = await Orders.join(Customers, {
      on: ["customerId", "id"],
      as: "customer",
      type: "inner",
      where: { total: { gte: 10 } },
      rightWhere: { tier: "gold" },
      orderBy: { field: "orderNo" },
      limit: 1,
      offset: 1,
    });
    expect(rows.map((r) => r.orderNo)).toEqual(["O3"]);
  });

  it("prunes shards of the right side when joining on the partition field", async () => {
    const i1 = new SpyDriver();
    const i2 = new SpyDriver();
    const Invoices = db.sharded("invoices", { orderDate: { type: "date", required: true }, ref: "string" } as const, {
      partitionBy: "orderDate",
      shards: [
        { spreadsheetId: "i1", years: [2022, 2024], driver: i1 },
        { spreadsheetId: "i2", years: [2025, null], driver: i2 },
      ],
    });
    await Invoices.createMany([{ orderDate: d("2022-03-01"), ref: "INV-1" }]);
    i1.reads = 0;
    i2.reads = 0;

    const rows = await Orders.join(Invoices, { on: ["date", "orderDate"], as: "invoice", where: { orderNo: "O1" } });

    expect(rows[0]!.invoice!.ref).toBe("INV-1");
    expect(i1.reads).toBeGreaterThan(0);
    expect(i2.reads).toBe(0); // 2025+ spreadsheet never touched
  });

  it("rejects an `as` that collides with a left field", async () => {
    await expect(Orders.join(Customers, { on: ["customerId", "id"], as: "total" as any })).rejects.toThrow(/collides/);
  });

  it("works through the standalone join() with plain models", async () => {
    const rows = await join(Customers, Customers, { on: ["id", "id"], as: "self" });
    expect(rows[0]!.self!.id).toBe(rows[0]!.id);
  });
});

describe("Model.importMany", () => {
  it("keeps ids and timestamps", async () => {
    const M = db.model("m", { v: "number" }, { driver: new MemoryDriver() });
    const created = new Date("2020-01-01T00:00:00Z");
    const [row] = await M.importMany([{ id: "keep", v: 1, createdAt: created, updatedAt: created }]);
    expect(row!.id).toBe("keep");
    expect((await M.findById("keep"))!.createdAt.toISOString()).toBe(created.toISOString());
  });
});

describe("ShardedModel.importMany", () => {
  it("routes rows and keeps ids and timestamps", async () => {
    const created = new Date("2021-01-01T00:00:00Z");
    const rows = await Orders.importMany([
      { id: "x1", orderNo: "I1", date: d("2024-02-02"), createdAt: created, updatedAt: created },
      { id: "x2", orderNo: "I2", date: d("2022-02-02"), createdAt: created, updatedAt: created },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["x1", "x2"]);
    expect(drivers.b.rows).toHaveLength(1);
    expect(drivers.a.rows).toHaveLength(1);
    expect((await Orders.findById("x1", d("2024-02-02")))!.createdAt.toISOString()).toBe(created.toISOString());
  });
});
