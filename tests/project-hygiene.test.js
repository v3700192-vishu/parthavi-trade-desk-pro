import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function collectBackupFiles(directory, relativeTo) {
  const found = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) found.push(...collectBackupFiles(absolute, relativeTo));
    else if (item.isFile() && /\.bak(?:$|[-_.])/i.test(item.name)) {
      found.push(path.relative(relativeTo, absolute));
    }
  }
  return found;
}

test("published public assets never contain local backup snapshots", () => {
  const publicDir = path.join(projectRoot, "public");
  const backupFiles = collectBackupFiles(publicDir, projectRoot);
  assert.deepEqual(
    backupFiles,
    [],
    "Backup snapshots must stay outside public/ because the Express server and release workflow publish that directory."
  );
});

test("GitHub Pages workflow publishes the canonical public directory", () => {
  const workflow = fs.readFileSync(
    path.join(projectRoot, ".github", "workflows", "deploy.yml"),
    "utf8"
  );
  assert.match(workflow, /path:\s*\.\/public\b/);
});

test("Electron bundle includes every direct local module imported by the backend", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8").replace(/^\uFEFF/, "")
  );
  const serverSource = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
  const localImports = [...serverSource.matchAll(/from\s*["'](\.\/[^"']+)["']/g)]
    .map((match) => match[1].slice(2));
  const packagedFiles = new Set(pkg.build.files);
  const missing = localImports.filter((file) => !packagedFiles.has(file));
  assert.deepEqual(
    missing,
    [],
    "Electron build is missing backend modules: " + missing.join(", ")
  );
});

test("cold-start candle backfill does not wait for the next candle close and aligns bars to 09:15 IST", () => {
  const serverSource = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
  const match = serverSource.match(/function bucketStart\(ts, minutes\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, "server.js must define the shared candle bucket alignment helper");
  const bucketStart = vm.runInNewContext("(" + match[0] + ")");
  const asIso = (stamp, minutes) => new Date(bucketStart(stamp, minutes)).toISOString();

  // 09:39 IST belongs to the 09:30 15M bar; 10:14 belongs to the 09:15 1H bar.
  assert.equal(asIso("2026-10-12T04:09:00.000Z", 15), "2026-10-12T04:00:00.000Z");
  assert.equal(asIso("2026-10-12T04:44:00.000Z", 60), "2026-10-12T03:45:00.000Z");
  // At 10:15 IST a new hourly bar begins, aligned to the exchange session.
  assert.equal(asIso("2026-10-12T04:45:00.000Z", 60), "2026-10-12T04:45:00.000Z");

  assert.ok(serverSource.includes("start=new Date(end.getTime()-29*86400000)"),
    "index candle history uses a rolling 30-calendar-day lookback");
  assert.ok(serverSource.includes("?interval=5m&range=1mo"),
    "Yahoo last-resort fallback also requests a month of five-minute history");
  assert.ok(serverSource.includes("interval==='ONE_HOUR'?{trendFast:8,trendSlow:20}:{}"),
    "one-hour trend keeps its explicit EMA pair on the aggregated 5-minute history");
  assert.ok(serverSource.includes("'candles-5m',12000"),
    "the first historical candle fetch must not silently time out at the old 2.8s limit");
  assert.ok(serverSource.includes("'candles-15m',12000"));
});

test("data-health freshness uses the latest completed candle, not a forming 5M candle", () => {
  const serverSource = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
  const bucket = serverSource.match(/function bucketStart\(ts, minutes\)\s*\{[\s\S]*?\n\}/)?.[0];
  const drop = serverSource.match(/function dropIncompleteCandle\(rows, minutes, now=new Date\(\)\)\s*\{[\s\S]*?\n\}/)?.[0];
  assert.ok(bucket && drop, "completed-candle helpers must exist");
  const filterCompleted = vm.runInNewContext(bucket + "\n" + drop + "\ndropIncompleteCandle");
  const rows = [
    { t: "2026-10-23T04:30:00.000Z", o: 100, h: 102, l: 99, c: 101 },
    { t: "2026-10-23T04:35:00.000Z", o: 101, h: 103, l: 100, c: 102 }
  ];
  const completed = filterCompleted(rows, 5, "2026-10-23T04:39:00.000Z");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].t, "2026-10-23T04:30:00.000Z");
  assert.ok(serverSource.includes("const rows=dropIncompleteCandle(sourceRows,5);"),
    "data-health must assess only completed provider candles");
});

test("legacy analysis waits for a complete current-session 1H candle before passing trend", () => {
  const serverSource = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
  assert.ok(serverSource.includes("currentSessionHourConfirmed===true"));
  assert.ok(serverSource.includes("currentSessionHourConfirmed===false?'WAIT'"));
  assert.ok(serverSource.includes("h1TrendVerified&&exchangeTickVerified"));
  assert.ok(serverSource.includes("WAIT - FIRST 1H CANDLE CLOSE"));
});

test("reconnected Angel One bypasses an offline fallback cache immediately", () => {
  const serverSource = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
  const match = serverSource.match(/async function loadBase5m\(symbol\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, "loadBase5m must exist");
  assert.match(match[0], /retryAfterReconnect=angelStatus\(\)\.connected/);
  assert.match(match[0], /candleOfflineRetry\.delete\(key\);candleRetryAfter\.delete\(key\)/);
  assert.match(match[0], /!retryAfterReconnect/);
  assert.ok(match[0].indexOf("if(retryAfterReconnect)") < match[0].indexOf("if(cached && now-cached.at<5*60*1000"),
    "fallback cache invalidation must precede the cache early return");
});

test("unknown candle volume stays unknown after timeframe aggregation and blocks VWAP", () => {
  const serverSource = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
  const bucket = serverSource.match(/function bucketStart\(ts, minutes\)\s*\{[\s\S]*?\n\}/)?.[0];
  const aggregate = serverSource.match(/function aggregateCandles\(rows, minutes\)\s*\{[\s\S]*?\n\}/)?.[0];
  const vwapFn = serverSource.match(/function vwap\(rows\)\s*\{[\s\S]*?\n\}/)?.[0];
  assert.ok(bucket && aggregate && vwapFn, "candle alignment, aggregation and VWAP helpers must exist");
  const aggregateCandles = vm.runInNewContext(bucket + "\n" + aggregate + "\naggregateCandles");
  const vwap = vm.runInNewContext(vwapFn + "\nvwap");
  const common = { h: 102, l: 98, o: 100, c: 101 };
  const unknown = aggregateCandles([
    { ...common, t: "2026-10-12T03:45:00.000Z", v: 100 },
    { ...common, t: "2026-10-12T03:50:00.000Z", v: null }
  ], 15);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].v, null);
  assert.equal(vwap([{ ...common, v: 100 }, { ...common, v: null }]), null);
  const known = aggregateCandles([
    { ...common, t: "2026-10-12T03:45:00.000Z", v: 100 },
    { ...common, t: "2026-10-12T03:50:00.000Z", v: 200 }
  ], 15);
  assert.equal(known[0].v, 300);
});

test("historical cooldown still checks the independent provider before serving fallback candles", () => {
  const serverSource = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
  const match = serverSource.match(/async function loadBase5m\(symbol\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  assert.ok(match, "loadBase5m must exist");
  const cooldownBranch = match.indexOf("if(now<(candleRetryAfter.get(key)||0))");
  const alternateAttempt = match.indexOf("loadUpstoxIndexFallback(key,start,end)", cooldownBranch);
  assert.ok(match.includes("retryAlternate=cachedIsUntrusted&&upstoxConfigured"));
  assert.ok(cooldownBranch >= 0 && alternateAttempt > cooldownBranch,
    "historical throttle cooldown must still try the independent provider before cached fallback");
  assert.ok(serverSource.includes("async function loadUpstoxIndexFallback(key,start,end)"));
  assert.ok(serverSource.includes("const candleAlternateRetryAfter=new Map()"));
});

test("stale historical fallback marker does not accumulate across repeated retries", () => {
  const serverSource = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
  assert.match(serverSource, /const staleBaseSource=\(base\.startsWith\('ANGEL'\)/);
  assert.match(serverSource, /base\.split\(\/STALE CACHE\/i\)\[0\]\.replace\(/);
  assert.ok(serverSource.includes("+' [STALE CACHE]'"),
    "the stale-cache marker should be normalized and added only once");
});

test("historical API pacing waits after each response and keeps shared throttle cooldown", () => {
  const angelSource = fs.readFileSync(path.join(projectRoot, "angelone.js"), "utf8");
  assert.match(angelSource, /finally\s*\{\s*\/\/ Enforce a quiet interval after each response[\s\S]*?historicalNextRequestAt=Math\.max\(historicalNextRequestAt,Date\.now\(\)\+HISTORICAL_MIN_GAP_MS\)/);
  assert.match(angelSource, /const rateRejected=\/HTTP 429\|Access denied\|too many requests\|rate\.\?limit\|exceeding access rate\/i\.test\(message\)/);
  assert.match(angelSource, /const cooldown=rateRejected\?\(isRenderMemoryLimitedRuntime\(\)\?15\*60\*1000:5\*60\*1000\):60\*1000/);
  assert.match(angelSource, /const providerMessage=String\(out\.message\|\|out\.error\|\|''\)\.trim\(\)/);
  assert.match(angelSource, /HISTORICAL_COOLDOWN_ACTIVE: retry in/);
  assert.match(angelSource, /const detail=String\(rawBody\|\|''\)\.trim\(\)\.replace\(\/\\s\+\/g,' '\)\.slice\(0,180\)/);
  assert.match(angelSource, /historicalRequestQueue=job\.then\(\(\)=>undefined,\(\)=>undefined\)/);
  assert.ok(angelSource.includes("if(wait>HISTORICAL_MIN_GAP_MS)"),
    "a provider throttle cooldown must fail fast instead of leaving chart requests pending for minutes");
});