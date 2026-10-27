import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const [server, angel] = await Promise.all([
  readFile(new URL("server.js", root), "utf8"),
  readFile(new URL("angelone.js", root), "utf8")
]);

test("Render backs off from throttled historical candle providers", () => {
  assert.ok(server.includes("const yahooFallbackRetryAfter=new Map();"));
  assert.ok(server.includes("const retryUntil=yahooFallbackRetryAfter.get(key)||0;"));
  assert.ok(server.includes("if(Date.now()<retryUntil){"));
  assert.ok(server.includes("const retryMs=rateRejected?(IS_RENDER_MEMORY_LIMITED_RUNTIME?15*60*1000:5*60*1000):60000;"));
  assert.ok(angel.includes("const cooldown=rateRejected?(isRenderMemoryLimitedRuntime()?15*60*1000:5*60*1000):60*1000;"));
  assert.ok(server.includes("const retryMs=rateRejected?(IS_RENDER_MEMORY_LIMITED_RUNTIME?15*60*1000:5*60*1000):60*1000;"));
  assert.ok(server.includes("replace(/[^\\w]+$/,'')"));
});

test("Failed option-chain responses are cached as unavailable, not promoted to live", () => {
  assert.ok(server.includes("cached && now-cached.at<(cached.data?.connected?30000:90000)"));
  assert.ok(server.includes("if(data&&typeof data==='object'){"));
  assert.ok(server.includes("optionChainCache.set(key,{at:Date.now(),data});"));
  assert.ok(server.includes("pruneByAge(optionChainCache,90000);"));
});
