import { describe, expect, it } from "vitest";
import { dateToSerial, deserialize, serialize, serialToDate } from "../src/codec.js";

describe("codec", () => {
  it("converts dates to Sheets serials and back", () => {
    expect(dateToSerial(new Date("1970-01-01T00:00:00Z"))).toBe(25569);
    const d = new Date("2026-11-05T13:45:12.345Z");
    expect(serialToDate(dateToSerial(d)).getTime()).toBe(d.getTime());
  });

  it("serializes by type and date format", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    expect(serialize(d, "date", "iso")).toBe("2026-01-01T00:00:00.000Z");
    expect(typeof serialize(d, "date", "serial")).toBe("number");
    expect(serialize(null, "string", "iso")).toBeNull();
    expect(serialize({ a: 1 }, "json", "iso")).toBe('{"a":1}');
    expect(serialize("12", "number", "iso")).toBe(12);
  });

  it("deserializes sheet values leniently", () => {
    expect(deserialize("", "number")).toBeNull();
    expect(deserialize("abc", "number")).toBeNull();
    expect(deserialize("TRUE", "boolean")).toBe(true);
    expect(deserialize(false, "boolean")).toBe(false);
    expect(deserialize("not json", "json")).toBeNull();
    expect((deserialize(25569, "date") as Date).toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect((deserialize("2026-01-01T00:00:00.000Z", "date") as Date).getUTCFullYear()).toBe(2026);
    expect(deserialize("garbage", "date")).toBeNull();
  });
});
