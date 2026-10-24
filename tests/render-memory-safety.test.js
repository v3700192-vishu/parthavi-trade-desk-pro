import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pkgText, angel, server, desktop] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../angelone.js", import.meta.url), "utf8"),
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../electron/main.cjs", import.meta.url), "utf8")
]);
const pkg = JSON.parse(pkgText);

test("Render starts Node with a conservative heap and smaller young generation", () => {
  assert.equal(pkg.scripts.start, "node --max-old-space-size=192 --max-semi-space-size=8 --expose-gc server.js");
});

test("Render refuses the legacy full instrument-master allocation", () => {
  assert.ok(angel.includes("if(isRenderMemoryLimitedRuntime()) throw new Error('Full instrument master is disabled on Render to protect the 512 MiB runtime."));
  assert.ok(angel.includes("export function trimAngelMemoryCaches"));
});

test("API memory gate and GC monitor are conditional on Render only", () => {
  assert.ok(server.includes('if(!IS_RENDER_MEMORY_LIMITED_RUNTIME || !req.path.startsWith("/api/") || MEMORY_SAFE_API_PATHS.has(req.path)) return next();'));
  assert.ok(server.includes("const RENDER_MEMORY_GATE_BYTES = 280 * 1024 * 1024;"));
  assert.ok(server.includes("renderActiveApiRequests >= 2"));
  assert.ok(server.includes("const memoryMonitor=setInterval"));
  assert.ok(server.includes("memoryMonitor.unref()"));

});

test("Electron desktop starts its local server directly and does not use npm start flags", () => {
  assert.ok(desktop.includes('spawn(process.execPath, [serverScriptPath()]'));
  assert.ok(desktop.includes('ELECTRON_RUN_AS_NODE: "1"'));
});
