import test from "node:test";
import assert from "node:assert/strict";
import { createSharedRefresh } from "../sharedRefresh.js";

test("coalesces concurrent requests for the same key", async () => {
  const sharedRefresh = createSharedRefresh();
  let calls = 0;
  let finish;
  const loader = () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  };

  const first = sharedRefresh("same-key", loader, 1000);
  const second = sharedRefresh("same-key", loader, 1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  finish({ ok: true });
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
});

test("a timed-out refresh stays shared until the original work settles", async () => {
  const sharedRefresh = createSharedRefresh({ maxInFlightLingerMs: 500 });
  let calls = 0;
  let finish;
  const first = sharedRefresh("slow-key", () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  }, 15);

  await assert.rejects(first, /Shared refresh timed out: slow-key/);
  const second = sharedRefresh("slow-key", async () => {
    calls++;
    return "duplicate";
  }, 15);
  await assert.rejects(second, /Shared refresh timed out: slow-key/);
  assert.equal(calls, 1);

  finish("original");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await sharedRefresh("slow-key", async () => {
    calls++;
    return "fresh";
  }, 100), "fresh");
  assert.equal(calls, 2);
});
