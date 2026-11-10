/** Extra rows added at once when a sheet runs out of room, so we do not grow on every write. */
export const ROW_BUFFER = 100;

export const addRowsRequest = (sheetId: number, length: number) => ({
  appendDimension: { sheetId, dimension: "ROWS", length },
});

export const addColumnsRequest = (sheetId: number, length: number) => ({
  appendDimension: { sheetId, dimension: "COLUMNS", length },
});

/** Google answers "Range (...) exceeds grid limits. Max rows: N, max columns: M" when a sheet is too small. */
export const isGridError = (err: unknown): boolean =>
  /exceeds grid limits|out of (the )?grid|beyond (the )?grid|grid limits/i.test(
    err instanceof Error ? err.message : String(err),
  );
