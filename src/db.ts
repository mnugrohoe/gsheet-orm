import { SheetsApi, lazySheets, type ClientOptions } from "./client.js";
import { GSheetError } from "./errors.js";
import { Model } from "./model.js";
import {
  ShardedModel,
  type PartitionedModelOptions,
  type ShardDef,
  type ShardedOptions,
} from "./sharded.js";
import type { ModelOptions, Schema } from "./types.js";

export interface GSheetDBOptions extends ClientOptions {
  /**
   * Spreadsheets this database is split over, by range (for example one per year).
   * Models opt in with `db.model(name, schema, { partitionBy: "field" })`.
   * Models without `partitionBy` keep using `spreadsheetId`.
   */
  shards?: ShardDef[];
  /** Max spreadsheets queried in parallel by sharded models. Default 4. */
  concurrency?: number;
}

export class GSheetDB {
  private readonly apis = new Map<string, SheetsApi>();
  private readonly getSheets;

  constructor(private readonly opts: GSheetDBOptions = {}) {
    this.getSheets = lazySheets(opts);
  }

  /** API handle for one spreadsheet. All spreadsheets share a single Google login. */
  apiFor(spreadsheetId: string): SheetsApi {
    let api = this.apis.get(spreadsheetId);
    if (!api) {
      api = new SheetsApi({ ...this.opts, spreadsheetId }, this.getSheets);
      this.apis.set(spreadsheetId, api);
    }
    return api;
  }

  /** API handle for the default spreadsheet. */
  get api(): SheetsApi {
    if (!this.opts.spreadsheetId) {
      throw new GSheetError(
        "CONFIG",
        "No default spreadsheetId. Pass one to GSheetDB or to the model.",
      );
    }
    return this.apiFor(this.opts.spreadsheetId);
  }

  /**
   * Define a model. It has the same methods whether or not it is sharded.
   *
   * - Without `partitionBy`: one spreadsheet (`options.spreadsheetId`, else the default one).
   *   It binds to a Sheets Table named `name`, falls back to a tab named `name`, and creates a
   *   Table when neither exists.
   * - With `partitionBy`: rows are split over the shards declared on `GSheetDB`
   *   (or on this model) by that date or number field, and routed automatically.
   */
  model<const S extends Schema>(
    name: string,
    schema: S,
    opts: PartitionedModelOptions,
  ): ShardedModel<S>;
  model<const S extends Schema>(
    name: string,
    schema: S,
    opts?: ModelOptions,
  ): Model<S>;
  model<const S extends Schema>(
    name: string,
    schema: S,
    opts: ModelOptions | PartitionedModelOptions = {},
  ): Model<S> | ShardedModel<S> {
    if ("partitionBy" in opts && opts.partitionBy) {
      if ((opts as ModelOptions).spreadsheetId) {
        throw new GSheetError(
          "CONFIG",
          `[${name}] "spreadsheetId" cannot be combined with "partitionBy"`,
        );
      }
      const shards = opts.shards ?? this.opts.shards;
      if (!shards?.length) {
        throw new GSheetError(
          "CONFIG",
          `[${name}] "partitionBy" needs shards: pass \`shards\` to GSheetDB (or to this model)`,
        );
      }
      return this.sharded(name, schema, {
        ...opts,
        shards,
        concurrency: opts.concurrency ?? this.opts.concurrency,
      });
    }

    const id = (opts as ModelOptions).spreadsheetId ?? this.opts.spreadsheetId;
    return new Model<S>(name, schema, opts as ModelOptions, () => {
      if (!id)
        throw new GSheetError(
          "CONFIG",
          `[${name}] no spreadsheetId. Pass one to GSheetDB or to the model.`,
        );
      return this.apiFor(id);
    });
  }

  /**
   * Same as `db.model(name, schema, { partitionBy, shards })`, always with the shards given here.
   * Use it when this model has its own shard list.
   */
  sharded<const S extends Schema>(
    name: string,
    schema: S,
    opts: ShardedOptions,
  ): ShardedModel<S> {
    return new ShardedModel<S>(name, schema, opts, (id) => this.apiFor(id));
  }
}
