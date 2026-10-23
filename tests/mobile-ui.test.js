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
  assert.match(html, /const strictConfirmed=!marketClosed&&directionalGatePassed&&p\?\.commandCenterEligible===true&&state==='CONFIRMED'/);
  assert.match(html, /p\?\.exchangeTickVerified===true&&p\?\.feedComplete===true/);
  assert.match(html, /const setupScore=Number\(p\?\.modelConfidence\)\|\|0/);
  assert.match(html, /const rawDirectionalProbability=p\?\.directionalProbability;/);
  assert.doesNotMatch(html, /directionalProbability\?\?p\?\.directionalConfidence/);
  assert.match(html, /const rawDirectionalProbability=p\?\.directionalProbability;/);
  assert.doesNotMatch(html, /directionalProbability\?\?p\?\.directionalConfidence/);
  assert.match(html, /setupScore>=PTD_COMMAND_CENTER_CONFIDENCE/);
  assert.match(html, /NO TRADE • MARKET CLOSED/);
  assert.match(html, /WAIT • CANDIDATE ONLY/);
  assert.match(html, /NO TRADE • FINAL GATE FAILED/);
  assert.match(html, /This is not an OpenAI\/LLM model/);
});

const freeAdvisorSource = html.match(/function renderFreeAdvisor\(p,resp=\{\}\)\{[\s\S]*?\n\}/)?.[0] || "";
function renderFreeAdvisorForTest(prediction, response = {}) {
  const ids = ["freeAdvisorDecision","freeAdvisorReason","freeAdvisorState","freeAdvisorBadge","freeAdvisorContract","freeAdvisorContractMeta","freeAdvisorEntry","freeAdvisorSL","freeAdvisorT1","freeAdvisorT2","freeAdvisorConfidence","freeAdvisorChecks"];
  const nodes = Object.fromEntries(ids.map(id => [id, { textContent: "", className: "" }]));
  const render = vm.runInNewContext(freeAdvisorSource + "\nrenderFreeAdvisor", { $: id => nodes[id], PTD_FINAL_PLAN_CONFIDENCE: 70, PTD_ADVISOR_CONFIDENCE: 80, PTD_COMMAND_CENTER_CONFIDENCE: 90 });
  render(prediction, response);
  return nodes;
}

test("candidate contract scanner is single-flight, parallelizes independent quote/Greek reads, and has a bounded expiry scan", () => {
  const server = readFileSync(path.join(root, "server.js"), "utf8");
  assert.ok(server.includes("const optionPlanScanInflight=new Map();"));
  assert.ok(server.includes("findBuyableOptionPlanCoalesced"));
  assert.ok(server.includes("Promise.all([quoteInstruments(contracts),liveOptionGreeks(symbol,scanExpiry)])"));
  assert.ok(server.includes(")].slice(0,2);"));
  assert.ok(server.includes("boundedFeed(findBuyableOptionPlanCoalesced"));
  assert.ok(server.includes("const contractDisplayConfidence=directionalConfidence;"));
  assert.ok(server.includes("contractSetupScore>=70"));
  assert.ok(server.includes("contractDisplayConfidence>=68"));
  assert.ok(server.includes("prediction.directionalForecastEligible===true"));
  assert.ok(server.includes("Number(prediction.directionalProbability)>=68"));
  assert.match(server, /const rawDirectionalProbability=prediction\.directionalProbability/);
  assert.match(server, /const finalRawDirectionalProbability=prediction\.directionalProbability/);
  assert.doesNotMatch(server, /rawDirectionalProbability=prediction\.modelConfidence/);
  assert.ok(server.includes("prediction.finalPlanThreshold=70;"));
  assert.ok(server.includes("prediction.advisorEligible=Boolean("));
  assert.ok(server.includes("prediction.commandCenterEligible=Boolean("));
});
test("staged contract visibility thresholds are distinct and the Command Center requires 90% plus confirmation", () => {
  assert.ok(html.includes("const PTD_FINAL_PLAN_CONFIDENCE=70;"));
  assert.ok(html.includes("const PTD_ADVISOR_CONFIDENCE=80;"));
  assert.ok(html.includes("const PTD_COMMAND_CENTER_CONFIDENCE=90;"));
  assert.match(html, /const optionConfidence=setupScore/);
  assert.match(html, /const finalPlanVisible=!!optionPlan\?\.available&&optionConfidence>=PTD_FINAL_PLAN_CONFIDENCE&&directionalGatePassed/);
  assert.match(html, /const optionVisible=!!optionPlan\?\.available&&optionConfidence>=PTD_ADVISOR_CONFIDENCE&&directionalGatePassed/);
  assert.match(html, /const directionalGatePassed=directionalConfidence!==null&&directionalConfidence>=68/);
  assert.match(html, /const usable=directionalGatePassed && p\?\.commandCenterEligible===true/);
  assert.doesNotMatch(html, /directionalConfidence\?\?p\?\.modelConfidence|directionalConfidence\?\?conf/);
  assert.match(html, /Number\(p\?\.modelConfidence\)>=PTD_COMMAND_CENTER_CONFIDENCE/);
  assert.match(serviceWorker, new RegExp("const CACHE='ptd-shell-v[0-9]+'"));
  assert.doesNotMatch(serviceWorker, /const CACHE='ptd-shell-v21'/);
});
const stccCurrentPlanSource = html.match(/function stccCurrentPlan\(p\)\{[\s\S]*?\n\}/)?.[0] || "";
function stccCurrentPlanForTest(prediction) {
  const build = vm.runInNewContext(stccCurrentPlanSource + "\nstccCurrentPlan", {
    PTD_COMMAND_CENTER_CONFIDENCE: 90, symbol: "NIFTY"
  });
  return build(prediction);
}
test("Command Center surfaces a plan only at 90% final confidence and all 11 confirmations", () => {
  const plan = {
    signalState: "CONFIRMED", action: "CALL", prediction: "BULLISH",
    optionPlan: { available: true, candidateOnly: false, greekStatus: "PASS", contract: "NIFTYTESTCE", optionType: "CE", strike: 23000, lotSize: 65, entry: 35, stopLoss: 30, target1: 45, target2: 47.5 },
    directionalProbability: 75, directionalConfidence: 75,
    modelConfidence: 89, confirmationPct: 100, commandCenterEligible: true, feedComplete: true, exchangeTickVerified: true, eventSafe: true, noTradeReasons: [],
    confirmations: { trend:true, setup:true, trigger:true, momentum:true, volume:true, strength:true, options:true, greeks:true, news:true, global:true, eventSafe:true }
  };
  assert.equal(stccCurrentPlanForTest(plan), null, "89% must not show as a Command Center trade");
  assert.equal(stccCurrentPlanForTest({ ...plan, modelConfidence: 90, confirmationPct: 99 })?.contract||null, null, "one or more confirmations missing must stay blocked");
  assert.equal(stccCurrentPlanForTest({ ...plan, modelConfidence: 90, confirmationPct: 100, confirmations: { ...plan.confirmations, momentum:false } })?.contract||null, null, "momentum must pass for the Command Center");
  assert.equal(stccCurrentPlanForTest({ ...plan, modelConfidence: 90, confirmationPct: 100 })?.contract, "NIFTYTESTCE");
  assert.equal(stccCurrentPlanForTest({ ...plan, directionalProbability: null, directionalConfidence: null, modelConfidence: 90, confirmationPct: 100 })?.contract||null, null, "setup score alone cannot bypass the calibrated direction gate");
  assert.equal(stccCurrentPlanForTest({ ...plan, directionalProbability: null, directionalConfidence: 90, modelConfidence: 95, confirmationPct: 100 })?.contract||null, null, "legacy directional score cannot impersonate a calibrated probability");
});
test("AI Adviser can show an 80% directional candidate even if final gates keep the score at NO TRADE", () => {
  const candidate = renderFreeAdvisorForTest({
    signalState: "NO TRADE", action: "NO TRADE", prediction: "BULLISH",
    directionalProbability: 80, directionalConfidence: 80, modelConfidence: 72, confirmationPct: 73, exchangeTickVerified: true,
    optionPlan: { available: true, candidateOnly: false, greekStatus: "PASS", contract: "NIFTYTESTCE", optionType: "CE", strike: 23000, expiry: "19OCT2026", lotSize: 65, entry: 40, stopLoss: 32, target1: 56, target2: 60 },
    noTradeReasons: ["The 5M trigger has not passed."]
  }, { health: { marketOpen: true } });
  assert.match(candidate.freeAdvisorDecision.textContent, /NO TRADE • CONTRACT CANDIDATE/);
  assert.equal(candidate.freeAdvisorContract.textContent, "NIFTYTESTCE");
  assert.doesNotMatch(candidate.freeAdvisorDecision.textContent, /RECOMMENDED/);
});test("80% AI Adviser recommendation requires server-approved momentum-only exception", () => {
  const candidate = renderFreeAdvisorForTest({
    signalState: "WATCH", action: "NO TRADE", prediction: "BULLISH",
    directionalProbability: 82, directionalConfidence: 82, modelConfidence: 82, confirmationPct: 91,
    advisorEligible: true, commandCenterEligible: false,
    exchangeTickVerified: true, feedComplete: true, eventSafe: true,
    confirmations: { trend:true, setup:true, trigger:true, momentum:false, volume:true, strength:true, options:true, greeks:true, news:true, global:true, eventSafe:true },
    optionPlan: { available:true, candidateOnly:false, greekStatus:"PASS", contract:"NIFTYTESTCE", optionType:"CE", strike:23000, expiry:"19OCT2026", lotSize:65, entry:40, stopLoss:32, target1:56, target2:60 },
    noTradeReasons: []
  }, { health: { marketOpen: true } });
  assert.match(candidate.freeAdvisorDecision.textContent, /RECOMMENDED.*80\/100 SETUP SCORE ADVISER/);
  assert.equal(candidate.freeAdvisorContract.textContent, "NIFTYTESTCE");
  assert.match(candidate.freeAdvisorState.textContent, /MOMENTUM EXCEPTION/);
});
test("free advisor says RECOMMENDED only with a verified contract and every final gate", () => {
  const nodes = renderFreeAdvisorForTest({
    signalState: "CONFIRMED", action: "CALL", prediction: "BULLISH",
    optionPlan: { available: true, candidateOnly: false, greekStatus: "PASS", contract: "NIFTY19OCT2622500CE", optionType: "CE", strike: 22500, expiry: "19OCT2026", lotSize: 65, entry: 35, stopLoss: 30, target1: 45, target2: 47.5 },
    directionalProbability: 76, directionalConfidence: 76,
    commandCenterEligible: true, exchangeTickVerified: true, feedComplete: true, eventSafe: true, noTradeReasons: [],
    confirmations: { trend:true, setup:true, trigger:true, momentum:true, volume:true, strength:true, options:true, greeks:true, news:true, global:true, eventSafe:true },
    modelConfidence: 92, confirmationPct: 100, reasoning: "All eleven required checks passed."
  }, { health: { marketOpen: true } });
  assert.match(nodes.freeAdvisorDecision.textContent, /RECOMMENDED/);
  assert.equal(nodes.freeAdvisorContract.textContent, "NIFTY19OCT2622500CE");
  assert.equal(nodes.freeAdvisorEntry.textContent, "₹35.00");
});

test("80% directional confidence can display a risk-blocked contract candidate only as NO TRADE", () => {
  const candidate = renderFreeAdvisorForTest({
    signalState: "NO TRADE", action: "NO TRADE", prediction: "BULLISH",
    directionalProbability: 80, directionalConfidence: 80, modelConfidence: 72, confirmationPct: 73, exchangeTickVerified: true,
    optionPlan: { available: true, candidateOnly: true, greekStatus: "NO TRADE", contract: "NIFTY19OCT2623050CE", optionType: "CE", strike: 23050, expiry: "19OCT2026", lotSize: 65, entry: 74.45, stopLoss: 60, target1: 103.35, target2: 110.58 },
    noTradeReasons: ["Theta exceeds the configured safety limit."]
  }, { health: { marketOpen: true } });
  assert.match(candidate.freeAdvisorDecision.textContent, /NO TRADE • CONTRACT CANDIDATE/);
  assert.equal(candidate.freeAdvisorContract.textContent, "NIFTY19OCT2623050CE");
  assert.match(candidate.freeAdvisorContractMeta.textContent, /ANALYSIS ONLY • NO TRADE/);
  assert.doesNotMatch(candidate.freeAdvisorDecision.textContent, /RECOMMENDED/);

  const underThreshold = renderFreeAdvisorForTest({
    signalState: "NO TRADE", action: "NO TRADE", prediction: "BULLISH",
    directionalConfidence: 77, modelConfidence: 72, confirmationPct: 73, exchangeTickVerified: true,
    optionPlan: { available: true, candidateOnly: true, greekStatus: "NO TRADE", contract: "NIFTY19OCT2623050CE", entry: 74.45 }
  }, { health: { marketOpen: true } });
  assert.equal(underThreshold.freeAdvisorContract.textContent, "—");
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
    directionalProbability: 80, directionalConfidence: 80,
    exchangeTickVerified: true, feedComplete: true, modelConfidence: 80, confirmationPct: 73
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
  assert.match(serviceWorker, /const CACHE='ptd-shell-v42'/);
  assert.match(serviceWorker, /prediction-report\.html/);
  assert.match(serviceWorker, /if\(u\.pathname\.startsWith\('\/api\/'\)\) return/);
  assert.doesNotMatch(serviceWorker, /const CACHE='ptd-shell-v3[0-6]'/);
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
  assert.match(html, /backupVerified=indexCfg\.configured===true&&futCfg\.configured===true&&indexBackupVerified&&futuresBackupVerified/);
  assert.match(html, /CONFIGURED — NOT VERIFIED/);
  assert.match(block, /gateText\s*=\s*\(ok\)\s*=>\s*ok\s*\?\s*'ON'\s*:\s*'OFF'/);
  assert.match(block, /priceVerified=!!h\.market&&tickVerified/);
  assert.match(block, /marketGate=priceVerified&&volumeVerified/);
  assert.match(block, /optionsVerified=!!h\.options&&greeksVerified/);
  for (const id of ["gMarket", "gOptions", "gNews", "gGlobal", "dhPrice", "dhTick", "dhVolume", "dhOpt", "dhGreeks", "dhNews", "dhGlobal"]) {
    assert.ok(block.includes(`setGate('${id}'`), `missing render state for ${id}`);
  }
  assert.doesNotMatch(block, /setGate\('[^']+',!!h\.[a-zA-Z]+,'ON'\)/);
});

test("Global Risk ticker uses verified API state and refreshes instead of staying at WAIT", async () => {
  assert.match(html, /id="globalRisk" class="wait">WAIT<\/strong>/);
  assert.match(html, /id="GLOBAL_RISK_LIVE_BINDING_V1"/);
  assert.match(html, /fetch\('\/api\/global\?ts='\+Date\.now\(\)/);
  assert.match(html, /payload\.connected!==true\|\|strategy\.connected!==true\|\|freshInputs<1/);
  assert.match(html, /allowed=\['RISK-ON','RISK-OFF','MIXED'\]/);
  assert.match(html, /setInterval\(refreshGlobalRisk,15000\)/);
  assert.match(html, /Global-risk response is older than 2 minutes/);
  assert.match(html, /Secondary risk modifier only; not a standalone CALL\/PUT signal/);

  let payload = {
    connected: true,
    strategy: { connected: true, freshInputs: 8, liveInputs: 6, delayedInputs: 2, bias: "RISK-OFF", score: -21.6, reason: "Fresh inputs available." },
    checkedAt: new Date().toISOString()
  };
  const el = {
    textContent: "WAIT", className: "wait", style: {}, dataset: {}, attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; }
  };
  const intervals = [];
  const document = {
    hidden: false, readyState: "complete",
    getElementById(id) { return id === "globalRisk" ? el : null; },
    addEventListener() {}
  };
  const context = {
    document, window: {}, Date, Number, String, Math,
    AbortSignal: { timeout: () => ({}) },
    fetch: async (url) => {
      assert.match(url, /\/api\/global\?ts=/);
      return { ok: true, json: async () => payload };
    },
    setInterval(fn, ms) { intervals.push(ms); return intervals.length; }
  };
  const inline = html.match(/<script id="GLOBAL_RISK_LIVE_BINDING_V1">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inline, "live global-risk updater script is present");
  vm.runInNewContext(inline, context);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(el.textContent, "RISK-OFF -21.6");
  assert.equal(el.dataset.globalRiskState, "RISK-OFF");
  assert.match(el.title, /Fresh inputs: 8/);
  assert.ok(intervals.includes(15000), "risk state refreshes every 15 seconds");

  payload = {
    connected: false,
    strategy: { connected: false, freshInputs: 0, bias: "WAIT", score: 0, reason: "No fresh verified global inputs." }
  };
  await context.window.refreshGlobalRisk();
  assert.equal(el.textContent, "WAIT");
  assert.match(el.title, /No fresh verified global inputs/);
});

test("Phase 10 shows forward 5M/15M probabilities separately from setup confluence score", () => {
  for (const id of ["p10ForwardForecast", "p10ForecastUp5", "p10ForecastDown5", "p10ForecastRange5", "p10ForecastUp15", "p10ForecastDown15", "p10ForecastRange15", "p10ForecastStatus"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing forecast field " + id);
  }
  assert.match(html, /function renderForwardForecast\(forecast,movement,decision,marketOpenFlag\)/);
  assert.match(html, /Setup confluence score • not probability/);
  assert.match(html, /historical analogue estimates/i);
  assert.match(html, /Not an entry signal or an option-premium win rate/);
});

test("Phase 10 has a chart-only action panel with direction, guarded timing and invalidation", () => {
  for (const id of ["p10ChartDecision", "p10DecisionFreshness", "p10ChartBias", "p10ChartDirection", "p10ChartProbability", "p10ChartPrice", "p10ChartDrivers", "p10ChartAction", "p10ChartActionReason", "p10ChartEntryTime", "p10ChartExpiryTime", "p10ChartInvalidation"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing chart decision field " + id);
  }
  assert.match(html, /function renderForwardForecast\(forecast,movement,decision,marketOpenFlag\)/);
  assert.match(html, /WAIT — VERIFY LIVE FEED/);
  assert.match(html, /NO ENTRY TIME — WAIT/);
  assert.match(html, /No order is placed by this panel/);
  assert.match(html, /Cancel if the 5M trigger reverses/);
});

test("Phase 10 renders the trade timing and signal-expiry panel", () => {
  for (const id of ["p10TradeTiming", "p10TimingDecision", "p10TimingSignal", "p10TimingEntry", "p10TimingExpiry", "p10TimingTier", "p10TimingReason"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing timing field " + id);
  }
  assert.match(html, /const timing=p\?\.tradeTiming\|\|\{\}/);
  assert.match(html, /timeZone:'Asia\/Kolkata'/);
  assert.match(html, /timingDecision==='ENTRY READY'/);
  assert.match(html, /Setup score \/100: 70 = scan tier • 80 = adviser review • 90\+ = final-gate review/);
});

test("chart analysis UI shows candle-pattern analysis across 5M, 15M and 1H without presenting it as probability", () => {
  assert.match(html, /id="p10ChartPattern"/);
  assert.match(html, /const byTf=p\.chartAnalysisByTimeframe\|\|\{'5M':analysis\}/);
  assert.match(html, /Higher-TF pattern adjustment/);
  assert.match(html, /bounded confluence points, not probability/);
  assert.ok(html.includes("currentSessionHourConfirmed===false"));
  assert.ok(html.includes("1H HISTORICAL / WAIT"));
  assert.ok(html.includes("p.h1TrendStatus"));
});