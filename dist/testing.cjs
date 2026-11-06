"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/testing.ts
var testing_exports = {};
__export(testing_exports, {
  MemoryDriver: () => MemoryDriver
});
module.exports = __toCommonJS(testing_exports);
var MemoryDriver = class {
  kind;
  dateFormat;
  header = [];
  rows = [];
  constructor(opts = {}) {
    this.kind = opts.kind ?? "sheet";
    this.dateFormat = this.kind === "table" ? "serial" : "iso";
    this.header = opts.header ?? [];
    this.rows = opts.rows ?? [];
  }
  async init(columns, { migrate }) {
    const missing = columns.map((c) => c.name).filter((n) => !this.header.includes(n));
    if (missing.length && migrate) this.header = [...this.header, ...missing];
    return [...this.header];
  }
  async read() {
    return this.rows.map((values, i) => ({
      rowNum: i + 2,
      values: [...values]
    }));
  }
  async append(rows) {
    this.rows.push(...rows.map((r) => [...r]));
  }
  async update(rows) {
    for (const { rowNum, values } of rows) this.rows[rowNum - 2] = [...values];
  }
  async remove(rowNums) {
    for (const n of [...rowNums].sort((a, b) => b - a))
      this.rows.splice(n - 2, 1);
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MemoryDriver
});
//# sourceMappingURL=testing.cjs.map