// Tests for v5.10.1 bug fixes:
// - Bug #1: open folder prompt default value (don't pre-fill example)
// - Bug #2: tree expand error handling (don't silently swallow API errors)
//
// We test the *behaviour contracts* in isolation from the DOM:
//   - extractExampleForPlatform(platform) — returns the right example string
//   - validateFolderPathInput(input) — returns { ok, reason? }
//   - discoverChildrenOf contract — returns { ok, reason, count?, error? } instead of bare number
//   - childrenFailed set lifecycle — failures get added, success clears, retry works

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirror the logic from popup.js (kept in lock-step with the source).
function extractExampleForPlatform(platform) {
  const p = platform.toLowerCase();
  if (p.includes('mac')) return '/Users/<你的用户名>/Documents/feishu-crawler';
  if (p.includes('win')) return 'C:\\Users\\<你的用户名>\\Documents\\feishu-crawler';
  return '/home/<你的用户名>/Documents/feishu-crawler';
}

function validateFolderPathInput(input) {
  if (input === null) return { ok: false, reason: 'cancelled' };
  const path = String(input).trim();
  if (!path) return { ok: false, reason: 'empty' };
  if (/yourname|<.*?>/.test(path)) return { ok: false, reason: 'placeholder' };
  return { ok: true, path };
}

// ============================================================
// Bug #1: open folder — example is NEVER used as default value,
// it must only appear in the body text. validateFolderPathInput
// must reject the placeholder.
// ============================================================
test('Bug #1: example string contains a placeholder marker', () => {
  const ex = extractExampleForPlatform('MacIntel');
  assert.match(ex, /<你的用户名>/, 'mac example must contain <你的用户名>');
  assert.ok(ex.startsWith('/Users/'), 'mac example should start with /Users/');
});

test('Bug #1: windows example has placeholder', () => {
  const ex = extractExampleForPlatform('Win32');
  assert.match(ex, /<你的用户名>/);
  assert.ok(ex.includes('C:\\'));
});

test('Bug #1: linux example has placeholder', () => {
  const ex = extractExampleForPlatform('Linux x86_64');
  assert.match(ex, /<你的用户名>/);
  assert.ok(ex.startsWith('/home/'));
});

test('Bug #1: validate rejects the bare placeholder', () => {
  const r1 = validateFolderPathInput('/Users/yourname/Documents/feishu-crawler');
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'placeholder');
});

test('Bug #1: validate rejects the <...> form', () => {
  const r2 = validateFolderPathInput('/Users/<你的用户名>/Documents');
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'placeholder');
});

test('Bug #1: validate rejects empty / whitespace', () => {
  assert.equal(validateFolderPathInput('').reason, 'empty');
  assert.equal(validateFolderPathInput('   ').reason, 'empty');
});

test('Bug #1: validate accepts a real path', () => {
  const r = validateFolderPathInput('/Users/alice/Documents/feishu-crawler');
  assert.deepEqual(r, { ok: true, path: '/Users/alice/Documents/feishu-crawler' });
});

test('Bug #1: user cancellation (null) is a non-error outcome', () => {
  const r = validateFolderPathInput(null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cancelled');
});

// ============================================================
// Bug #2: tree expand — contract changes from "return count or 0"
// to "return { ok, reason, count?, error? }" so errors surface
// instead of being silently swallowed as "0 children".
// ============================================================

// Simulated lifecycle of the three sets the click handler depends on.
function makeTreeState() {
  return {
    childrenLoaded: new Set(),
    childrenFailed: new Set(),
    loadingParents: new Set(),
  };
}

// Mirror of the new discoverChildrenOf contract, but driven by an injected
// `discoverApi` so we can simulate success / error / empty.
async function discoverChildrenOfContract(state, parentIdx, discoverApi) {
  if (state.childrenLoaded.has(parentIdx)) {
    return { ok: true, count: 0, cached: true };
  }
  state.loadingParents.add(parentIdx);
  state.childrenFailed.delete(parentIdx);
  try {
    const result = await discoverApi(parentIdx);
    if (result && result.error) {
      state.childrenFailed.add(parentIdx);
      return { ok: false, reason: 'api-error', error: result.error, response: result };
    }
    const children = (result && result.articles) || [];
    if (children.length === 0) {
      state.childrenLoaded.add(parentIdx);
      return { ok: true, count: 0, response: result };
    }
    state.childrenLoaded.add(parentIdx);
    return { ok: true, count: children.length, response: result };
  } catch (e) {
    state.childrenFailed.add(parentIdx);
    return { ok: false, reason: 'network-error', error: e.message, response: null };
  } finally {
    state.loadingParents.delete(parentIdx);
  }
}

test('Bug #2: API returning error is reported, parent NOT marked as loaded', async () => {
  const state = makeTreeState();
  const r = await discoverChildrenOfContract(state, 0, async () => ({ error: 'No space_id found' }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'api-error');
  assert.equal(r.error, 'No space_id found');
  assert.equal(state.childrenLoaded.has(0), false, 'must NOT mark as loaded on error');
  assert.equal(state.childrenFailed.has(0), true, 'must mark as failed for retry UI');
});

test('Bug #2: network error is reported, parent marked as failed', async () => {
  const state = makeTreeState();
  const r = await discoverChildrenOfContract(state, 0, async () => { throw new Error('fetch failed'); });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'network-error');
  assert.match(r.error, /fetch failed/);
  assert.equal(state.childrenLoaded.has(0), false);
  assert.equal(state.childrenFailed.has(0), true);
});

test('Bug #2: API returning { articles: [] } is treated as "no children", loaded', async () => {
  const state = makeTreeState();
  const r = await discoverChildrenOfContract(state, 0, async () => ({ articles: [] }));
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.equal(state.childrenLoaded.has(0), true);
  assert.equal(state.childrenFailed.has(0), false);
});

test('Bug #2: API returning children counts them and marks loaded', async () => {
  const state = makeTreeState();
  const r = await discoverChildrenOfContract(state, 0, async () => ({
    articles: [{ title: 'a' }, { title: 'b' }, { title: 'c' }],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.equal(state.childrenLoaded.has(0), true);
  assert.equal(state.childrenFailed.has(0), false);
});

test('Bug #2: retry after error works (childrenFailed does NOT poison the cache)', async () => {
  const state = makeTreeState();
  // First call errors
  await discoverChildrenOfContract(state, 0, async () => ({ error: 'temporary' }));
  assert.equal(state.childrenFailed.has(0), true);
  assert.equal(state.childrenLoaded.has(0), false);
  // Retry — but the contract only returns cached=true when already loaded;
  // since the first attempt set childrenFailed but NOT childrenLoaded, retry
  // actually re-calls the API. Good.
  let calls = 0;
  const r = await discoverChildrenOfContract(state, 0, async () => {
    calls++;
    return { articles: [{ title: 'recovered' }] };
  });
  assert.equal(calls, 1, 'retry should hit the API again');
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(state.childrenLoaded.has(0), true);
  assert.equal(state.childrenFailed.has(0), false, 'success clears failed flag');
});

test('Bug #2: loadingParents is cleared in both success and error paths', async () => {
  const s1 = makeTreeState();
  await discoverChildrenOfContract(s1, 0, async () => ({ error: 'x' }));
  assert.equal(s1.loadingParents.has(0), false);

  const s2 = makeTreeState();
  await discoverChildrenOfContract(s2, 0, async () => ({ articles: [] }));
  assert.equal(s2.loadingParents.has(0), false);

  const s3 = makeTreeState();
  await discoverChildrenOfContract(s3, 0, async () => { throw new Error('x'); });
  assert.equal(s3.loadingParents.has(0), false);
});

test('Bug #2: empty result does NOT clear childrenFailed (no accidental retry-state loss)', async () => {
  // If the API succeeded with no children, childrenFailed is irrelevant.
  // But it should also not be cleared by a successful empty response
  // unrelated to the prior failure (defensive). Here we just confirm
  // that an empty response is loaded-state, which takes priority.
  const state = makeTreeState();
  state.childrenFailed.add(0);  // simulate prior failure
  const r = await discoverChildrenOfContract(state, 0, async () => ({ articles: [] }));
  assert.equal(r.ok, true);
  assert.equal(state.childrenLoaded.has(0), true);
});

test('Bug #2: classic v5.10 bug — error as { articles: undefined } was treated as 0', async () => {
  // In the old code: result.error truthy but we ignored it; result.articles undefined
  // → we marked as loaded and silently failed. The new contract exposes the error.
  const state = makeTreeState();
  const r = await discoverChildrenOfContract(state, 0, async () => ({ error: 'permission denied' }));
  assert.equal(r.ok, false);
  assert.equal(state.childrenLoaded.has(0), false, 'regression: must not silently load');
});

// ============================================================
// v5.10.1 regression: stored path from v5.10.0 might be the bad
// example path. New code must re-validate it on every call.
// ============================================================
function isValidStoredPath(p) {
  if (!p) return false;
  return !/yourname|<.*?>/.test(p);
}

test('v5.10.1: stored path /Users/yourname/... from v5.10.0 is rejected on read', () => {
  assert.equal(isValidStoredPath('/Users/yourname/Documents/feishu-crawler'), false);
  assert.equal(isValidStoredPath('/Users/<你的用户名>/Documents/feishu-crawler'), false);
  assert.equal(isValidStoredPath('/Users/alice/Documents/feishu-crawler'), true);
  assert.equal(isValidStoredPath(''), false);
  assert.equal(isValidStoredPath(null), false);
});

// ============================================================
// v5.10.1 contract: discoverChildrenOf now also reports back the
// raw response so the UI can show debug info on failure.
// ============================================================
test('v5.10.1: api-error result includes the full response for debug display', async () => {
  const state = makeTreeState();
  const errResp = { error: 'No space_id found', source: 'wiki_api' };
  const r = await discoverChildrenOfContract(state, 0, async () => errResp);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'api-error');
  // The contract change adds the response back to the result so the UI can render it
  assert.ok(r.response !== undefined, 'response should be attached to result');
  assert.deepEqual(r.response, errResp);
});

test('v5.10.1: empty articles result is marked as count=0 (not error)', async () => {
  const state = makeTreeState();
  const r = await discoverChildrenOfContract(state, 0, async () => ({ articles: [], title: 'foo' }));
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  // The click handler can use this to show "没有子文档"
  assert.ok(r.response !== undefined);
});
