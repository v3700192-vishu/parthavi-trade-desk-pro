import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeSessionOpen } from '../marketCalendar.js';

test('NSE session is closed on the configured 2026-10-20 holiday even during market hours',()=>{
  assert.equal(exchangeSessionOpen('NSE',new Date('2026-10-20T06:00:00.000Z')),false);
});
test('NSE session is open on a normal weekday inside market hours',()=>{
  assert.equal(exchangeSessionOpen('NSE',new Date('2026-10-21T06:00:00.000Z')),true);
});
test('exchange session is closed on weekends and outside the regular time window',()=>{
  assert.equal(exchangeSessionOpen('NSE',new Date('2026-10-24T06:00:00.000Z')),false);
  assert.equal(exchangeSessionOpen('NSE',new Date('2026-10-21T10:15:00.000Z')),false);
});
test('operator-configured holidays close NSE session',()=>{
  const old=process.env.EXTRA_HOLIDAYS_IST;
  try {
    process.env.EXTRA_HOLIDAYS_IST='2026-10-21';
    assert.equal(exchangeSessionOpen('NSE',new Date('2026-10-21T06:00:00.000Z')),false);
  } finally {
    if(old===undefined) delete process.env.EXTRA_HOLIDAYS_IST; else process.env.EXTRA_HOLIDAYS_IST=old;
  }
});
test('BSE remains closed unless its calendar has been explicitly verified',()=>{
  const old=process.env.BSE_SESSION_VERIFIED;
  try {
    delete process.env.BSE_SESSION_VERIFIED;
    assert.equal(exchangeSessionOpen('BSE',new Date('2026-10-21T06:00:00.000Z')),false);
    process.env.BSE_SESSION_VERIFIED='true';
    assert.equal(exchangeSessionOpen('BSE',new Date('2026-10-21T06:00:00.000Z')),true);
  } finally {
    if(old===undefined) delete process.env.BSE_SESSION_VERIFIED; else process.env.BSE_SESSION_VERIFIED=old;
  }
});