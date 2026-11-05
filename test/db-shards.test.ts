import { describe, expect, it } from "vitest";
import { GSheetDB, ShardedModel, Model } from "../src/index.js";
import { MemoryDriver } from "../src/testing.js";

const orderSchema = {
  orderNo: { type: "string", required: true },
  date: { type: "date", required: true },
} as const;

const make = () => {
  const drivers = { a: new MemoryDriver(), b: new MemoryDriver(), master: new MemoryDriver() };
  const db = new GSheetDB({
    spreadsheetId: "master", // default for models that are not partitioned
    shards: [
      { spreadsheetId: "ss-2024", years: [2024, 2024], driver: drivers.a },
      { spreadsheetId: "ss-2025", years: [2025, null], driver: drivers.b },
    ],
  });
  return { db, drivers };
};

describe("db-level shards", () => {
  it("db.model with partitionBy is routed over the db shards", async () => {
    const { db, drivers } = make();
    const Orders = db.model("orders", orderSchema, { partitionBy: "date" });
    expect(Orders).toBeInstanceOf(ShardedModel);

    await Orders.createMany([
      { orderNo: "A", date: new Date("2024-05-01") },
      { orderNo: "B", date: new Date("2025-05-01") },
    ]);
    expect(drivers.a.rows).toHaveLength(1);
    expect(drivers.b.rows).toHaveLength(1);
    expect(Orders.shardsFor({ date: { gte: new Date("2025-01-01") } })).toHaveLength(1);
    expect(await Orders.count()).toBe(2);
  });

  it("db.model without partitionBy stays a plain model on the default spreadsheet", () => {
    const { db } = make();
    const Customers = db.model("customers", { name: "string" }, { driver: new MemoryDriver() });
    expect(Customers).toBeInstanceOf(Model);
  });

  it("both kinds share the same API and join together", async () => {
    const { db } = make();
    const Orders = db.model("orders", { ...orderSchema, customerId: "string" } as const, { partitionBy: "date" });
    const Customers = db.model("customers", { name: "string" } as const, { driver: new MemoryDriver() });
    await Customers.create({ id: "c1", name: "Acme" });
    await Orders.create({ orderNo: "A", date: new Date("2025-01-10"), customerId: "c1" });
    const rows = await Orders.join(Customers, { on: ["customerId", "id"], as: "customer" });
    expect(rows[0]!.customer!.name).toBe("Acme");
  });

  it("a model can bring its own shards", async () => {
    const { db } = make();
    const own = new MemoryDriver();
    const Logs = db.model("logs", { n: { type: "number", required: true } } as const, {
      partitionBy: "n",
      shards: [{ spreadsheetId: "only", from: 0, driver: own }],
    });
    await Logs.create({ n: 5 });
    expect(own.rows).toHaveLength(1);
  });

  it("explains misuse with CONFIG errors", () => {
    const plain = new GSheetDB({ spreadsheetId: "x" });
    expect(() => plain.model("o", orderSchema, { partitionBy: "date" })).toThrow(/needs shards/);
    const { db } = make();
    expect(() => db.model("o", orderSchema, { partitionBy: "date", spreadsheetId: "x" } as any)).toThrow(/cannot be combined/);
  });

  it("db.sharded still works with its own shard list", async () => {
    const d = new MemoryDriver();
    const db = new GSheetDB();
    const M = db.sharded("o", orderSchema, { partitionBy: "date", shards: [{ spreadsheetId: "z", from: 0, driver: d }] });
    await M.create({ orderNo: "1", date: new Date("2024-01-01") });
    expect(d.rows).toHaveLength(1);
  });
});
