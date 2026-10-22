import test from "node:test";
import assert from "node:assert/strict";
import { buildForwardForecast } from "../forwardForecast.js";

function makeCandles(count=260) {
  const rows=[];
  let close=22000;
  for(let i=0;i<count;i++){
    // Deterministic mixed regime with trend, pullbacks and different candle ranges.
    const step=Math.sin(i*0.47)*8 + Math.cos(i*0.13)*3 + (i%90<45?1.2:-0.8);
    const next=close+step;
    const high=Math.max(close,next)+4+(i%4);
    const low=Math.min(close,next)-3-(i%3);
    rows.push({t:new Date(Date.UTC(2026,0,1,3,45+i*5)).toISOString(),o:close,h:high,l:low,c:next,v:1000+(i%11)*50});
    close=next;
  }
  return rows;
}

test("directional percentages stay hidden unless the walk-forward calibration passes 68% with enough signals",()=>{
  const forecast=buildForwardForecast(makeCandles());
  assert.equal(forecast.model,"HISTORICAL_ANALOGUE_V1");
  assert.equal(forecast.historyAvailable,true);
  for(const horizon of [forecast.horizons["5"],forecast.horizons["15"]]){
    assert.equal(horizon.historyAvailable,true);
    assert.ok(horizon.sampleSize>=24);
    assert.ok(horizon.calibration);
    if(horizon.available){
      assert.equal(horizon.calibration.eligible,true);
      assert.ok(horizon.calibration.outOfSampleHitRate>=68);
      assert.ok(horizon.calibration.highConfidenceDirectionalSignals>=30);
      assert.ok(horizon.leadingProbability>=68);
      assert.equal(horizon.probabilities.up+horizon.probabilities.down+horizon.probabilities.sideways,100);
      assert.ok(["UPWARD BIAS","DOWNWARD BIAS"].includes(horizon.direction));
    }else{
      assert.equal(horizon.probabilities,null);
      assert.equal(horizon.direction,"UNVERIFIED / WAIT");
      assert.ok(horizon.reason);
    }
    assert.ok(horizon.asOf);
  }
});

test("forward forecast refuses to manufacture percentages when history is insufficient",()=>{
  const forecast=buildForwardForecast(makeCandles(28));
  assert.equal(forecast.available,false);
  assert.equal(forecast.horizons["5"].available,false);
  assert.equal(forecast.horizons["5"].probabilities,null);
  assert.equal(forecast.horizons["15"].probabilities,null);
});

test("live forward forecast is withheld after market close or when the latest candle is stale",()=>{
  const rows=makeCandles();
  const closed=buildForwardForecast(rows,{marketOpen:false});
  assert.equal(closed.available,false);
  assert.equal(closed.horizons["15"].probabilities,null);
  const stale=buildForwardForecast(rows,{marketOpen:true});
  assert.equal(stale.available,false);
  assert.match(stale.horizons["5"].reason,/stale|timestamp/i);
});

test("live forward forecast requires a fresh timestamp but accepts a fresh completed candle",()=>{
  const rows=makeCandles();
  rows[rows.length-1].t=new Date(Date.now()-6*60_000).toISOString();
  const forecast=buildForwardForecast(rows,{marketOpen:true});
  assert.equal(forecast.historyAvailable,true);
  assert.equal(forecast.horizons["5"].historyAvailable,true);
});

test("forecast uses the latest completed candle timestamp as its as-of marker",()=>{
  const rows=makeCandles();
  const forecast=buildForwardForecast(rows);
  assert.equal(forecast.asOf,rows.at(-1).t);
  assert.equal(forecast.horizons["15"].asOf,rows.at(-1).t);
  assert.match(forecast.interpretation,/not option-premium profit probability/i);
});
