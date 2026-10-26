import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pkgText, angel, server, desktop, start] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../angelone.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../electron/main.cjs", import.meta.url), "utf8"),
  readFile(new URL("../start.js", import.meta.url), "utf8")
]);
const pkg = JSON.parse(pkgText);

test("Render starts Node with a conservative heap while local npm start keeps its original cap", () => {
  assert.equal(pkg.scripts.start, "node start.js");
  assert.ok(start.includes('["--max-old-space-size=96", "--max-semi-space-size=1", "--initial-old-space-size=16", "--expose-gc", "server.js"]'));
  assert.ok(start.includes('["--max-old-space-size=320", "server.js"]'));
  assert.ok(start.includes("const isRenderRuntime ="));
});

test("Render refuses the legacy full instrument-master allocation", () => {
  assert.ok(angel.includes("if(isRenderMemoryLimitedRuntime()) throw new Error('Full instrument master is disabled on Render to protect the 512 MiB runtime."));
  assert.ok(angel.includes("export function trimAngelMemoryCaches"));
});

test("API memory gate and GC monitor are conditional on Render only", () => {
  assert.ok(server.includes('if(!IS_RENDER_MEMORY_LIMITED_RUNTIME || !req.path.startsWith("/api/") || MEMORY_SAFE_API_PATHS.has(req.path)) return next();'));
  assert.ok(server.includes("const RENDER_MEMORY_GATE_BYTES = 280 * 1024 * 1024;"));
  assert.ok(server.includes("const RENDER_MEMORY_WARN_BYTES = 88 * 1024 * 1024;"));
  assert.ok(server.includes("renderActiveApiRequests >= 2"));
  assert.ok(server.includes("const memoryMonitor=setInterval"));
  assert.ok(server.includes("memoryMonitor.unref()"));

});

test("Render NIFTY-only mode skips closed-session history and backtest", () => {
  assert.ok(server.includes("if(IS_RENDER_MEMORY_LIMITED_RUNTIME && !marketOpen)"));
  assert.ok(server.includes("OFF_SESSION_MEMORY_SAFE_FAST_PATH"));
  assert.ok(server.includes("skips historical backfill and backtest while the market is closed"));
  assert.ok(angel.includes('? ["99926000"]'));
  assert.ok(angel.includes("if(!isRenderMemoryLimitedRuntime())"));
});

test("Electron desktop starts its local server directly and does not use npm start flags", () => {
  assert.ok(desktop.includes('spawn(process.execPath, [serverScriptPath()]'));
  assert.ok(desktop.includes('ELECTRON_RUN_AS_NODE: "1"'));
});
