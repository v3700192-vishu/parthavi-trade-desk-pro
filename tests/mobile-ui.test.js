import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "public", "index.html"), "utf8");
const serviceWorker = readFileSync(path.join(root, "public", "sw.js"), "utf8");

test("mobile navigation renders five real, accessible buttons for existing sections", () => {
  const nav = html.match(/<nav class="bottom" id="bottomNav"[\s\S]*?<\/nav>/)?.[0] || "";
  assert.ok(nav, "bottom navigation is present");
  const buttons = nav.match(/<button\b[\s\S]*?<\/button>/g) || [];
  assert.equal(buttons.length, 5);
  for (const id of ["home", "chart", "signals", "news", "trade"]) {
    assert.ok(buttons.some(button => new RegExp(`data-target="${id}"`).test(button)), `missing navigation action for ${id}`);
    assert.ok(new RegExp(`id="${id}"`).test(html), `section ${id} does not exist`);
  }
  assert.ok(buttons.every(button => /aria-label="Go to /.test(button)));
});

test("mobile navigation has a standalone, capture-phase click handler", () => {
  assert.ok(html.includes('id="MOBILE_NAV_REFRESH_RELIABILITY_V2"'));
  assert.match(html, /nav\.addEventListener\('click',[\s\S]*?\},true\)/);
  assert.match(html, /event\.stopImmediatePropagation\(\)/);
  assert.match(html, /window\.scrollTo\(\{top,behavior:/);
});

test("mobile navigation targets are sized for touch and visibly labelled", () => {
  assert.match(html, /#bottomNav \.bottom-button\{[^}]*min-height:64px/);
  assert.match(html, /#bottomNav \.bottom-icon\{[^}]*font-size:22px/);
  assert.match(html, /#bottomNav \.bottom-label\{[^}]*font-size:12px/);
  assert.match(html, /#bottomNav\.bottom\{[^}]*z-index:60/);
});

test("Phase 10 has a dedicated refresh button that runs a fresh prediction request", () => {
  assert.match(html, /id="p10RefreshBtn"[^>]*onclick="refreshPredictionNow\(\)"/);
  assert.match(html, /window\.refreshPredictionNow=async function\(\)/);
  assert.match(html, /window\.loadPrediction\(true,true\)/);
  assert.match(html, /async function loadPrediction\(showToast=false,forceFresh=false\)/);
  assert.match(html, /forceFresh\?'&refresh='\+Date\.now\(\)/);
  assert.match(html, /cache:'no-store'/);
});

test("service-worker cache version is bumped and never caches live API responses", () => {
  assert.match(serviceWorker, /const CACHE='ptd-shell-v4'/);
  assert.match(serviceWorker, /if\(u\.pathname\.startsWith\('\/api\/'\)\) return/);
  assert.doesNotMatch(serviceWorker, /const CACHE='ptd-shell-v3'/);
});

test("Data Health distinguishes feed connectivity from live readiness gates", () => {
  const block = html.match(/function renderGates\(h\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  const card = html.match(/<div class="card">\s*<div class="card-head"><h3>Data Health<\/h3>[\s\S]*?<\/div>\s*<\/div>/)?.[0] || "";
  assert.ok(block, "renderGates is present");
  assert.ok(card.includes('id="dhTick"'), "verified exchange tick row must exist");
  assert.ok(card.includes('id="dhVolume"'), "10-day futures volume row must exist");
  assert.ok(card.includes('id="dhGreeks"'), "live Greeks row must exist");
  assert.match(block, /gateText\s*=\s*\(ok\)\s*=>\s*ok\s*\?\s*'ON'\s*:\s*'OFF'/);
  assert.match(block, /priceVerified=!!h\.market&&tickVerified/);
  assert.match(block, /marketGate=priceVerified&&volumeVerified/);
  assert.match(block, /optionsVerified=!!h\.options&&greeksVerified/);
  for (const id of ["gMarket", "gOptions", "gNews", "gGlobal", "dhPrice", "dhTick", "dhVolume", "dhOpt", "dhGreeks", "dhNews", "dhGlobal"]) {
    assert.ok(block.includes(`setGate('${id}'`), `missing render state for ${id}`);
  }
  assert.doesNotMatch(block, /setGate\('[^']+',!!h\.[a-zA-Z]+,'ON'\)/);
});