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

test("mobile navigation attaches direct handlers and scrolls reliably in a WebView", () => {
  assert.ok(html.includes('id="MOBILE_NAV_REFRESH_RELIABILITY_V2"'));
  assert.match(html, /buttons\.forEach\(button=>\s*\{[\s\S]*?button\.addEventListener\('click'/);
  assert.match(html, /const targetTop=target\.getBoundingClientRect\(\)\.top\+\(root\.scrollTop\|\|window\.scrollY\|\|0\)/);
  assert.match(html, /root\.scrollTop=top/);
  assert.match(html, /html\.scrollTop=top/);
  assert.match(html, /target\.scrollIntoView\(true\)/);
  assert.match(html, /button\.addEventListener\('keydown'/);
});

test("Home button resets the document to the real top instead of measuring the sticky header", () => {
  const block = html.match(/const go=id=>\s*\{[\s\S]*?\n  \};/)?.[0] || "";
  assert.ok(block, "navigation go handler is present");
  const home = block.match(/if\(id==='home'\)\s*\{[\s\S]*?\n    \}/)?.[0] || "";
  assert.ok(home, "Home requires a dedicated scroll reset");
  assert.match(home, /root\.scrollTop=0/);
  assert.match(home, /html\.scrollTop=0/);
  assert.match(home, /body\.scrollTop=0/);
  assert.match(home, /window\.scrollTo\(0,0\)/);
  assert.match(home, /history\.replaceState\(null,'','#home'\)/);
  assert.doesNotMatch(home, /getBoundingClientRect\(\)\.top/);
});

test("mobile navigation targets are sized for touch and visibly labelled", () => {
  assert.match(html, /#bottomNav \.bottom-button\{[^}]*min-height:64px/);
  assert.match(html, /#bottomNav \.bottom-icon\{[^}]*font-size:22px/);
  assert.match(html, /#bottomNav \.bottom-label\{[^}]*font-size:12px/);
  assert.match(html, /#bottomNav\.bottom\{[^}]*z-index:60/);
});

test("mobile brand header and live prediction remain sticky during page scrolling", () => {
  assert.match(html, /\.app\{[^}]*overflow-x:clip!important;overflow-y:visible!important/);
  assert.match(html, /#home\.top\{position:sticky!important;top:4px!important;z-index:85!important\}/);
  assert.match(html, /#stickyPrediction\.sticky-prediction\{position:sticky!important;top:var\(--ptd-sticky-prediction-top,140px\)!important;z-index:84!important/);
  assert.match(html, /syncStickyPredictionOffset=\(\)=>\s*\{/);
  assert.match(html, /headerHeight\+12/);
  assert.match(html, /new ResizeObserver\(syncStickyPredictionOffset\)/);
  assert.match(html, /\.brand h1\{font-size:clamp\(18px,4\.5vw,20px\)!important/);
  assert.match(html, /white-space:normal!important;overflow-wrap:anywhere/);
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
  assert.match(serviceWorker, /const CACHE='ptd-shell-v8'/);
  assert.match(serviceWorker, /if\(u\.pathname\.startsWith\('\/api\/'\)\) return/);
  assert.doesNotMatch(serviceWorker, /const CACHE='ptd-shell-v[34567]'/);
});

test("Contract Finder opens a separate analysis panel with verified quote, liquidity and Greek metrics", () => {
  assert.match(html, /id="cfAnalysisPanel" class="contract-analysis-panel" hidden/);
  assert.match(html, /function renderContractAnalysis\(selected,analysisResponse,predictionResponse/);
  for (const label of ["LTP", "Bid / Ask", "Spread", "Open interest", "Traded volume", "Implied volatility", "Delta", "Theta", "Gamma", "Vega"]) {
    assert.ok(html.includes("label:'" + label + "'"), `missing analysis metric ${label}`);
  }
  assert.match(html, /UNVERIFIED values are not substituted with zero/);
  assert.match(html, /Why this decision\?/);
  assert.match(html, /multi-timeframe engine has not issued a CONFIRMED CALL\/PUT signal/);
  assert.match(html, /id="caRefreshBtn"/);
  assert.match(html, /id="caCloseBtn"/);
});

test("Analyse binds a selected contract by row index and requests exact exchange, segment, expiry, type and strike", () => {
  assert.match(html, /window\.contractFinderRows=rows/);
  assert.match(html, /data-contract-index=/);
  assert.match(html, /addEventListener\('click',\(\)=>\s*\{/);
  assert.match(html, /const q=new URLSearchParams\(\{exchange,segment,underlying,expiry:/);
  assert.match(html, /getJSON\('\/api\/contract\/analyze\?'/);
  assert.match(html, /getJSON\(predictionQuery\)/);
  assert.doesNotMatch(html, /onclick="analyseContract\('\+JSON\.stringify\(x\)/);
  assert.match(html, /tradeDecision=payload\.connected===true&&payload\.contractDataReady===true&&engineConfirmed/);
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