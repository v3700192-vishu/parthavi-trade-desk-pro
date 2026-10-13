import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "public", "index.html"), "utf8");
const serviceWorker = readFileSync(path.join(root, "public", "sw.js"), "utf8");

test("full app refresh control is visible in the header and reloads the current app once", () => {
  assert.match(html, /id="appRefreshBtn"[^>]*aria-label="Refresh the entire app"/);
  assert.match(html, /id="APP_FULL_REFRESH_V1"/);
  assert.match(html, /button\.disabled=true/);
  assert.match(html, /window\.location\.reload\(\)/);
  assert.match(html, /window\.location\.href=window\.location\.href/);
  assert.match(html, /\.app-refresh-label\{display:none\}/);
});

test("live India clock stays above full-app refresh and updates on second boundaries", () => {
  assert.ok(html.includes('id="APP_LIVE_CLOCK_V1"'));
  assert.ok(html.includes('id="appLiveClock"'));
  assert.ok(html.includes('id="appLiveDate"'));
  assert.ok(html.includes("timeZone:'Asia/Kolkata'"));
  assert.ok(html.includes("second:'2-digit'"));
  assert.ok(html.includes("setTimeout(tick,1000-(Date.now()%1000))"));
  assert.ok(html.includes('visibilitychange'));
  assert.ok(html.includes('.refresh-stack{display:flex;') && html.includes('flex-direction:column'));
  assert.ok(html.indexOf('id="appLiveClock"') < html.indexOf('id="appRefreshBtn"'), "clock must appear above the refresh control");
});

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

test("free smart advisor gives a buy recommendation only when every final live gate and option plan is verified", () => {
  assert.match(html, /id="freeSmartAdvisor"/);
  assert.match(html, /id="freeAdvisorDecision"/);
  assert.match(html, /function renderFreeAdvisor\(p,resp=\{\}\)/);
  assert.match(html, /const strictConfirmed=!marketClosed&&state==='CONFIRMED'/);
  assert.match(html, /p\?\.exchangeTickVerified===true&&p\?\.feedComplete===true/);
  assert.match(html, /Number\(p\?\.modelConfidence\)>=78&&Number\(p\?\.confirmationPct\)>=80/);
  assert.match(html, /NO TRADE • MARKET CLOSED/);
  assert.match(html, /WAIT • CANDIDATE ONLY/);
  assert.match(html, /NO TRADE • FINAL GATE FAILED/);
  assert.match(html, /This is not an OpenAI\/LLM model/);
});

const freeAdvisorSource = html.match(/function renderFreeAdvisor\(p,resp=\{\}\)\{[\s\S]*?\n\}/)?.[0] || "";
function renderFreeAdvisorForTest(prediction, response = {}) {
  const ids = ["freeAdvisorDecision","freeAdvisorReason","freeAdvisorState","freeAdvisorBadge","freeAdvisorContract","freeAdvisorContractMeta","freeAdvisorEntry","freeAdvisorSL","freeAdvisorT1","freeAdvisorT2","freeAdvisorConfidence","freeAdvisorChecks"];
  const nodes = Object.fromEntries(ids.map(id => [id, { textContent: "", className: "" }]));
  const render = vm.runInNewContext(freeAdvisorSource + "\nrenderFreeAdvisor", { $: id => nodes[id] });
  render(prediction, response);
  return nodes;
}

test("free advisor says RECOMMENDED only with a verified contract and every final gate", () => {
  const nodes = renderFreeAdvisorForTest({
    signalState: "CONFIRMED", action: "CALL", prediction: "BULLISH",
    optionPlan: { available: true, contract: "NIFTY13OCT2622500CE", optionType: "CE", strike: 22500, expiry: "13OCT2026", lotSize: 65, entry: 35, stopLoss: 30, target1: 45, target2: 47.5 },
    exchangeTickVerified: true, feedComplete: true, modelConfidence: 84, confirmationPct: 82,
    reasoning: "All required checks passed."
  }, { health: { marketOpen: true } });
  assert.match(nodes.freeAdvisorDecision.textContent, /RECOMMENDED/);
  assert.equal(nodes.freeAdvisorContract.textContent, "NIFTY13OCT2622500CE");
  assert.equal(nodes.freeAdvisorEntry.textContent, "₹35.00");
});

test("free advisor blocks a confirmed direction when the exchange tick or final gate is missing", () => {
  const nodes = renderFreeAdvisorForTest({
    signalState: "CONFIRMED", action: "CALL", prediction: "BULLISH",
    optionPlan: { available: true, contract: "TESTCE", entry: 35, stopLoss: 30, target1: 45, target2: 47.5 },
    exchangeTickVerified: false, feedComplete: true, modelConfidence: 84, confirmationPct: 82
  }, { health: { marketOpen: true } });
  assert.match(nodes.freeAdvisorDecision.textContent, /NO TRADE • FINAL GATE FAILED/);
  assert.equal(nodes.freeAdvisorContract.textContent, "—");
});

test("free advisor treats WATCH as candidate-only and keeps the market-closed state at NO TRADE", () => {
  const candidate = renderFreeAdvisorForTest({
    signalState: "WATCH", action: "NO TRADE", prediction: "BEARISH",
    optionPlan: { available: true, contract: "TESTPE", optionType: "PE", strike: 22000, expiry: "13OCT2026", lotSize: 65, entry: 35, stopLoss: 30, target1: 45, target2: 47.5 },
    exchangeTickVerified: true, feedComplete: true, modelConfidence: 79, confirmationPct: 73
  }, { health: { marketOpen: true } });
  assert.match(candidate.freeAdvisorDecision.textContent, /WAIT • CANDIDATE ONLY/);
  assert.match(candidate.freeAdvisorContractMeta.textContent, /CANDIDATE ONLY/);
  const closed = renderFreeAdvisorForTest({ signalState: "NO TRADE", action: "NO TRADE", modelConfidence: 54, confirmationPct: 9 }, { mode: "OFF_SESSION_FAST_PATH", health: { marketOpen: false } });
  assert.match(closed.freeAdvisorDecision.textContent, /NO TRADE • MARKET CLOSED/);
});

test("Prediction Report is a compact header link opening a dedicated page", () => {
  const reportPage = readFileSync(path.join(root, "public", "prediction-report.html"), "utf8");
  assert.match(html, /class="prediction-report-link" href="\/prediction-report\.html"/);
  assert.match(html, />▤ Prediction Report<\/a>/);
  assert.match(reportPage, /<h1>Prediction Report<\/h1>/);
  assert.match(reportPage, /fetch\(API_BASE\+'\/api\/prediction-report'/);
  assert.match(reportPage, /AMBIGUOUS/);
  assert.match(reportPage, /not option-premium P&amp;L/i);
});

test("chart separates the live quote from closed candle OHLC and does not display false zero index volume", () => {
  assert.match(html, /window\.__chartLiveQuote=\{symbol:quoteSymbol,ltp,receivedAt:Date\.now\(\)/);
  assert.match(html, /const showLiveQuote=!!quote/);
  assert.match(html, /candleClose=Number\(last\.c\),lp=liveLtp\?\?candleClose/);
  assert.match(html, /const volumeLabel=hasVolume\?Number\(last\.v\|\|0\)\.toLocaleString\('en-IN'\):'—'/);
  assert.match(html, /if\(chartIndicators\.volume&&hasVolume\)/);
  assert.match(html, /INDEX VOLUME N\/A/);
});

test("chart reports stale candle fallback and preserves selected historical day during auto-refresh", () => {
  const block = html.match(/async function refreshLiveChart\(\)\{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(block, /HISTORICAL FETCH FAILED/);
  assert.match(block, /YAHOO FALLBACK • NOT BROKER-VERIFIED/);
  assert.match(block, /LAST CLOSED BAR/);
  assert.doesNotMatch(block, /chartDay=''/);
});

test("service-worker cache version is bumped and never caches live API responses", () => {
  assert.match(serviceWorker, /const CACHE='ptd-shell-v17'/);
  assert.match(serviceWorker, /prediction-report\.html/);
  assert.match(serviceWorker, /if\(u\.pathname\.startsWith\('\/api\/'\)\) return/);
  assert.doesNotMatch(serviceWorker, /const CACHE='ptd-shell-v[345678]'/);
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
  assert.ok(card.includes('id="dhHistorySource"'), "historical candle source must be shown");
  assert.ok(card.includes('id="dhHistoryDetail"'), "historical provider errors and candle age must be shown");
  assert.ok(card.includes('id="dhAltProvider"'), "independent provider readiness must be shown");
  assert.match(html, /HISTORICAL_PROVIDER_HEALTH_V1/);
  assert.match(html, /\/api\/data-health\?symbol=/);
  assert.match(html, /__updatedAt:Date\.now\(\)/);
  assert.match(block, /gateText\s*=\s*\(ok\)\s*=>\s*ok\s*\?\s*'ON'\s*:\s*'OFF'/);
  assert.match(block, /priceVerified=!!h\.market&&tickVerified/);
  assert.match(block, /marketGate=priceVerified&&volumeVerified/);
  assert.match(block, /optionsVerified=!!h\.options&&greeksVerified/);
  for (const id of ["gMarket", "gOptions", "gNews", "gGlobal", "dhPrice", "dhTick", "dhVolume", "dhOpt", "dhGreeks", "dhNews", "dhGlobal"]) {
    assert.ok(block.includes(`setGate('${id}'`), `missing render state for ${id}`);
  }
  assert.doesNotMatch(block, /setGate\('[^']+',!!h\.[a-zA-Z]+,'ON'\)/);
});