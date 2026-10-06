import assert from "node:assert/strict";
import test from "node:test";
import { resolveDeviceLocation } from "./ip-location.js";

function stubFetch(body: unknown, ok = true) {
  return (async () => ({
    ok,
    json: async () => body,
  })) as unknown as typeof fetch;
}

test("resolves city and region from a public IP", async () => {
  const result = await resolveDeviceLocation(
    "1.2.3.4",
    stubFetch({ success: true, city: "Washington", region: "District of Columbia" }),
  );
  assert.deepEqual(result, { city: "Washington", region: "District of Columbia" });
});

test("returns null on lookup failure, 429, and timeout", async () => {
  assert.equal(await resolveDeviceLocation("1.2.3.4", stubFetch({ success: false })), null);
  assert.equal(await resolveDeviceLocation("1.2.3.4", stubFetch({}, false)), null);
  const abortable = ((url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  assert.equal(await resolveDeviceLocation("1.2.3.4", abortable, 10), null);
});

test("never looks up private, loopback, or non-IP inputs", async () => {
  let calls = 0;
  const counting = (async () => {
    calls += 1;
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
  for (const ip of ["127.0.0.1", "::1", "10.0.0.5", "192.168.1.9", "not-an-ip", "", undefined]) {
    assert.equal(await resolveDeviceLocation(ip, counting), null);
  }
  assert.equal(calls, 0);
});

test("accepts the first address of a forwarded chain", async () => {
  let requested = "";
  const recording = (async (url: string | URL | Request) => {
    requested = String(url);
    return { ok: true, json: async () => ({ success: true, city: "Austin", region: "Texas" }) };
  }) as unknown as typeof fetch;
  const result = await resolveDeviceLocation("8.8.8.8, 10.0.0.1", recording);
  assert.deepEqual(result, { city: "Austin", region: "Texas" });
  assert.ok(requested.includes("8.8.8.8"));
});
