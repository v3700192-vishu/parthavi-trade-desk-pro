import test from "node:test";
import assert from "node:assert/strict";
import { isLightExpiryCurrentOrFuture } from "../angelone.js";

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
function istExpiryLabel(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const base = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + offsetDays));
  return String(base.getUTCDate()).padStart(2, "0") +
    MONTHS[base.getUTCMonth()] + base.getUTCFullYear();
}

test("live option finder accepts the current IST expiry and later expiries", () => {
  assert.equal(isLightExpiryCurrentOrFuture(istExpiryLabel(0)), true);
  assert.equal(isLightExpiryCurrentOrFuture(istExpiryLabel(1)), true);
  assert.equal(isLightExpiryCurrentOrFuture(istExpiryLabel(90)), true);
});

test("live option finder rejects expired or malformed contract expiries", () => {
  assert.equal(isLightExpiryCurrentOrFuture(istExpiryLabel(-1)), false);
  assert.equal(isLightExpiryCurrentOrFuture("13OCT2026", Date.parse("2026-10-15T10:42:00+05:30")), false);
  assert.equal(isLightExpiryCurrentOrFuture("31FEB2027"), false);
  assert.equal(isLightExpiryCurrentOrFuture(""), false);
});