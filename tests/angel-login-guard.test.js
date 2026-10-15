import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { angelStatus } from '../angelone.js';
import { saveSecureRefreshToken, loadSecureRefreshToken, deleteSecureRefreshToken, hasSecureRefreshToken,
  saveSecureFeedToken, loadSecureFeedToken, deleteSecureFeedToken, hasSecureFeedToken } from '../angelSessionVault.js';
import os from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(root, 'server.js'), 'utf8');
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');

// The hosted Windows Actions runner's disposable profile can hang inside DPAPI; exercise this OS-bound integration test on the actual Kiran PC instead.
test('Windows DPAPI vault encrypts and restores a dummy token without storing plaintext', { skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS === 'true' }, () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'ptd-vault-test-'));
  const file = join(dir, 'refresh.dpapi');
  const feedFile = join(dir, 'feed.dpapi');
  const dummy = 'UNIT-TEST-NOT-A-REAL-ANGEL-REFRESH-TOKEN';
  const dummyFeed = 'UNIT-TEST-NOT-A-REAL-ANGEL-FEED-TOKEN';
  try {
    assert.equal(saveSecureRefreshToken(dummy, file), true);
    assert.equal(hasSecureRefreshToken(file), true);
    assert.notEqual(readFileSync(file, 'utf8').trim(), dummy);
    assert.equal(loadSecureRefreshToken(file), dummy);
    assert.equal(saveSecureFeedToken(dummyFeed, feedFile), true);
    assert.equal(hasSecureFeedToken(feedFile), true);
    assert.notEqual(readFileSync(feedFile, 'utf8').trim(), dummyFeed);
    assert.equal(loadSecureFeedToken(feedFile), dummyFeed);
    assert.equal(deleteSecureFeedToken(feedFile), true);
    assert.equal(loadSecureFeedToken(feedFile), null);
    assert.equal(deleteSecureRefreshToken(file), true);
    assert.equal(loadSecureRefreshToken(file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Angel One status remains safe to read when no session is connected', () => {
  assert.doesNotThrow(() => angelStatus());
  const status = angelStatus();
  assert.equal(status.connected, false);
  assert.equal(typeof status.refreshTokenStored, 'boolean');
  assert.equal(Object.hasOwn(status, 'refreshToken'), false);
});

test('Angel One login API rejects overlapping login attempts and releases its lock', () => {
  assert.match(server, /let angelLoginInFlight\s*=\s*false/);
  assert.match(server, /if\(angelLoginInFlight\) return res\.status\(409\)/);
  assert.match(server, /finally\s*\{\s*angelLoginInFlight\s*=\s*false;\s*\}/);
});

test('Angel One UI uses one active connect handler with a shared in-flight guard', () => {
  assert.match(html, /if\(window\.__ptdAngelLoginInFlight\)/);
  assert.match(html, /window\.__ptdAngelLoginInFlight=true/);
  assert.match(html, /if\(btn\)btn\.addEventListener\('click',connect,true\)/);
  assert.match(html, /Legacy login click hook disabled/);
  assert.doesNotMatch(html, /if\(btn\)btn\.addEventListener\('click',function\(ev\)\{ev\.preventDefault\(\);ev\.stopImmediatePropagation\(\);connect\(\);\},true\)/);
});