# @mnugrohoe/gsheet-orm

A small, typed ORM for Google Sheets. It stores data in a **Google Sheets Table** when it can, and falls back to a plain **sheet tab** when there is no table. One model can also be split over several spreadsheets (for example one per year range), and models can be joined.

```bash
pnpm add @mnugrohoe/gsheet-orm
```

Node 18+. Server-side only (it uses a service account). Works well in Next.js route handlers and server actions.

**Documentation:** this README is the overview. The complete reference, with every method and an example for each, is in [docs/API.md](./docs/API.md).

## Quick start

```ts
// lib/db.ts
import { GSheetDB, type InferRow } from "@mnugrohoe/gsheet-orm";

export const db = new GSheetDB({
  spreadsheetId: process.env.SHEET_ID!, // default spreadsheet, optional if every model sets its own
  // reads GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY by default
});

export const Item = db.model("items", {
  sku: { type: "string", required: true, unique: true },
  name: { type: "string", required: true },
  stock: { type: "number", default: 0 },
  status: { type: "string", enum: ["active", "retired"], default: "active" },
  meta: "json",
  seenAt: "date",
});

export type ItemRow = InferRow<typeof Item>;
```

```ts
await Item.create({ sku: "A-001", name: "Filter", stock: 12 });

await Item.findMany({
  where: { stock: { lt: 5 }, status: "active" },
  orderBy: { field: "stock" },
  limit: 20,
});

await Item.updateById(id, { stock: 8 });
await Item.upsert({ sku: "A-001" }, { sku: "A-001", name: "Filter", stock: 3 });
await Item.delete({ status: "retired" }); // returns how many rows were removed
```

### Setup

1. Create a Google Cloud service account and enable the Google Sheets API.
2. Share your spreadsheet (every spreadsheet, if you shard) with the service account email (Editor).
3. Set `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY` (literal `\n` in the key is handled), or pass `credentials` / `auth` to `GSheetDB`.

## Table first, sheet as fallback

Each model resolves its storage once, in this order:

| Step | What it looks for                                                        | Used when `source` is |
| ---- | ------------------------------------------------------------------------ | --------------------- |
| 1    | A Sheets **Table** named `table` (default: the model name), on any tab   | `auto`, `table`       |
| 2    | A plain **tab** named `sheet` (default: the model name), header in row 1 | `auto`, `sheet`       |
| 3    | Nothing found: create a new tab and a Table on it                        | `auto`, `table`       |

```ts
db.model("items", schema); // auto: table, then tab, then create a table
db.model("items", schema, { source: "table" }); // tables only
db.model("items", schema, { source: "sheet" }); // plain tab only
db.model("items", schema, { table: "tbl_items", sheet: "Items" });
```

`model.source` tells you what was picked (`"table"` or `"sheet"`) after the first call or `await model.sync()`.

If `source` is `"table"` and the tab already holds data but has no table, it throws instead of converting your data. Convert the range to a table in Sheets first, or use `auto`.

### What differs between the two

|              | Table                                                                                 | Plain tab                     |
| ------------ | ------------------------------------------------------------------------------------- | ----------------------------- |
| Header       | table header row, anywhere on the tab                                                 | row 1                         |
| Column types | `TEXT`, `DOUBLE`, `BOOLEAN`, `DATE_TIME`, `DROPDOWN` (for `enum`) are set on creation | none                          |
| Dates        | real date values                                                                      | ISO strings                   |
| Insert       | `appendCells` with `tableId` (table expands, footer-aware)                            | `values.append`               |
| Delete       | `deleteRange`, shifts rows inside the table columns only                              | `deleteDimension` (whole row) |

Dates are written and read as UTC.

## One model over many spreadsheets (sharding)

If you split a table over several spreadsheets, for example one per year range, declare the spreadsheets once on the `GSheetDB`. Then every model is still created with the same `db.model(...)`. Only the models you want split get a `partitionBy`.

```ts
export const db = new GSheetDB({
  spreadsheetId: process.env.SS_MASTER!, // models without partitionBy live here
  shards: [
    { spreadsheetId: process.env.SS_2022_2023!, years: [2022, 2023] },
    { spreadsheetId: process.env.SS_2024!, years: [2024, 2024] },
    { spreadsheetId: process.env.SS_2025!, years: [2025, null] }, // null = open-ended
  ],
});

// split by year: add partitionBy (the field the rows are routed by)
export const Orders = db.model(
  "orders",
  {
    orderNo: { type: "string", required: true, unique: true },
    customerId: "string",
    date: { type: "date", required: true },
    total: { type: "number", default: 0 },
  },
  { partitionBy: "date" },
);

// not split: the same call without partitionBy, stored in the master spreadsheet
export const Customers = db.model("customers", { name: "string", tier: "string" });
```

If one model needs a different shard list, pass `shards` in its own options (`{ partitionBy: "date", shards: [...] }`), or use `db.sharded(name, schema, { partitionBy, shards })`.

It has the same methods as a normal model (`findMany`, `create`, `update`, `upsert`, `delete`, ...).

| Operation                                  | What happens                                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create` / `createMany`                    | Each row goes to the spreadsheet whose range contains its `date`. No match throws `SHARD`.                                                                        |
| `findMany` / `count` / `update` / `delete` | Only spreadsheets that can match the `where` on the partition field are read (`eq`, `in`, `gt`, `gte`, `lt`, `lte`). No filter on that field means all of them.   |
| `findMany` across several                  | Results are merged, then sorted, offset and limited as a whole. Without `orderBy` you get range order.                                                            |
| `findById(id, hint?)`                      | An id says nothing about the year, so it scans newest to oldest. Pass a date as `hint` to read one spreadsheet.                                                   |
| `update` of the partition field            | The row moves to the spreadsheet that now owns it (inserted first, deleted after, so a failure leaves a duplicate and not a loss). The `id` and all values are kept. |

**Latest first, without reading every year.** `findPage` reads the newest spreadsheet first and only moves to the next one when it is used up:

```ts
const page = await Orders.findPage({ pageSize: 20 }); // reads only the newest spreadsheet
const next = await Orders.findPage({ pageSize: 20, cursor: page.cursor });

await Orders.findLatest(10); // newest 10 rows
for await (const rows of Orders.pages({ pageSize: 100 })) { /* lazy, break any time */ }
```

See [paging](./docs/API.md#paging-newest-first-findpage-pages-findlatest).

Ranges use `years: [from, to]` (whole years, inclusive, UTC) for date fields, or `from` / `to` (to is exclusive) for dates and numbers. Ranges must not overlap. Gaps are allowed.

Each spreadsheet resolves its own storage, so a 2022 spreadsheet that is still a plain tab and a 2025 spreadsheet that uses a Table work side by side. Use `Orders.sources` to see what each one picked and `Orders.shardsFor(where)` to see which spreadsheets a query would touch.

Things sharding does not do:

- **No cross-spreadsheet transactions.** If `createMany` succeeds in one spreadsheet and fails in another, the first insert stays.
- **`unique` is checked inside one spreadsheet only**, not across all of them.

More in the [sharding reference](./docs/API.md#sharding-one-model-over-many-spreadsheets).

## Joins

`join` works between any two models, including a sharded model and a plain one on a different spreadsheet.

```ts
// Orders is split by year, Customers lives in the master spreadsheet (see above)

// many-to-one: each order gets its customer (or null)
const rows = await Orders.join(Customers, {
  on: ["customerId", "id"], // [left field, right field]
  as: "customer",
  where: { date: { gte: new Date("2025-01-01") } }, // prunes shards on the left
  orderBy: { field: "date", dir: "desc" },
  limit: 50,
});
rows[0].customer?.name;

// inner join: unmatched rows are dropped and `customer` is typed non-null
await Orders.join(Customers, {
  on: ["customerId", "id"],
  as: "customer",
  type: "inner",
});

// one-to-many: each customer gets all their orders from every year
await Customers.join(Orders, {
  on: ["id", "customerId"],
  as: "orders",
  many: true,
});
```

It reads the left side first, then only the right rows whose key appears on the left. It is an in-memory hash join, so the same size limits as the rest of the library apply. More in the [join reference](./docs/API.md#joins).

## Moving rows yourself

`importMany(rows)` inserts rows as given, keeping the `id` and every value you pass (including `auto` date fields). It exists on normal and sharded models. Use it to back-fill a new spreadsheet or to split an old table into shards:

```ts
await Orders.importMany(await OldOrders.findMany());
```

## Schema

Fields are `"string" | "number" | "boolean" | "date" | "json"` or `{ type, required?, unique?, default?, enum?, auto? }`.

**The only column the library adds is the row id** (`id`, a UUID). Use a column you already have with `idColumn`, and add timestamps only if you want them:

```ts
const Transactions = db.model(
  "Transaction",
  {
    Date: { type: "date", required: true },
    Amount: "number",
    updatedAt: { type: "date", auto: "update" }, // optional: set on create and on every update
  },
  { idColumn: "TransId" }, // the `id` property lives in your existing TransId column
);
```

Details: [row id and timestamps](./docs/API.md#row-id-and-timestamps).

- Writes are validated: required, type, `enum`, unique, unknown field.
- Extra columns you add by hand in Sheets are left untouched on update.
- Columns missing from the header are added (`migrate: true`, the default).
- Rows typed in by hand in Sheets get an `id` assigned the next time the model reads them (`healIds`, on by default, off when you set `idColumn`).
- The sheet grows by itself: rows and columns are added when a table or tab reaches the bottom or right edge of the grid.
- Values are stored raw, so text like `=1+1` stays text and never runs as a formula.

## API at a glance

Every method has a full description and examples in [docs/API.md](./docs/API.md).

| Method                                         | Returns                          | Reference                                                         |
| ---------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `findMany({ where, orderBy, limit, offset })`  | `Row[]`                          | [findMany](./docs/API.md#findmanyoptions)                         |
| `findFirst(where?)` / `findById(id)`           | `Row \| null`                    | [findFirst](./docs/API.md#findfirstwhere)                         |
| `count(where?)`                                | `number`                         | [count](./docs/API.md#countwhere)                                 |
| `create(data)` / `createMany(data[])`          | `Row` / `Row[]`                  | [create](./docs/API.md#createdata)                                |
| `update(where, data)` / `updateById(id, data)` | `Row[]` / `Row \| null`          | [update](./docs/API.md#updatewhere-data)                          |
| `upsert(where, data)`                          | `Row`                            | [upsert](./docs/API.md#upsertwhere-data)                          |
| `delete(where)` / `deleteById(id)`             | `number` / `boolean`             | [delete](./docs/API.md#deletewhere)                               |
| `importMany(rows)`                             | `Row[]`, keeps id and timestamps | [importMany](./docs/API.md#importmanyrows)                        |
| `join(other, options)`                         | joined rows                      | [Joins](./docs/API.md#joins)                                      |
| `sync()`                                       | `void` (runs automatically)      | [model.source and sync](./docs/API.md#modelsource-and-modelsync) |

`where` accepts equality, operators (`eq ne gt gte lt lte in notIn contains startsWith endsWith`), or a predicate `(row) => boolean`. See [where](./docs/API.md#where).

### Options

```ts
db.model(name, schema, {
  spreadsheetId, // overrides the default one for this model
  source: "auto", // "auto" | "table" | "sheet"
  table,
  sheet, // names, default: model name
  create: true, // create tab/table when missing
  migrate: true, // add missing columns
  idColumn: "id", // header of the row id column, e.g. "TransId" to reuse a column you have
  healIds: true, // give hand-added rows an id (default off with a custom idColumn)
  cache: { ttlMs: 5000 }, // optional read cache, invalidated by writes
});
```

Errors are `GSheetError` with `code`: `CONFIG | SCHEMA | VALIDATION | UNIQUE | SHARD | API`. Requests are retried with backoff on 429 and 5xx. See [Errors](./docs/API.md#errors).

## Testing your app

```ts
import { MemoryDriver } from "@mnugrohoe/gsheet-orm/testing";

const Item = db.model("items", schema, {
  driver: new MemoryDriver({ kind: "table" }),
});

// sharded: give every shard its own driver
db.sharded("orders", schema, {
  partitionBy: "date",
  shards: [
    { spreadsheetId: "a", years: [2024, 2024], driver: new MemoryDriver() },
  ],
});
```

## Limits to know about

- Every read loads the whole table or tab (of each spreadsheet it touches) and filters in memory. That is fine for thousands of rows. Mind the Sheets API quota (about 60 reads per minute per user), and use `cache` for read-heavy pages.
- There are no transactions or locks. Concurrent writers can race, and `unique` is checked against the latest read only.
- Writes always read first to find the right rows, so each update or delete is at least two API calls.

## Development

```bash
pnpm install
pnpm dev          # watch mode: rebuilds dist/ on every change in src/
pnpm test:watch   # tests in watch mode
pnpm test         # run tests once
pnpm typecheck
pnpm build
```

pnpm 11+ blocks install scripts by default. `pnpm-workspace.yaml` allows `esbuild` (needed by tsup), so `pnpm install` works without `pnpm approve-builds`.

Use it in an app while developing: keep `pnpm dev` running here, and in the app's `package.json` set `"@mnugrohoe/gsheet-orm": "link:../gsheet-orm"`, then run `pnpm install` in the app. Restart the app's dev server if a change does not show up.

On Windows PowerShell 5, chain commands with `;` instead of `&&`.

`test/docs.test.ts` runs the examples from `docs/API.md`, so keep the two in sync when you change behaviour. Unit tests run against fakes and an in-memory driver. The Google API calls themselves are not covered by CI, so run a manual smoke test against a scratch spreadsheet before relying on a new version.

## Publishing

```bash
pnpm typecheck; pnpm test
pnpm publish --access public   # scoped packages need --access public the first time; runs prepublishOnly
```

Add `repository`, `homepage` and `bugs` to `package.json` so the npm page links to GitHub and the relative links in this README resolve:

```json
"repository": { "type": "git", "url": "git+https://github.com/USER/gsheet-orm.git" },
"homepage": "https://github.com/USER/gsheet-orm#readme",
"bugs": { "url": "https://github.com/USER/gsheet-orm/issues" }
```

## License

MIT
