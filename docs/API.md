# API reference

Complete reference for `@mnugrohoe/gsheet-orm`. For a short introduction see the [README](../README.md).

- [Import](#import)
- [GSheetDB](#gsheetdb)
- [Schema](#schema)
- [Model options](#model-options)
- [Reading data](#reading-data) · [where](#where) · [orderBy, limit, offset](#orderby-limit-offset)
- [Writing data](#writing-data)
- [Sharding](#sharding-one-model-over-many-spreadsheets)
- [Joins](#joins)
- [Caching](#caching)
- [Errors](#errors)
- [Testing](#testing)
- [Advanced](#advanced)
- [Recipes](#recipes)

All examples use this model unless stated otherwise:

```ts
import { GSheetDB } from "@mnugrohoe/gsheet-orm";

const db = new GSheetDB({ spreadsheetId: process.env.SHEET_ID! });

const Item = db.model("items", {
  sku: { type: "string", required: true, unique: true },
  name: { type: "string", required: true },
  stock: { type: "number", default: 0 },
  status: { type: "string", enum: ["active", "retired"], default: "active" },
  meta: "json",
  seenAt: "date",
});
```

## Import

```ts
import {
  GSheetDB,        // entry point
  GSheetError,     // error class
  join,            // standalone join
  type InferRow,   // row type of a model
} from "@mnugrohoe/gsheet-orm";

import { MemoryDriver } from "@mnugrohoe/gsheet-orm/testing"; // for unit tests
```

Both ESM and CommonJS are supported. Node 18 or newer. Server-side only.

---

## GSheetDB

The entry point. It holds the Google login and creates models.

### `new GSheetDB(options?)`

| Option          | Type                                          | Default                                      | Description                                                                                  |
| --------------- | --------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `spreadsheetId` | `string`                                      | none                                         | Default spreadsheet. Optional if every model sets its own `spreadsheetId` or uses shards.    |
| `credentials`   | `{ clientEmail: string; privateKey: string }` | env `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` | Service account. A literal `\n` in the private key is converted to a newline.                |
| `auth`          | auth client                                   | none                                         | Your own `GoogleAuth`, `JWT` or `OAuth2Client`. Takes precedence over `credentials`.         |
| `retry`         | `{ retries?: number; baseDelayMs?: number }` or `false` | `{ retries: 4, baseDelayMs: 500 }` | Retries on HTTP 408, 429, 500, 502, 503, 504 and network resets, with exponential backoff. |
| `shards`        | `ShardDef[]`                                  | none                                         | Spreadsheets the database is split over, by range. Models opt in with `partitionBy`. See [Sharding](#sharding-one-model-over-many-spreadsheets). |
| `concurrency`   | `number`                                      | `4`                                          | Max spreadsheets a sharded model reads at the same time.                                     |

Credentials are only read on the first Google call, so constructing a `GSheetDB` never throws. A missing credential throws `GSheetError` with code `CONFIG` on first use.

```ts
// from environment variables
const db = new GSheetDB({ spreadsheetId: process.env.SHEET_ID! });

// explicit credentials
const db2 = new GSheetDB({
  spreadsheetId: "1AbC...",
  credentials: {
    clientEmail: "bot@my-project.iam.gserviceaccount.com",
    privateKey: process.env.MY_KEY!,
  },
});

// several spreadsheets, no default
const db3 = new GSheetDB();
```

### `db.model(name, schema, options?)`

Defines a model. `name` is also the default table and tab name. See [Schema](#schema) and [Model options](#model-options).

It is the same function for normal and sharded models, and the two have the same methods:

- **Without `partitionBy`:** the model lives in one spreadsheet, the default `spreadsheetId` or the one in its options. Returns a `Model`.
- **With `partitionBy`:** rows are split over the `shards` declared on `GSheetDB`, routed by that field. Returns a `ShardedModel`. See [Sharding](#sharding-one-model-over-many-spreadsheets).

```ts
const Customer = db.model("customers", { name: "string", tier: "string" });

// on another spreadsheet
const Archive = db.model("items", { sku: "string" }, { spreadsheetId: "1Other..." });

// split by year over the shards of the GSheetDB
const Orders = db.model("orders", { date: { type: "date", required: true } }, { partitionBy: "date" });
```

### `db.sharded(name, schema, options)`

Same as `db.model(name, schema, { partitionBy, shards })`, always using the `shards` you pass. Use it, or pass `shards` in the model options, when one model needs its own shard list. See [Sharding](#sharding-one-model-over-many-spreadsheets).

### `db.apiFor(spreadsheetId)` and `db.api`

Low-level handle for one spreadsheet (see [Advanced](#advanced)). All spreadsheets share one Google login. `db.api` is the handle for the default spreadsheet and throws `CONFIG` if there is none.

---

## Schema

A schema is an object of field name to field definition. Each field is either a type name or an object.

```ts
const schema = {
  name: "string",                                   // shorthand
  sku: { type: "string", required: true, unique: true },
  stock: { type: "number", default: 0 },
  status: { type: "string", enum: ["active", "retired"] as const, default: "active" },
  createdBy: { type: "string", default: () => "system" },
};
```

### Field types

| Type        | TypeScript value | Stored in a plain tab | Table column type |
| ----------- | ---------------- | --------------------- | ----------------- |
| `"string"`  | `string`         | text                  | `TEXT` (or `DROPDOWN` with `enum`) |
| `"number"`  | `number`         | number                | `DOUBLE`          |
| `"boolean"` | `boolean`        | `TRUE` / `FALSE`      | `BOOLEAN`         |
| `"date"`    | `Date`           | ISO string (UTC)      | `DATE_TIME` (real date, UTC) |
| `"json"`    | `unknown`        | JSON text             | `TEXT`            |

Empty cells read as `null`. Table column types are only set when the library creates the table. Existing tables are not changed.

### Field options

| Option     | Applies to  | Description                                                                                          |
| ---------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `required` | all         | Rejects `null`, `undefined` and `""`. Required fields are non-null in the row type and mandatory in `create`. |
| `unique`   | all         | No two rows may have the same value. Checked on `create`, `createMany`, `update`, `importMany`. `null` is ignored. |
| `default`  | all         | A value, or a function called once per row. Used on create when the field is `undefined`.             |
| `enum`     | `"string"`  | Allowed values. Validated on write. Becomes a dropdown column in a new table. Use `as const` for literal types. |

### Automatic fields

Every row also has these. The names are reserved, and defining them in a schema throws `SCHEMA`.

| Field       | Type     | Description                                                          |
| ----------- | -------- | -------------------------------------------------------------------- |
| `id`        | `string` | UUID generated on create. You can pass your own `id` to `create`.    |
| `createdAt` | `Date`   | Set on create.                                                       |
| `updatedAt` | `Date`   | Set on create and on every update.                                   |

### Type helpers

```ts
import type { InferRow } from "@mnugrohoe/gsheet-orm";

type ItemRow = InferRow<typeof Item>;
// { id: string; createdAt: Date; updatedAt: Date;
//   sku: string; name: string; stock: number | null;
//   status: "active" | "retired" | null; meta: unknown; seenAt: Date | null }
```

Also exported: `Row<S>`, `CreateInput<S>`, `UpdateInput<S>`, `Where<R>`, `FindOptions<R>`, `Operator<T>`, `ModelOptions`, `FieldDef`, `Schema`.

---

## Model options

Third argument of `db.model`. Everything is optional.

| Option          | Default  | Description                                                                                         |
| --------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `spreadsheetId` | the `GSheetDB` default | Spreadsheet for this model.                                                           |
| `source`        | `"auto"` | `"auto"`: Table, then plain tab, then create a Table. `"table"`: Tables only. `"sheet"`: plain tab only. |
| `table`         | model name | Table name to look for or create.                                                                 |
| `sheet`         | model name | Tab name to look for or create.                                                                   |
| `create`        | `true`   | Create the tab and table when missing. With `false` a missing one throws `SCHEMA`.                  |
| `migrate`       | `true`   | Add schema columns missing from the header. With `false` a missing column throws `SCHEMA`.          |
| `healIds`       | `true`   | Give an `id` (and timestamps) to rows typed in by hand in Sheets, the next time the model reads.    |
| `cache`         | off      | `{ ttlMs: number }`. See [Caching](#caching).                                                       |
| `driver`        | none     | Custom storage, mostly for tests. See [Testing](#testing).                                          |

```ts
db.model("items", schema);                                 // auto
db.model("items", schema, { source: "table" });            // tables only
db.model("items", schema, { source: "sheet" });            // plain tab only
db.model("items", schema, { table: "tbl_items", sheet: "Items" });
db.model("items", schema, { create: false, migrate: false }); // never changes the spreadsheet structure
```

### `model.source` and `model.sync()`

`await model.sync()` connects to the spreadsheet: it finds or creates the storage and adds missing columns. It runs automatically on the first read or write, so you rarely call it. `model.source` is `"table"`, `"sheet"`, or `undefined` before the first connection.

```ts
await Item.sync();
console.log(Item.source); // "table" or "sheet"
```

---

## Reading data

### `findMany(options?)`

Returns all matching rows.

```ts
findMany(options?: {
  where?: Where<Row>;
  orderBy?: { field: string; dir?: "asc" | "desc" } | Array<{ field: string; dir?: "asc" | "desc" }>;
  limit?: number;
  offset?: number;
  fresh?: boolean;   // skip the read cache for this call
}): Promise<Row[]>
```

```ts
// everything
await Item.findMany();

// low stock, lowest first, first page of 20
await Item.findMany({
  where: { stock: { lt: 5 }, status: "active" },
  orderBy: { field: "stock" },
  limit: 20,
  offset: 0,
});

// multiple sort keys
await Item.findMany({
  orderBy: [{ field: "status" }, { field: "stock", dir: "desc" }],
});
```

Rows are returned as copies, so changing them never affects the cache.

### `findFirst(where?)`

First match or `null`.

```ts
const item = await Item.findFirst({ sku: "A-001" });
if (!item) throw new Error("not found");
```

### `findById(id)`

Same as `findFirst({ id })`.

```ts
const item = await Item.findById("5f0c...");
```

### `count(where?)`

```ts
const low = await Item.count({ stock: { lt: 5 } }); // number
const all = await Item.count();
```

### where

`where` is one of:

1. **An object** of field to value or operators. All entries must match (AND).
2. **A predicate** `(row) => boolean` for anything else (OR, computed conditions).

```ts
// equality and null
await Item.findMany({ where: { status: "active" } });
await Item.findMany({ where: { seenAt: null } });          // empty cells

// operators
await Item.findMany({ where: { stock: { gte: 1, lte: 10 } } });
await Item.findMany({ where: { name: { contains: "filter" } } });
await Item.findMany({ where: { sku: { in: ["A-1", "A-2"] } } });

// dates
await Item.findMany({ where: { seenAt: { gte: new Date("2026-01-01") } } });

// predicate (OR)
await Item.findMany({ where: (r) => r.stock === 0 || r.status === "retired" });
```

| Operator     | Meaning                                                  |
| ------------ | -------------------------------------------------------- |
| `eq`, `ne`   | equal, not equal                                         |
| `gt`, `gte`, `lt`, `lte` | greater / less than. A `null` value never matches. |
| `in`, `notIn`| value is (not) in the array                              |
| `contains`, `startsWith`, `endsWith` | case-insensitive text match            |

Notes:

- Dates compare by time, so you can pass `Date` objects.
- `json` fields can only be matched with a predicate.
- `where: {}` matches every row. Be careful with `update({}, ...)` and `delete({})`.

### orderBy, limit, offset

- `orderBy` accepts one object or an array. Empty values (`null`) always sort last.
- `offset` and `limit` are applied after sorting. Without `orderBy`, rows come in sheet order.

---

## Writing data

### `create(data)`

Inserts one row and returns it, with `id`, `createdAt` and `updatedAt` filled in.

```ts
const item = await Item.create({ sku: "A-001", name: "Oil filter", stock: 12 });
// { id: "…", sku: "A-001", name: "Oil filter", stock: 12, status: "active",
//   meta: null, seenAt: null, createdAt: Date, updatedAt: Date }

await Item.create({ sku: "A-002", name: "Belt", meta: { supplier: "PT X", tags: ["fan"] } });
await Item.create({ id: "my-own-id", sku: "A-003", name: "Hose" });
```

Throws `VALIDATION` (missing required, wrong type, value not in `enum`, unknown field) or `UNIQUE`.

### `createMany(items)`

Inserts many rows in one API call. All rows are validated before anything is written, so one invalid row means nothing is inserted. Returns the rows in the same order. An empty array returns `[]`.

```ts
const rows = await Item.createMany([
  { sku: "B-1", name: "Gasket" },
  { sku: "B-2", name: "Bearing" },
]);
```

### `update(where, data)`

Updates every matching row and returns the updated rows (empty array if none matched). Only the fields you pass change, `updatedAt` is refreshed, `undefined` values are ignored, and columns the model does not manage are left untouched.

```ts
const changed = await Item.update({ status: "active", stock: 0 }, { status: "retired" });
console.log(changed.length);

await Item.update({ sku: "A-001" }, { stock: 8, meta: { note: "recount" } });
await Item.update({ sku: "A-001" }, { seenAt: null }); // clear a field
```

Throws `VALIDATION` (also when setting a required field to `null`) or `UNIQUE`. Setting a `unique` field on several rows at once throws `UNIQUE`. `id` and `createdAt` cannot be updated.

### `updateById(id, data)`

Like `update` for one row. Returns the updated row, or `null` when the id does not exist.

```ts
const row = await Item.updateById(item.id, { stock: 20 });
```

### `upsert(where, data)`

Updates the first row that matches `where`, or creates a new one. `data` is a full create input. The `id` in `data` is ignored when updating.

```ts
const row = await Item.upsert(
  { sku: "A-001" },
  { sku: "A-001", name: "Oil filter", stock: 3 },
);
```

### `delete(where)`

Deletes every matching row and returns how many were removed. In a Table the rows below shift up inside the table's columns. In a plain tab the whole sheet row is removed.

```ts
const removed = await Item.delete({ status: "retired" }); // number
await Item.delete((r) => (r.stock ?? 0) < 0);
```

### `deleteById(id)`

Returns `true` if a row was deleted, `false` if the id did not exist.

```ts
const ok = await Item.deleteById(item.id);
```

### `importMany(rows)`

Inserts rows as they are, keeping the `id`, `createdAt` and `updatedAt` you give. Defaults, validation and `unique` still apply. Use it to back-fill data, copy between spreadsheets, or move rows.

```ts
await Item.importMany([
  { id: "legacy-1", sku: "OLD-1", name: "Old part", createdAt: new Date("2020-05-01") },
]);
```

### Behavior to know

- Every update and delete reads the sheet first to find the rows, so each costs at least two API calls.
- There are no transactions. Two writers at the same time can race.
- Values are written raw, so a string like `=1+1` is stored as text and never runs as a formula.

---

## Sharding (one model over many spreadsheets)

Use sharding when one logical table is split over several spreadsheets by a date or number field, for example one spreadsheet per year range. You declare the spreadsheets once on the `GSheetDB`, and mark the models that are split with `partitionBy`. Everything else is the normal `db.model` API.

```ts
const db = new GSheetDB({
  spreadsheetId: process.env.SS_MASTER!, // used by models without partitionBy
  shards: [
    { spreadsheetId: process.env.SS_2022_2023!, years: [2022, 2023], label: "2022-23" },
    { spreadsheetId: process.env.SS_2024!, years: [2024, 2024], label: "2024" },
    { spreadsheetId: process.env.SS_2025!, years: [2025, null], label: "2025+" }, // open-ended
  ],
});

// split: rows go to the spreadsheet whose range contains their date
const Orders = db.model(
  "orders",
  {
    orderNo: { type: "string", required: true, unique: true },
    customerId: "string",
    date: { type: "date", required: true },
    total: { type: "number", default: 0 },
  },
  { partitionBy: "date" },
);

// not split: same call, stored in the master spreadsheet
const Customers = db.model("customers", { name: "string", tier: "string" });
```

A model can also bring its own shard list, which replaces the one on `GSheetDB` for that model:

```ts
db.model("logs", { seq: { type: "number", required: true } }, {
  partitionBy: "seq",
  shards: [
    { spreadsheetId: "a", to: 100000 },
    { spreadsheetId: "b", from: 100000 },
  ],
});
// db.sharded("logs", schema, { partitionBy: "seq", shards: [...] }) does the same
```

### Options

Shards are declared in `new GSheetDB({ shards })` (or `shards` in the model options, or `db.sharded`).

On the model, `partitionBy` turns sharding on. The model accepts every [model option](#model-options) except `spreadsheetId` and `driver`, plus:

| Option        | Description                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `partitionBy` | Field the rows are split by. Must be a `"date"` or `"number"` field. Make it `required`.            |
| `shards`      | Optional. Replaces the `GSheetDB` shards for this model only.                                       |
| `concurrency` | Optional. Max spreadsheets queried at the same time. Default: the `GSheetDB` value, else `4`.       |

`partitionBy` without any shards (on the `GSheetDB` or on the model) throws `CONFIG`. `partitionBy` together with `spreadsheetId` also throws `CONFIG`.

Shard definition:

| Field           | Description                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `spreadsheetId` | The spreadsheet for this range.                                                                     |
| `years`         | Date fields only. `[from, to]` whole years, inclusive, in UTC. `[2025, null]` is open-ended.        |
| `from` / `to`   | Alternative to `years`, for dates or numbers. `from` is inclusive, `to` is exclusive. Either can be omitted. |
| `label`         | Name used in errors and in `shardsFor()`. Defaults to the spreadsheet id.                           |
| `table`, `sheet`| Per-shard names, for example `sheet: "Orders 2024"`.                                                |
| `driver`        | Custom driver for this shard (tests).                                                               |

Ranges must not overlap (`SCHEMA` error). Gaps are allowed, but writing a row that falls in a gap throws `SHARD`.

### Methods

A sharded model has the same methods as a normal model: `findMany`, `findFirst`, `findById`, `count`, `create`, `createMany`, `importMany`, `update`, `updateById`, `upsert`, `delete`, `deleteById`, `join`, `sync`. The differences:

| Method | Behavior |
| ------ | -------- |
| `create`, `createMany`, `importMany` | Each row goes to the spreadsheet that owns its partition value. Results come back in input order. If one spreadsheet fails after another succeeded, the earlier inserts stay. |
| `findMany`, `count`, `findFirst`, `update`, `delete` | Only spreadsheets that can match the `where` on the partition field are touched (`eq`, `in`, `gt`, `gte`, `lt`, `lte`). Any other `where`, or a predicate function, touches all of them. |
| `findMany` over several | Rows are merged, then `orderBy`, `offset` and `limit` apply to the whole result. Without `orderBy` you get range order. |
| `findById(id, hint?)`, `updateById(id, data, hint?)`, `deleteById(id, hint?)` | An id does not tell which spreadsheet holds it, so they search from newest to oldest. Pass a partition value as `hint` to read only one spreadsheet. |
| `update` that changes the partition field | The row moves to the spreadsheet that now owns it. It is inserted there first and deleted from the old one after, so a failure leaves a duplicate and not a loss. `id` and `createdAt` are kept. |
| `upsert` | Looks for a match in the candidate spreadsheets, otherwise creates in the right one. |

```ts
// writes are routed by date
await Orders.create({ orderNo: "SO-1", date: new Date("2024-03-01"), total: 100 }); // → 2024 spreadsheet

// only the 2025+ spreadsheet is read
await Orders.findMany({ where: { date: { gte: new Date("2025-01-01") } } });

// across years: merged, then sorted and limited as a whole
await Orders.findMany({ orderBy: { field: "total", dir: "desc" }, limit: 10 });

// fast lookup when you know roughly when it was created
await Orders.findById(id, new Date("2024-06-01"));

// moving a row by changing its date
await Orders.updateById(id, { date: new Date("2025-02-01") });
```

### Inspecting

```ts
Orders.shardsFor({ date: { gte: new Date("2025-02-01") } });
// [{ spreadsheetId: "…", label: "2025+" }]   which spreadsheets this query would touch

Orders.sources;
// [{ label: "2022-23", source: "sheet" }, { label: "2024", source: "table" }, …]

await Orders.sync(); // connect every spreadsheet now
```

Each spreadsheet resolves its own storage, so an old spreadsheet that is still a plain tab and a new one that uses a Table work together.

### Limits

- There are no cross-spreadsheet transactions.
- `unique` is checked inside one spreadsheet only, not across all of them.
- Reading across all spreadsheets costs one read per spreadsheet. Filter on the partition field whenever you can.

---

## Joins

`join` combines two models in memory. It works between normal and sharded models, on the same or different spreadsheets. It is a method on every model, and also a standalone function.

```ts
const Customer = db.model(
  "customers",
  { name: { type: "string", required: true }, tier: "string" },
  { spreadsheetId: process.env.SS_MASTER },
);
```

### `model.join(other, options)` and `join(left, right, options)`

| Option       | Description                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `on`         | `[leftField, rightField]`. Rows match when the two values are equal. `null` never matches.          |
| `as`         | Property that receives the joined data. It must not be a field of the left model.                   |
| `type`       | `"left"` (default) keeps left rows without a match. `"inner"` drops them.                           |
| `many`       | `false` (default): `as` is the first match or `null`. `true`: `as` is an array of all matches.      |
| `where`      | Filter on the left model. Prunes spreadsheets when the left model is sharded.                       |
| `rightWhere` | Filter on the right model.                                                                          |
| `orderBy`    | Sorts the left rows (and so the result).                                                            |
| `limit`, `offset` | Applied to the final result.                                                                   |

How it runs: it reads the left rows (with `where`), collects their key values, then reads only the right rows whose key appears on the left. If the right model is sharded on the field you join on, only the needed spreadsheets are read.

```ts
// many-to-one (left join): every order, with its customer or null
const rows = await Orders.join(Customer, {
  on: ["customerId", "id"],
  as: "customer",
  where: { date: { gte: new Date("2025-01-01") } },
  orderBy: { field: "date", dir: "desc" },
  limit: 50,
});
rows[0].customer?.name;

// inner join: unmatched orders are dropped, `customer` is typed non-null
const matched = await Orders.join(Customer, {
  on: ["customerId", "id"],
  as: "customer",
  type: "inner",
});
matched[0].customer.name;

// one-to-many: each customer with all their orders from every year
const withOrders = await Customer.join(Orders, {
  on: ["id", "customerId"],
  as: "orders",
  many: true,
});
withOrders[0].orders.length;

// filter the right side
await Orders.join(Customer, {
  on: ["customerId", "id"],
  as: "customer",
  type: "inner",
  rightWhere: { tier: "gold" },
});

// standalone
import { join } from "@mnugrohoe/gsheet-orm";
await join(Orders, Customer, { on: ["customerId", "id"], as: "customer" });
```

The result type is the left row plus the `as` property, fully typed.

Notes:

- Without `many: true`, a left row with several matches gets the first one.
- A join result is plain data, not a model. To join three models, do two joins and merge in code, or join the smaller pair first.
- It is an in-memory hash join, so the usual size limits apply.

---

## Caching

By default every read goes to Google. For read-heavy pages, turn on a per-model cache.

```ts
const Item = db.model("items", schema, { cache: { ttlMs: 5000 } });

await Item.findMany();                  // reads from Google
await Item.findMany();                  // served from memory for 5 seconds
await Item.findMany({ fresh: true });   // skips the cache
await Item.create({ sku: "X", name: "x" }); // writes always read fresh and clear the cache
```

The cache lives in the memory of one server process. Writes from another process, another serverless instance, or by hand in Sheets are only seen after the TTL passes. On serverless platforms treat it as a short-lived helper, not shared state.

---

## Errors

Every error the library throws is a `GSheetError` with a `code`.

| Code         | When                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `CONFIG`     | Missing credentials, or no `spreadsheetId` for a model.                                                |
| `SCHEMA`     | Reserved field name, bad shard setup, missing tab/table/column when `create`/`migrate` is off, a tab with data but no Table in `source: "table"` mode. |
| `VALIDATION` | Missing required value, wrong type, value not in `enum`, unknown field, invalid date.                   |
| `UNIQUE`     | A `unique` field (or `id`) would be duplicated.                                                        |
| `SHARD`      | No shard covers the partition value.                                                                   |
| `API`        | Google returned an error after retries. `error.cause` holds the original error.                        |

```ts
import { GSheetError } from "@mnugrohoe/gsheet-orm";

try {
  await Item.create({ sku: "A-001", name: "Duplicate" });
} catch (err) {
  if (err instanceof GSheetError && err.code === "UNIQUE") {
    // show "SKU already exists"
  } else {
    throw err;
  }
}
```

---

## Testing

`@mnugrohoe/gsheet-orm/testing` exports `MemoryDriver`, an in-memory replacement for Google, so your own tests never touch the network.

```ts
import { GSheetDB } from "@mnugrohoe/gsheet-orm";
import { MemoryDriver } from "@mnugrohoe/gsheet-orm/testing";

const db = new GSheetDB(); // no credentials needed
const Item = db.model("items", schema, { driver: new MemoryDriver() });

await Item.create({ sku: "T-1", name: "Test" });
```

| `MemoryDriver` option | Description                                                                 |
| --------------------- | --------------------------------------------------------------------------- |
| `kind`                | `"sheet"` (default) or `"table"`. Changes how dates are stored, like the real thing. |
| `header`, `rows`      | Seed data, to test rows or extra columns added by hand.                     |

For sharded models give each shard its own driver:

```ts
const Orders = db.sharded("orders", schema, {
  partitionBy: "date",
  shards: [
    { spreadsheetId: "a", years: [2024, 2024], driver: new MemoryDriver() },
    { spreadsheetId: "b", years: [2025, null], driver: new MemoryDriver({ kind: "table" }) },
  ],
});
```

---

## Advanced

Most apps never need these.

- **`db.apiFor(spreadsheetId)`** returns a `SheetsApi` with `listSheets`, `batchUpdate`, `getValues`, `updateValues`, `batchUpdateValues`, `appendValues`. It retries like the models do.
- **Custom storage.** Implement the exported `Driver` interface (`init`, `read`, `append`, `update`, `remove`, plus `kind` and `dateFormat`) and pass it as `driver`. `TableDriver`, `SheetDriver` and `resolveDriver` are exported too.
- **Own HTTP client.** `SheetsApiLike` is the small interface the drivers need. Pass it to `resolveDriver` if you want a different transport.

---

## Recipes

### Next.js: one shared `db`

Keep a single instance, also across hot reloads in development.

```ts
// lib/db.ts
import { GSheetDB } from "@mnugrohoe/gsheet-orm";

const g = globalThis as unknown as { __gsheetDb?: GSheetDB };

export const db = (g.__gsheetDb ??= new GSheetDB({ spreadsheetId: process.env.SHEET_ID! }));

export const Item = db.model("items", {
  sku: { type: "string", required: true, unique: true },
  name: { type: "string", required: true },
  stock: { type: "number", default: 0 },
});
```

### Next.js: route handler

```ts
// app/api/items/route.ts
import { NextResponse } from "next/server";
import { GSheetError } from "@mnugrohoe/gsheet-orm";
import { Item } from "@/lib/db";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const items = await Item.findMany({
    where: q ? { name: { contains: q } } : undefined,
    orderBy: { field: "name" },
    limit: 50,
  });
  return NextResponse.json(items);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    return NextResponse.json(await Item.create(body), { status: 201 });
  } catch (err) {
    if (err instanceof GSheetError && (err.code === "VALIDATION" || err.code === "UNIQUE")) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
```

### Next.js: server action

```ts
"use server";
import { revalidatePath } from "next/cache";
import { Item } from "@/lib/db";

export async function addItem(formData: FormData) {
  await Item.create({
    sku: String(formData.get("sku")),
    name: String(formData.get("name")),
  });
  revalidatePath("/items");
}
```

If a page reads data at build time and should be fresh on every request, add `export const dynamic = "force-dynamic"` to that page.

### Pagination

```ts
const pageSize = 20;
const page = 3;
const [rows, total] = await Promise.all([
  Item.findMany({ orderBy: { field: "name" }, limit: pageSize, offset: (page - 1) * pageSize }),
  Item.count(),
]);
const pages = Math.ceil(total / pageSize);
```

### Soft delete

```ts
const Doc = db.model("docs", {
  title: "string",
  status: { type: "string", enum: ["active", "archived"] as const, default: "active" },
});

await Doc.updateById(id, { status: "archived" });          // "delete"
await Doc.findMany({ where: { status: "active" } });       // normal reads
```

### Split an existing table into year spreadsheets

```ts
// Old: the model on the single big spreadsheet. Orders: the sharded model (same fields).
const rows = await Old.findMany();

// importMany keeps id, createdAt and updatedAt, and puts each row in the spreadsheet of its date
await Orders.importMany(rows);

console.log(await Orders.count(), "rows imported");
```

Check the counts, then switch your app from `Old` to `Orders`. `Old` is left untouched, so you can delete it later by hand.
