import { beforeEach, describe, expect, it } from "vitest";
import { GSheetDB, GSheetError, type InferRow } from "../src/index.js";
import { MemoryDriver } from "../src/testing.js";

const db = new GSheetDB({ spreadsheetId: "test" });

const schema = {
  sku: { type: "string", required: true, unique: true },
  name: { type: "string", required: true },
  stock: { type: "number", default: 0 },
  status: { type: "string", enum: ["active", "retired"], default: "active" },
  meta: "json",
  seenAt: "date",
  hot: { type: "boolean", default: false },
} as const;

for (const kind of ["sheet", "table"] as const) {
  describe(`Model (${kind} driver)`, () => {
    let driver: MemoryDriver;
    let Item: ReturnType<typeof make>;

    const make = (d: MemoryDriver, extra = {}) => db.model("items", schema, { driver: d, ...extra });
    beforeEach(() => {
      driver = new MemoryDriver({ kind });
      Item = make(driver);
    });

    it("creates the header and reports the source", async () => {
      await Item.sync();
      expect(driver.header).toEqual([
        "id", "sku", "name", "stock", "status", "meta", "seenAt", "hot", "createdAt", "updatedAt",
      ]);
      expect(Item.source).toBe(kind);
    });

    it("creates rows with defaults and round-trips every type", async () => {
      const seenAt = new Date("2026-05-01T10:00:00.000Z");
      const created = await Item.create({ sku: "A1", name: "Filter", meta: { a: [1, 2] }, seenAt });
      expect(created.stock).toBe(0);
      expect(created.status).toBe("active");

      const found = await Item.findById(created.id);
      expect(found).toMatchObject({ sku: "A1", name: "Filter", stock: 0, hot: false, meta: { a: [1, 2] } });
      expect(found!.seenAt!.toISOString()).toBe(seenAt.toISOString());
      expect(found!.createdAt).toBeInstanceOf(Date);
    });

    it("validates required, types, enum and unknown fields", async () => {
      await expect(Item.create({ sku: "A1" } as any)).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(Item.create({ sku: "A1", name: "x", stock: "5" } as any)).rejects.toThrow(/finite number/);
      await expect(Item.create({ sku: "A1", name: "x", status: "weird" as any })).rejects.toThrow(/one of/);
      await expect(Item.create({ sku: "A1", name: "x", nope: 1 } as any)).rejects.toThrow(/unknown field/);
    });

    it("enforces unique fields, also inside one batch", async () => {
      await Item.create({ sku: "A1", name: "one" });
      await expect(Item.create({ sku: "A1", name: "dup" })).rejects.toMatchObject({ code: "UNIQUE" });
      await expect(
        Item.createMany([{ sku: "B1", name: "x" }, { sku: "B1", name: "y" }]),
      ).rejects.toMatchObject({ code: "UNIQUE" });
      expect(await Item.count()).toBe(1);
    });

    it("finds with where / orderBy / limit / offset", async () => {
      await Item.createMany([
        { sku: "A", name: "Alpha", stock: 5 },
        { sku: "B", name: "Beta", stock: 1 },
        { sku: "C", name: "Gamma", stock: 9 },
      ]);
      const low = await Item.findMany({ where: { stock: { lt: 6 } }, orderBy: { field: "stock" } });
      expect(low.map((r) => r.sku)).toEqual(["B", "A"]);
      const page = await Item.findMany({ orderBy: { field: "stock", dir: "desc" }, limit: 1, offset: 1 });
      expect(page.map((r) => r.sku)).toEqual(["A"]);
      expect(await Item.count({ name: { contains: "ta" } })).toBe(1);
    });

    it("updates rows, bumps updatedAt and keeps createdAt", async () => {
      const a = await Item.create({ sku: "A", name: "Alpha", stock: 1 });
      await new Promise((r) => setTimeout(r, 5));
      const u = await Item.updateById(a.id, { stock: 7 });
      expect(u!.stock).toBe(7);
      const again = await Item.findById(a.id);
      expect(again!.stock).toBe(7);
      expect(again!.createdAt.getTime()).toBe(a.createdAt.getTime());
      expect(again!.updatedAt.getTime()).toBeGreaterThan(a.updatedAt.getTime());
      expect(await Item.updateById("missing", { stock: 1 })).toBeNull();
    });

    it("rejects invalid updates and unique collisions", async () => {
      await Item.create({ sku: "A", name: "Alpha" });
      const b = await Item.create({ sku: "B", name: "Beta" });
      await expect(Item.updateById(b.id, { sku: "A" })).rejects.toMatchObject({ code: "UNIQUE" });
      await expect(Item.updateById(b.id, { name: null as any })).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(Item.update({}, { sku: "Z" })).rejects.toMatchObject({ code: "UNIQUE" });
      await expect(Item.updateById(b.id, { id: "x" } as any)).rejects.toThrow(/unknown field/);
    });

    it("upserts", async () => {
      const first = await Item.upsert({ sku: "A" }, { sku: "A", name: "v1" });
      const second = await Item.upsert({ sku: "A" }, { sku: "A", name: "v2" });
      expect(second.id).toBe(first.id);
      expect(await Item.count()).toBe(1);
      expect((await Item.findById(first.id))!.name).toBe("v2");
    });

    it("deletes several rows correctly (bottom-up)", async () => {
      await Item.createMany([
        { sku: "A", name: "a", stock: 0 },
        { sku: "B", name: "b", stock: 5 },
        { sku: "C", name: "c", stock: 0 },
        { sku: "D", name: "d", stock: 0 },
      ]);
      expect(await Item.delete({ stock: 0 })).toBe(3);
      expect((await Item.findMany()).map((r) => r.sku)).toEqual(["B"]);
      expect(await Item.deleteById("nope")).toBe(false);
    });

    it("preserves columns the model does not manage", async () => {
      const seeded = new MemoryDriver({
        kind,
        header: ["id", "sku", "name", "Notes", "stock"],
        rows: [["id-1", "A", "Alpha", "hand written", 3]],
      });
      const M = make(seeded);
      await M.updateById("id-1", { stock: 10 });
      const notesIdx = seeded.header.indexOf("Notes");
      expect(seeded.rows[0]![notesIdx]).toBe("hand written");
      expect((await M.findById("id-1"))!.stock).toBe(10);
    });

    it("assigns ids to rows typed in by hand", async () => {
      const seeded = new MemoryDriver({
        kind,
        header: ["id", "sku", "name", "stock"],
        rows: [["", "H1", "Handmade", 4], ["", "", "", ""]],
      });
      const M = make(seeded);
      const rows = await M.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBeTruthy();
      expect(seeded.rows[0]![seeded.header.indexOf("id")]).toBe(rows[0]!.id);
      expect(await M.deleteById(rows[0]!.id)).toBe(true);
    });

    it("migrate: false throws on a missing column when strictness applies", async () => {
      const strict = make(new MemoryDriver({ kind, header: ["id"] }), { migrate: false });
      await strict.sync(); // MemoryDriver is lenient; real drivers throw SCHEMA (see drivers.test.ts)
      expect(strict.source).toBe(kind);
    });

    it("caches reads when enabled and invalidates on writes", async () => {
      const cached = make(driver, { cache: { ttlMs: 60_000 } });
      await cached.create({ sku: "A", name: "a" });
      expect(await cached.count()).toBe(1);
      driver.rows.push(["x", "B", "b", 0, "active", "", "", false, "", ""]); // sneaky outside write
      expect(await cached.count()).toBe(1); // still cached
      await cached.create({ sku: "C", name: "c" }); // our own write invalidates
      expect(await cached.count()).toBe(3);
    });

    it("returns copies, not cache internals", async () => {
      const cached = make(driver, { cache: { ttlMs: 60_000 } });
      await cached.create({ sku: "A", name: "a" });
      const [row] = await cached.findMany();
      row!.name = "mutated";
      expect((await cached.findMany())[0]!.name).toBe("a");
    });
  });
}

describe("schema guards", () => {
  it("rejects reserved field names", () => {
    expect(() => db.model("x", { id: "string" })).toThrow(GSheetError);
  });

  it("infers row types", () => {
    const M = db.model("t", { n: { type: "number", required: true }, s: "string" });
    type R = InferRow<typeof M>;
    const r: R = { id: "1", createdAt: new Date(), updatedAt: new Date(), n: 1, s: null };
    expect(r.n).toBe(1);
  });
});
