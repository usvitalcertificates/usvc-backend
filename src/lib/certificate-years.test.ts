import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { certificateDateBounds, certificateYearRange } from "./certificate-years.js";
import { CERTIFICATE_YEAR_DATA } from "./certificate-year-data.js";

const now = new Date("2026-10-26T12:00:00Z");
test("Los Angeles has separate birth, death and marriage floors", () => {
  for (const [type, year] of [
    ["birth", 1866],
    ["death", 1877],
    ["marriage", 1852],
  ] as const)
    assert.deepEqual(certificateYearRange("CA", `${type}-certificate`, "Los Angeles"), {
      minYear: year,
      maxYear: null,
    });
  assert.notDeepEqual(
    certificateYearRange("CA", "birth", "Alameda"),
    certificateYearRange("CA", "birth", "Los Angeles"),
  );
});
test("missing and not-offered ranges have no invented cutoff", () => {
  for (const [state, type, county] of [
    ["CA", "divorce", "Los Angeles"],
    ["CA", "marriage", "Alpine"],
    ["XX", "death", "Unknown"],
    ["CA", "death", "constructor"],
  ]) {
    assert.equal(certificateYearRange(state, type, county), undefined);
    assert.deepEqual(certificateDateBounds(state, type, county, now), {
      min: undefined,
      max: undefined,
    });
  }
});
test("current maxima roll forward; historical maxima remain fixed", () => {
  assert.deepEqual(certificateDateBounds("ca", "MARRIAGE", "  los angeles ", now), {
    min: "1852-01-01",
    max: "2026-10-26",
  });
  assert.equal(
    certificateDateBounds("CA", "MARRIAGE", "Los Angeles", new Date("2027-03-04T12:00:00Z")).max,
    "2027-03-04",
  );
  const historical = Object.entries(CERTIFICATE_YEAR_DATA).flatMap(([state, types]) =>
    Object.entries(types).flatMap(([type, counties]) =>
      Object.entries(counties)
        .filter(([, range]) => range[1] !== null)
        .map(([county, range]) => ({ state, type, county, range })),
    ),
  );
  assert.ok(historical.length > 0);
  for (const { state, type, county, range } of historical)
    assert.equal(certificateYearRange(state, type, county)?.maxYear, range[1]);
  const sample = historical.find((row) => row.type !== "birth") ?? historical[0];
  assert.equal(
    certificateDateBounds(sample.state, sample.type, sample.county, now).max,
    `${sample.range[1]}-12-31`,
  );
});
test("birth retains its 90-day waiting period even without a known year range", () => {
  assert.equal(certificateDateBounds("CA", "BIRTH", "Los Angeles", now).max, "2026-07-28");
  assert.deepEqual(certificateDateBounds("XX", "BIRTH", "Unknown", now), {
    min: undefined,
    max: "2026-07-28",
  });
});
test("all imported ranges are valid and frontend/backend use identical data", () => {
  assert.ok(Object.keys(CERTIFICATE_YEAR_DATA).length > 40);
  for (const types of Object.values(CERTIFICATE_YEAR_DATA))
    for (const counties of Object.values(types))
      for (const [min, max] of Object.values(counties)) {
        assert.ok(Number.isInteger(min) && min > 1800 && min <= 2026);
        assert.ok(max === null || (Number.isInteger(max) && max >= min && max < 2026));
      }
  assert.equal(
    readFileSync(new URL("./certificate-year-data.ts", import.meta.url), "utf8"),
    readFileSync(
      new URL("../../../usvc-frontend/lib/certificate-year-data.ts", import.meta.url),
      "utf8",
    ),
  );
});
