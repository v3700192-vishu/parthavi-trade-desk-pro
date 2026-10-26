import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = readFileSync(path.join(root, "server.js"), "utf8");
const html = readFileSync(path.join(root, "public", "index.html"), "utf8");
const sw = readFileSync(path.join(root, "public", "sw.js"), "utf8");

test("analysis API exposes signed Fusion Score separately from technical confluence and 5M momentum", () => {
  assert.match(server, /fusionScore:fused\.score/);
  assert.match(server, /fusionDirection:fused\.direction/);
  assert.match(server, /technicalScore:techSigned/);
  assert.match(server, /technicalConfluence:Math\.round\(Math\.abs\(techSigned\)\)/);
  assert.match(server, /momentum5m,/);
});

test("decision UI labels and renders each metric separately", () => {
  assert.match(html, /Fusion Score \(signed\)/);
  assert.match(html, /Technical Confluence/);
  assert.match(html, /5M Momentum/);
  assert.match(html, /d\.fusionScore\?\?d\.fusion\?\.score/);
  assert.match(html, /id="technicalConfluence"/);
  assert.match(html, /id="fusionMomentum"/);
  assert.match(html, /id="fusionGateList"/);
  assert.doesNotMatch(html, /\$\('score'\)\.textContent=\(d\.score\?\?'-'\)\+' \/ 100'/);
});

test("safety gate and 67-point entry threshold remain mandatory", () => {
  assert.match(server, /if\(complete && score>=67 && noTradeReasons\.length===0\)/);
  assert.match(server, /fused\.hardGate=!complete\|\|noTradeReasons\.length>0/);
  assert.match(server, /greekRisk\.status==='PASS'/);
  assert.match(server, /eventStrat\.eventSafe===true/);
});

test("updated shell cache invalidates the old mobile UI cache", () => {
  assert.match(sw, /ptd-shell-v46/);
});

test("legacy analysis API bounds slow feeds and fails closed", () => {
  assert.match(server, /function boundedAnalysisFeed\(/);
  assert.match(server, /\[ANALYZE_TIMEOUT\]/);
  assert.match(server, /boundedAnalysisFeed\(\(\)=>sharedRefresh\('candles:'\+key\+':5m',\(\)=>loadTfSummary\(symbol,'FIVE_MINUTE',10\)\)/);
  assert.match(server, /boundedAnalysisFeed\(\(\)=>sharedRefresh\('option-greeks:'\+symbol\+':'\+opt\.expiry,\(\)=>liveOptionGreeks\(symbol,opt\.expiry\)\)/);
  assert.match(server, /boundedAnalysisFeed\(\(\)=>sharedRefresh\('futures-volume:'\+key,\(\)=>loadFuturesVolume\(symbol\)\)/);
});