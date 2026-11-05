export { GSheetDB } from "./db.js";
export { Model } from "./model.js";
export { ShardedModel } from "./sharded.js";
export { join } from "./join.js";
export { SheetsApi } from "./client.js";
export { GSheetError } from "./errors.js";
export { resolveDriver } from "./drivers/resolve.js";
export { TableDriver } from "./drivers/table.js";
export { SheetDriver } from "./drivers/sheet.js";

export type { ClientOptions, SheetsApiLike, SheetMeta, TableMeta } from "./client.js";
export type { ErrorCode } from "./errors.js";
export type { ShardDef, ShardedOptions, PartitionedModelOptions } from "./sharded.js";
export type { GSheetDBOptions } from "./db.js";
export type { Queryable, JoinOptions, Joined, JoinType } from "./join.js";
export type { Driver, ColumnSpec, Cell, RawRow, DateFormat } from "./drivers/driver.js";
export type {
  FieldType,
  FieldDef,
  Schema,
  Row,
  CreateInput,
  UpdateInput,
  InferRow,
  Where,
  Operator,
  OrderBy,
  FindOptions,
  ModelOptions,
  SystemFields,
} from "./types.js";
