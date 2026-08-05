import assert from "node:assert/strict";
import test from "node:test";

import {
  currentLinearDescriptionTimestamp,
  parseLinearDescriptionTimestamp,
} from "./LinearDescriptionTimestamp.js";

test("description timestamps use local numeric offsets and a fixed millisecond form", () => {
  const now = new Date("2026-01-02T03:04:05.006Z");
  const timestamp = currentLinearDescriptionTimestamp(now);
  const expected = `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
    + `T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  assert.equal(timestamp, `${expected}${offset}`);
  assert.equal(parseLinearDescriptionTimestamp(timestamp), timestamp);
});

test("description timestamp parser rejects UTC suffixes and impossible calendar values", () => {
  for (const value of [
    "2026-01-02T03:04:05.006Z",
    "2026-02-30T03:04:05.006+08:00",
    "2026-01-02T03:04:05.006+8:00",
  ]) {
    assert.throws(() => parseLinearDescriptionTimestamp(value), /linear_description_timestamp_invalid/u);
  }
});
