/**
 * Runs the examples from docs/API.md against the in-memory driver,
 * so the documentation cannot drift away from the real behaviour.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { GSheetDB, GSheetError, join, type InferRow } from "../src/index.js";
import { MemoryDriver } from "../src/testing.js";

const db = new GSheetDB();

const schema = {
  sku: { type: "string", required: true, unique: true },
  name: { type: "string", required: true },
  stock: { type: "number", default: 0 },
  status: { type: "string", enum: ["active", "retired"], default: "active" },
  meta: "json",
  seenAt: "date",
  createdAt: { type: "date", auto: "create" },
  updatedAt: { type: "date", auto: "update" },
} as const;

let Item: ReturnType<typeof makeItem>;
const makeItem = (extra = {}) => db.model("items", schema, { driver: new MemoryDriver(), ...extra });
beforeEach(() => {
  Item = makeItem();
});

describe("docs: writing", () => {
  it("create returns the row with defaults and system fields", async () => {
    const item = await Item.create({ sku: "A-001", name: "Oil filter", stock: 12 });
    expect(item).toMatchObject({ sku: "A-001", stock: 12, status: "active", meta: null, seenAt: null });
    expect(item.id).toBeTruthy();
    expect(item.createdAt).toBeInstanceOf(Date);
    const withMeta = await Item.create({ sku: "A-002", name: "Belt", meta: { supplier: "PT X", tags: ["fan"] } });
    expect((await Item.findById(withMeta.id))!.meta).toEqual({ supplier: "PT X", tags: ["fan"] });
    expect((await Item.create({ id: "my-own-id", sku: "A-003", name: "Hose" })).id).toBe("my-own-id");
  });

  it("createMany validates everything first: one bad row inserts nothing", async () => {
    await expect(
      Item.createMany([{ sku: "B-1", name: "ok" }, { sku: "B-2" } as any]),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await Item.count()).toBe(0);
    expect(await Item.createMany([])).toEqual([]);
    const rows = await Item.createMany([{ sku: "B-1", name: "Gasket" }, { sku: "B-2", name: "Bearing" }]);
    expect(rows.map((r) => r.sku)).toEqual(["B-1", "B-2"]);
  });

  it("update returns changed rows, ignores undefined, can clear a field", async () => {
    await Item.createMany([
      { sku: "A", name: "a", stock: 0 },
      { sku: "B", name: "b", stock: 0 },
      { sku: "C", name: "c", stock: 5 },
    ]);
    const changed = await Item.update({ status: "active", stock: 0 }, { status: "retired" });
    expect(changed.length).toBe(2);
    await Item.update({ sku: "C" }, { stock: 8, meta: { note: "recount" } });
    expect((await Item.findFirst({ sku: "C" }))!.stock).toBe(8);
    await Item.update({ sku: "C" }, { seenAt: new Date() });
    await Item.update({ sku: "C" }, { seenAt: null });
    expect((await Item.findFirst({ sku: "C" }))!.seenAt).toBeNull();
    await Item.update({ sku: "C" }, { name: undefined });
    expect((await Item.findFirst({ sku: "C" }))!.name).toBe("c");
    await expect(Item.update({ sku: "C" }, { name: null as any })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await Item.update({ sku: "zzz" }, { stock: 1 })).toEqual([]);
  });

  it("updateById / upsert / delete / deleteById / importMany", async () => {
    const item = await Item.create({ sku: "A-001", name: "Oil filter" });
    expect((await Item.updateById(item.id, { stock: 20 }))!.stock).toBe(20);
    expect(await Item.updateById("nope", { stock: 1 })).toBeNull();

    const up = await Item.upsert({ sku: "A-001" }, { sku: "A-001", name: "Oil filter", stock: 3 });
    expect(up.id).toBe(item.id);
    expect(up.stock).toBe(3);

    await Item.create({ sku: "R-1", name: "old", status: "retired" });
    expect(await Item.delete({ status: "retired" })).toBe(1);
    expect(await Item.deleteById(item.id)).toBe(true);
    expect(await Item.deleteById(item.id)).toBe(false);
    expect(await Item.delete((r) => (r.stock ?? 0) < 0)).toBe(0);

    await Item.importMany([{ id: "legacy-1", sku: "OLD-1", name: "Old part", createdAt: new Date("2020-05-01") }]);
    expect((await Item.findById("legacy-1"))!.createdAt.toISOString()).toBe("2020-05-01T00:00:00.000Z");
  });

  it("errors are GSheetError with a code", async () => {
    await Item.create({ sku: "A-001", name: "x" });
    let code = "";
    try {
      await Item.create({ sku: "A-001", name: "Duplicate" });
    } catch (err) {
      if (err instanceof GSheetError) code = err.code;
    }
    expect(code).toBe("UNIQUE");
    await expect(Item.create({ sku: "Z", name: "z", status: "weird" as any })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("docs: reading", () => {
  beforeEach(async () => {
    await Item.createMany([
      { sku: "A-1", name: "Oil Filter", stock: 3, seenAt: new Date("2026-03-01") },
      { sku: "A-2", name: "Belt", stock: 0 },
      { sku: "A-3", name: "Hose", stock: 9, status: "retired" },
      { sku: "A-4", name: "Fan filter", stock: 12 },
    ]);
  });

  it("where: equality, null, operators, dates, predicate", async () => {
    expect((await Item.findMany({ where: { status: "active" } })).length).toBe(3);
    expect((await Item.findMany({ where: { seenAt: null } })).length).toBe(3);
    expect((await Item.findMany({ where: { stock: { gte: 1, lte: 10 } } })).map((r) => r.sku)).toEqual(["A-1", "A-3"]);
    expect((await Item.findMany({ where: { name: { contains: "filter" } } })).length).toBe(2);
    expect((await Item.findMany({ where: { sku: { in: ["A-1", "A-2"] } } })).length).toBe(2);
    expect((await Item.findMany({ where: { seenAt: { gte: new Date("2026-01-01") } } })).length).toBe(1);
    expect((await Item.findMany({ where: (r) => r.stock === 0 || r.status === "retired" })).length).toBe(2);
    expect((await Item.findMany({ where: {} })).length).toBe(4);
  });

  it("findMany with orderBy, limit, offset and multiple sort keys", async () => {
    const low = await Item.findMany({
      where: { stock: { lt: 10 }, status: "active" },
      orderBy: { field: "stock" },
      limit: 20,
      offset: 0,
    });
    expect(low.map((r) => r.sku)).toEqual(["A-2", "A-1"]);
    const multi = await Item.findMany({ orderBy: [{ field: "status" }, { field: "stock", dir: "desc" }] });
    expect(multi.map((r) => r.sku)).toEqual(["A-4", "A-1", "A-2", "A-3"]);
  });

  it("findFirst, findById, count", async () => {
    const item = await Item.findFirst({ sku: "A-1" });
    expect(item!.name).toBe("Oil Filter");
    expect((await Item.findById(item!.id))!.sku).toBe("A-1");
    expect(await Item.count({ stock: { lt: 5 } })).toBe(2);
    expect(await Item.count()).toBe(4);
  });

  it("pagination recipe", async () => {
    const pageSize = 3;
    const page = 2;
    const [rows, total] = await Promise.all([
      Item.findMany({ orderBy: { field: "name" }, limit: pageSize, offset: (page - 1) * pageSize }),
      Item.count(),
    ]);
    expect(rows).toHaveLength(1);
    expect(Math.ceil(total / pageSize)).toBe(2);
  });

  it("cache example", async () => {
    const driver = new MemoryDriver();
    const Cached = db.model("items", schema, { driver, cache: { ttlMs: 5000 } });
    await Cached.create({ sku: "X", name: "x" });
    expect(await Cached.count()).toBe(1);
    driver.rows.push(["z", "Z", "z", 0, "active", "", "", "", ""]);
    expect(await Cached.count()).toBe(1); // cached
    expect((await Cached.findMany({ fresh: true })).length).toBe(2); // bypass
  });
});

describe("docs: types", () => {
  it("InferRow matches the documented shape", () => {
    type ItemRow = InferRow<typeof Item>;
    const row: ItemRow = {
      id: "1", createdAt: new Date(), updatedAt: new Date(),
      sku: "a", name: "b", stock: null, status: "retired", meta: { any: 1 }, seenAt: null,
    };
    // @ts-expect-error "weird" is not in the enum
    const bad: ItemRow = { ...row, status: "weird" };
    expect(row.status).toBe("retired");
    expect(bad).toBeTruthy();
  });
});

describe("docs: sharding, joins and recipes", () => {
  const orderSchema = {
    orderNo: { type: "string", required: true, unique: true },
    customerId: "string",
    date: { type: "date", required: true },
    total: { type: "number", default: 0 },
    createdAt: { type: "date", auto: "create" },
    updatedAt: { type: "date", auto: "update" },
  } as const;
  const customerSchema = { name: { type: "string", required: true }, tier: "string" } as const;

  let Orders: ReturnType<typeof makeOrders>;
  let Customer: ReturnType<typeof makeCustomer>;
  const makeOrders = () => {
    const shardedDb = new GSheetDB({
      spreadsheetId: "master",
      shards: [
        { spreadsheetId: "ss-a", years: [2022, 2023], label: "2022-23", driver: new MemoryDriver() },
        { spreadsheetId: "ss-b", years: [2024, 2024], label: "2024", driver: new MemoryDriver({ kind: "table" }) },
        { spreadsheetId: "ss-c", years: [2025, null], label: "2025+", driver: new MemoryDriver() },
      ],
    });
    return shardedDb.model("orders", orderSchema, { partitionBy: "date" });
  };
  const makeCustomer = () => db.model("customers", customerSchema, { driver: new MemoryDriver() });

  beforeEach(async () => {
    Orders = makeOrders();
    Customer = makeCustomer();
    await Customer.createMany([
      { id: "c1", name: "Acme", tier: "gold" },
      { id: "c2", name: "Borneo", tier: "basic" },
    ]);
    await Orders.createMany([
      { orderNo: "SO-1", date: new Date("2022-05-01"), customerId: "c1", total: 10 },
      { orderNo: "SO-2", date: new Date("2024-03-01"), customerId: "c2", total: 100 },
      { orderNo: "SO-3", date: new Date("2025-02-01"), customerId: "c1", total: 30 },
      { orderNo: "SO-4", date: new Date("2025-03-01"), customerId: "nobody", total: 5 },
    ]);
  });

  it("sharding: routing, inspection, hint, move", async () => {
    expect(Orders.shardsFor({ date: { gte: new Date("2025-02-01") } })).toEqual([{ spreadsheetId: "ss-c", label: "2025+" }]);
    expect((await Orders.findMany({ where: { date: { gte: new Date("2025-01-01") } } })).length).toBe(2);
    expect((await Orders.findMany({ orderBy: { field: "total", dir: "desc" }, limit: 2 })).map((r) => r.orderNo)).toEqual(["SO-2", "SO-3"]);

    const so2 = (await Orders.findFirst({ orderNo: "SO-2" }))!;
    expect((await Orders.findById(so2.id, new Date("2024-06-01")))!.orderNo).toBe("SO-2");
    await Orders.updateById(so2.id, { date: new Date("2025-02-01") });
    expect((await Orders.findById(so2.id, new Date("2025-06-01")))!.orderNo).toBe("SO-2");

    await Orders.sync();
    expect(Orders.sources).toEqual([
      { label: "2022-23", source: "sheet" },
      { label: "2024", source: "table" },
      { label: "2025+", source: "sheet" },
    ]);
  });

  it("numeric ranges", async () => {
    const Logs = db.sharded("logs", { seq: { type: "number", required: true } }, {
      partitionBy: "seq",
      shards: [
        { spreadsheetId: "a", to: 100000, driver: new MemoryDriver() },
        { spreadsheetId: "b", from: 100000, driver: new MemoryDriver() },
      ],
    });
    await Logs.createMany([{ seq: 5 }, { seq: 100000 }]);
    expect(Logs.shardsFor({ seq: { gte: 100000 } })).toHaveLength(1);
  });

  it("joins: left, inner, many, rightWhere, standalone", async () => {
    const rows = await Orders.join(Customer, {
      on: ["customerId", "id"],
      as: "customer",
      where: { date: { gte: new Date("2025-01-01") } },
      orderBy: { field: "date", dir: "desc" },
      limit: 50,
    });
    expect(rows.map((r) => [r.orderNo, r.customer?.name ?? null])).toEqual([["SO-4", null], ["SO-3", "Acme"]]);

    const matched = await Orders.join(Customer, { on: ["customerId", "id"], as: "customer", type: "inner" });
    expect(matched.length).toBe(3);
    expect(matched[0]!.customer.name).toBe("Acme");

    const withOrders = await Customer.join(Orders, { on: ["id", "customerId"], as: "orders", many: true });
    expect(withOrders.find((c) => c.name === "Acme")!.orders.length).toBe(2);

    const gold = await Orders.join(Customer, { on: ["customerId", "id"], as: "customer", type: "inner", rightWhere: { tier: "gold" } });
    expect(gold.map((r) => r.orderNo)).toEqual(["SO-1", "SO-3"]);

    expect((await join(Orders, Customer, { on: ["customerId", "id"], as: "customer" })).length).toBe(4);
  });

  it("recipe: split an existing table over the shards", async () => {
    const Old = db.model("orders", orderSchema, { driver: new MemoryDriver() });
    await Old.importMany([
      { id: "o1", orderNo: "X1", date: new Date("2022-01-01"), createdAt: new Date("2022-01-02") },
      { id: "o2", orderNo: "X2", date: new Date("2025-01-01") },
    ]);
    const Fresh = makeOrders();
    const rows = await Old.findMany();
    await Fresh.importMany(rows);
    expect(await Fresh.count()).toBe(2);
    expect((await Fresh.findById("o1"))!.createdAt.toISOString()).toBe("2022-01-02T00:00:00.000Z");
  });

  it("recipe: soft delete", async () => {
    const Doc = db.model("docs", {
      title: "string",
      status: { type: "string", enum: ["active", "archived"], default: "active" },
    }, { driver: new MemoryDriver() });
    const doc = await Doc.create({ title: "a" });
    await Doc.updateById(doc.id, { status: "archived" });
    expect(await Doc.findMany({ where: { status: "active" } })).toEqual([]);
  });
});
