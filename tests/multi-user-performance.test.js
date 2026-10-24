import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const refreshModule = fs.readFileSync(new URL('../sharedRefresh.js', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('multi-user requests share concurrent market, news, and global-feed refreshes', () => {
  assert.ok(server.includes('import { createSharedRefresh } from "./sharedRefresh.js";'));
  assert.ok(server.includes("const sharedRefresh = createSharedRefresh();"));
  assert.ok(refreshModule.includes("const current = inflight.get(key);"));
  assert.ok(refreshModule.includes("work.then(cleanup, cleanup);"));
  assert.match(server, /sharedRefresh\('market:'\+key/);
  assert.match(server, /sharedRefresh\('news:'\+key/);
  assert.match(server, /sharedRefresh\('global-data'/);
});

test('market quote display reuses only a very short two-second snapshot', () => {
  assert.match(server, /Date\.now\(\)-cached\.at<2000/);
  assert.match(server, /marketSnapshotCache\.set\(key,\{at:Date\.now\(\),data\}\)/);
});

test('non-critical health polls pause in hidden tabs and use reduced polling frequency', () => {
  assert.match(ui, /setInterval\(\(\)=>\{if\(!document\.hidden\)ptdAutoRefresh\(\)\},20000\)/);
  assert.match(ui, /setInterval\(\(\)=>\{if\(!document\.hidden\)loadPhase11Shield\(\)\},30000\)/);
});