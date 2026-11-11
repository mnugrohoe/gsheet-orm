import { describe, expect, it } from "vitest";
import { GSheetDB, GSheetError } from "../src/index.js";
import { MemoryDriver } from "../src/testing.js";

const db = new GSheetDB();

describe("no hidden columns", () => {
  it("adds only id and the declared fields: no createdAt / updatedAt", async () => {
    const driver = new MemoryDriver();
    const M = db.model("t", { name: "string", amount: "number" }, { driver });
    const row = await M.create({ name: "a", amount: 1 });
    expect(driver.header).toEqual(["id", "name", "amount"]);
    expect(Object.keys(row).sort()).toEqual(["amount", "id", "name"]);
  });

  it("auto fields are opt-in: create sets both, update only refreshes the 'update' one", async () => {
    const M = db.model("t", {
      name: "string",
      createdAt: { type: "date", auto: "create" },
      updatedAt: { type: "date", auto: "update" },
    }, { driver: new MemoryDriver() });
    const a = await M.create({ name: "a" });
    expect(a.createdAt).toBeInstanceOf(Date);
    expect(a.updatedAt).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 5));
    const u = (await M.updateById(a.id, { name: "b" }))!;
    expect(u.createdAt.getTime()).toBe(a.createdAt.getTime());
    expect(u.updatedAt.getTime()).toBeGreaterThan(a.updatedAt.getTime());

    // an explicit value wins (back-filling)
    const old = new Date("2020-01-01T00:00:00Z");
    const b = await M.create({ name: "old", createdAt: old, updatedAt: old });
    expect(b.createdAt.toISOString()).toBe(old.toISOString());
    const p = (await M.updateById(b.id, { updatedAt: old }))!;
    expect(p.updatedAt.toISOString()).toBe(old.toISOString());
  });

  it("rejects auto on a non-date field", () => {
    expect(() => db.model("t", { n: { type: "number", auto: "create" } as any })).toThrow(GSheetError);
  });

  it("a timestamp you did not declare is an unknown field", async () => {
    const M = db.model("t", { name: "string" }, { driver: new MemoryDriver() });
    await expect(M.create({ name: "a", createdAt: new Date() } as any)).rejects.toThrow(/unknown field/);
  });
});

describe("idColumn: use a column you already have", () => {
  const seeded = () =>
    new MemoryDriver({
      header: ["TransId", "Name", "Note"],
      rows: [["T-1", "Alpha", "keep me"], ["T-2", "Beta", ""], ["", "Handmade", ""]],
    });

  it("reads and writes the id property from that column and adds no id column", async () => {
    const driver = seeded();
    const M = db.model("t", { Name: "string" }, { driver, idColumn: "TransId" });
    const rows = await M.findMany();
    expect(rows.map((r) => r.id)).toEqual(["T-1", "T-2", null]);
    expect(driver.header).toEqual(["TransId", "Name", "Note"]); // nothing added

    const created = await M.create({ id: "T-3", Name: "Gamma" });
    expect(created.id).toBe("T-3");
    expect(driver.rows.at(-1)).toEqual(["T-3", "Gamma", null]); // the Note column stays empty
    expect((await M.findById("T-3"))!.Name).toBe("Gamma");
  });

  it("does not overwrite blank ids by default, and leaves other columns alone", async () => {
    const driver = seeded();
    const M = db.model("t", { Name: "string" }, { driver, idColumn: "TransId" });
    await M.updateById("T-1", { Name: "Alpha 2" });
    expect(driver.rows[0]).toEqual(["T-1", "Alpha 2", "keep me"]);
    await M.findMany();
    expect(driver.rows[2]![0]).toBe(""); // hand-added row keeps its empty TransId
  });

  it("healIds: true gives blank ids a value", async () => {
    const driver = seeded();
    const M = db.model("t", { Name: "string" }, { driver, idColumn: "TransId", healIds: true });
    await M.findMany();
    expect(driver.rows[2]![0]).toBeTruthy();
  });

  it("a row without an id is still reachable with where, and upsert updates the right row", async () => {
    const driver = seeded();
    const M = db.model("t", { Name: "string" }, { driver, idColumn: "TransId" });
    await M.update({ Name: "Handmade" }, { Name: "Handmade 2" });
    expect(driver.rows[2]![1]).toBe("Handmade 2");
    expect(driver.rows[0]![1]).toBe("Alpha"); // other rows untouched
    await M.upsert({ Name: "Handmade 2" }, { Name: "Handmade 3" });
    expect(driver.rows[2]![1]).toBe("Handmade 3");
    expect(driver.rows[1]![1]).toBe("Beta");
  });

  it("updateById / deleteById refuse an empty id instead of matching id-less rows", async () => {
    const M = db.model("t", { Name: "string" }, { driver: seeded(), idColumn: "TransId" });
    await expect(M.updateById("", { Name: "x" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(M.deleteById(null as any)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("the id column cannot also be a schema field", () => {
    expect(() => db.model("t", { TransId: "string" }, { idColumn: "TransId" })).toThrow(/idColumn/);
  });

  it("works with sharded models and paging", async () => {
    const d1 = new MemoryDriver();
    const d2 = new MemoryDriver();
    const sdb = new GSheetDB({
      shards: [
        { spreadsheetId: "a", years: [2024, 2024], driver: d1 },
        { spreadsheetId: "b", years: [2025, null], driver: d2 },
      ],
    });
    const T = sdb.model("t", { Date: { type: "date", required: true }, Name: "string" }, { partitionBy: "Date", idColumn: "TransId" });
    await T.createMany([
      { id: "T-1", Date: new Date("2024-02-01"), Name: "a" },
      { id: "T-2", Date: new Date("2025-02-01"), Name: "b" },
    ]);
    expect(d1.header[0]).toBe("TransId");
    const page = await T.findPage({ pageSize: 5 });
    expect(page.rows.map((r) => r.id)).toEqual(["T-2", "T-1"]);
    await T.updateById("T-1", { Date: new Date("2025-06-01") }); // moves to the other spreadsheet
    expect(d1.rows).toHaveLength(0);
    expect(d2.rows).toHaveLength(2);
  });
});

describe("paging needs ids", () => {
  it("findPage explains itself instead of looping when the row it stops at has no id", async () => {
    const d = new MemoryDriver({
      header: ["TransId", "Date", "Name"],
      rows: [
        ["T-1", "2025-03-01T00:00:00.000Z", "a"],
        ["", "2025-02-01T00:00:00.000Z", "no id"],
        ["T-3", "2025-01-01T00:00:00.000Z", "c"],
      ],
    });
    const sdb = new GSheetDB({ shards: [{ spreadsheetId: "a", from: 0, driver: d }] });
    const T = sdb.model("t", { Date: { type: "date", required: true }, Name: "string" }, { partitionBy: "Date", idColumn: "TransId" });
    // page 1 ends on a row with an id, page 2 would end on the id-less row
    const p1 = await T.findPage({ pageSize: 1 });
    expect(p1.rows[0]!.id).toBe("T-1");
    await expect(T.findPage({ pageSize: 1, cursor: p1.cursor })).rejects.toMatchObject({ code: "VALIDATION" });
    // a page that reaches the end of the data never needs a cursor, so it still works
    expect((await T.findPage({ pageSize: 10 })).rows).toHaveLength(3);
  });
});
