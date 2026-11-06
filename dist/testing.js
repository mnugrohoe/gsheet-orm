// src/testing.ts
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
export {
  MemoryDriver
};
//# sourceMappingURL=testing.js.map