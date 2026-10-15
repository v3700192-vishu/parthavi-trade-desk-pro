import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronMain = readFileSync(join(root, "electron", "main.cjs"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8").replace(String.fromCharCode(0xfeff), ""));

test("desktop reuses Kiran PC's healthy server instead of launching a duplicate", () => {
  assert.match(electronMain, /function probeHealthyServer/);
  assert.match(electronMain, /if \(await probeHealthyServer\(\)\) return;/);
  assert.match(electronMain, /await ensureServerAvailable\(\);/);
});

test("desktop watches the live public folder and refreshes after UI files change", () => {
  assert.match(electronMain, /function findLivePublicDirectory/);
  assert.match(electronMain, /ParthaviTradeDesk-Server/);
  assert.match(electronMain, /fs\.watch\(publicDir/);
  assert.match(electronMain, /reloadIgnoringCache\(\)/);
});

test("Windows desktop build includes frontend and market instrument data", () => {
  assert.ok(packageJson.scripts["desktop:build"]);
  assert.ok(packageJson.build.files.includes("public/**/*"));
  assert.ok(packageJson.build.files.includes("data/**/*"));
  assert.ok(packageJson.build.files.includes("server.js"));
  assert.ok(packageJson.build.files.includes("angelSessionVault.js"), "secure Angel session module must be packaged with the server");
  assert.ok(!packageJson.build.files.includes(".env"));
});

test("Windows desktop installer creates Start Menu and desktop shortcuts", () => {
  assert.ok(packageJson.build.win.target.some((x) => x.target === "nsis"));
  assert.equal(packageJson.build.nsis.createDesktopShortcut, true);
  assert.equal(packageJson.build.nsis.createStartMenuShortcut, true);
});