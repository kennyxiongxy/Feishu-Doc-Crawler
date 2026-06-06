// Standalone unit tests for the concurrency helpers in popup.js.
// Run with: node tests/test_concurrency.mjs
//
// We extract the helper functions into a minimal test harness here
// to verify behavior. The actual popup.js helpers are byte-identical
// to the implementations below (kept in sync).

import assert from 'node:assert/strict';

// ============================================================
// Mirror of popup.js helpers (kept in sync)
// ============================================================

class Semaphore {
  constructor(n) { this._n = n; this._waiters = []; }
  async acquire() {
    if (this._n > 0) { this._n--; return; }
    await new Promise(r => this._waiters.push(r));
  }
  release() {
    const w = this._waiters.shift();
    if (w) w();
    else this._n++;
  }
}

async function runPool(items, limit, worker, isCancelledFn) {
  if (items.length === 0) return;
  const sem = new Semaphore(limit);
  await Promise.all(items.map(async (item, i) => {
    if (isCancelledFn && isCancelledFn()) return;
    await sem.acquire();
    if (isCancelledFn && isCancelledFn()) { sem.release(); return; }
    try {
      await worker(item, i);
    } catch (e) {
      console.warn('[Pool] worker error:', e && e.message);
    } finally {
      sem.release();
    }
  }));
}

const _dirTagCounter = { n: 0 };
const _dirTags = new WeakMap();
function getDirTag(dirHandle) {
  let tag = _dirTags.get(dirHandle);
  if (!tag) { tag = `d${++_dirTagCounter.n}`; _dirTags.set(dirHandle, tag); }
  return tag;
}
const _nameChains = new Map();

function allocUniqueName(dirHandle, base, ext) {
  const key = `${getDirTag(dirHandle)}::${base}.${ext}`;
  const prev = _nameChains.get(key) || Promise.resolve();
  const next = prev.then(async () => {
    for (let n = 1; n < 1000; n++) {
      const name = n === 1 ? `${base}.${ext}` : `${base}_${n}.${ext}`;
      let exists = false;
      try { await dirHandle.getFileHandle(name, { create: false }); exists = true; } catch (_) {}
      if (!exists) {
        await dirHandle.getFileHandle(name, { create: true });
        return name;
      }
    }
    throw new Error(`Too many duplicates for ${key}`);
  });
  _nameChains.set(key, next.catch(() => {}));
  return next;
}

// ============================================================
// Fake FileSystemDirectoryHandle
// ============================================================
function makeFakeDir() {
  const files = new Map();
  return {
    _files: files,
    async getFileHandle(name, opts = {}) {
      if (files.has(name)) return { _name: name, _existing: true };
      if (!opts.create) {
        const err = new Error('Not found');
        err.name = 'NotFoundError';
        throw err;
      }
      files.set(name, true);
      return { _name: name, _existing: false };
    },
  };
}

// ============================================================
// Tests
// ============================================================

// runPool: basic order-independent execution
{
  const results = [];
  await runPool([1, 2, 3, 4, 5], 2, async (n) => {
    await new Promise(r => setTimeout(r, 10));
    results.push(n);
  });
  assert.equal(results.length, 5);
  assert.deepEqual([...results].sort(), [1, 2, 3, 4, 5]);
  console.log('✓ runPool processes all items');
}

// runPool: respects concurrency limit
{
  let concurrent = 0, maxConcurrent = 0;
  await runPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(r => setTimeout(r, 20));
    concurrent--;
  });
  assert.ok(maxConcurrent <= 3, `max concurrent ${maxConcurrent} should be <= 3`);
  assert.ok(maxConcurrent >= 2, `max concurrent ${maxConcurrent} should be >= 2`);
  console.log(`✓ runPool respects limit (max observed: ${maxConcurrent})`);
}

// runPool: cancellation stops new dispatches
{
  let cancel = false;
  const processed = [];
  await runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
    processed.push(n);
    if (n === 2) cancel = true;
    await new Promise(r => setTimeout(r, 5));
  }, () => cancel);
  // Should have processed fewer than 6 items
  assert.ok(processed.length < 6, `expected <6, got ${processed.length}`);
  console.log(`✓ runPool stops on cancel (processed: ${processed.length}/6)`);
}

// runPool: handles empty input
{
  let called = false;
  await runPool([], 3, async () => { called = true; });
  assert.equal(called, false);
  console.log('✓ runPool handles empty array');
}

// runPool: handles single item
{
  const results = [];
  await runPool([42], 3, async (n) => { results.push(n); });
  assert.deepEqual(results, [42]);
  console.log('✓ runPool handles single item');
}

// allocUniqueName: first allocation returns base.ext
{
  _nameChains.clear();
  const dir = makeFakeDir();
  const name = await allocUniqueName(dir, 'Title', 'md');
  assert.equal(name, 'Title.md');
  console.log('✓ allocUniqueName: first try = base.ext');
}

// allocUniqueName: collision returns _2 suffix
{
  _nameChains.clear();
  const dir = makeFakeDir();
  await allocUniqueName(dir, 'Title', 'md');
  const name = await allocUniqueName(dir, 'Title', 'md');
  assert.equal(name, 'Title_2.md');
  console.log('✓ allocUniqueName: collision -> _2');
}

// allocUniqueName: many collisions walk the counter
{
  _nameChains.clear();
  const dir = makeFakeDir();
  const names = [];
  for (let i = 0; i < 5; i++) {
    names.push(await allocUniqueName(dir, 'A', 'md'));
  }
  assert.deepEqual(names, ['A.md', 'A_2.md', 'A_3.md', 'A_4.md', 'A_5.md']);
  console.log('✓ allocUniqueName: walks counter on repeated calls');
}

// allocUniqueName: concurrent allocations get unique names
{
  _nameChains.clear();
  const dir = makeFakeDir();
  const names = await Promise.all(
    Array.from({ length: 20 }, () => allocUniqueName(dir, 'Concur', 'png'))
  );
  const unique = new Set(names);
  assert.equal(unique.size, 20, `expected 20 unique, got ${unique.size}`);
  console.log(`✓ allocUniqueName: 20 concurrent -> 20 unique names`);
}

// allocUniqueName: different ext isolated
{
  _nameChains.clear();
  const dir = makeFakeDir();
  const a = await allocUniqueName(dir, 'File', 'md');
  const b = await allocUniqueName(dir, 'File', 'png');
  assert.equal(a, 'File.md');
  assert.equal(b, 'File.png');
  console.log('✓ allocUniqueName: different ext isolated');
}

// allocUniqueName: different dirHandle isolated (no cross-dir collision)
{
  _nameChains.clear();
  const dir1 = makeFakeDir();
  const dir2 = makeFakeDir();
  const a = await allocUniqueName(dir1, 'X', 'md');
  const b = await allocUniqueName(dir2, 'X', 'md');
  assert.equal(a, 'X.md');
  assert.equal(b, 'X.md');  // both can be 'X.md' because different dirs
  console.log('✓ allocUniqueName: different dirs have separate counters');
}

// allocUniqueName: pre-existing file in directory counts as taken
{
  _nameChains.clear();
  const dir = makeFakeDir();
  dir._files.set('Title.md', true);
  const name = await allocUniqueName(dir, 'Title', 'md');
  assert.equal(name, 'Title_2.md');
  console.log('✓ allocUniqueName: pre-existing file is skipped');
}

// End-to-end: processArticle-style pipeline with concurrency
{
  _nameChains.clear();
  const dir = makeFakeDir();
  const imagesDir = makeFakeDir();

  const targets = [
    { title: 'Article A', token: 'ta' },
    { title: 'Article B', token: 'tb' },
    { title: 'Article C', token: 'tc' },
  ];

  // Fake extract returning minimal data
  async function fakeExtract(art) {
    return { content: '# ' + art.title, images: [{ url: 'http://x/' + art.token + '.png', file_token: 'ft_' + art.token, ext: 'png' }] };
  }
  async function fakeDownloadImg(img) {
    // Return ~2KB base64 to pass the size threshold
    return { ok: true, data: 'A'.repeat(2730), size: 2000 };
  }

  let maxArticleConcurrent = 0;
  let articleInFlight = 0;

  async function processArticle(art) {
    articleInFlight++;
    maxArticleConcurrent = Math.max(maxArticleConcurrent, articleInFlight);
    try {
      const result = await fakeExtract(art);
      if (result.images.length > 0) {
        await runPool(result.images, 2, async (img) => {
          const r = await fakeDownloadImg(img);
          if (r.ok) {
            await allocUniqueName(imagesDir, sanitizeFilenameLocal(art.title) + '_1', 'png');
          }
        });
      }
      await allocUniqueName(dir, sanitizeFilenameLocal(art.title), 'md');
    } finally {
      articleInFlight--;
    }
  }

  // Local filename sanitizer (matches popup.js)
  function sanitizeFilenameLocal(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 100);
  }

  await runPool(targets, 3, processArticle);
  assert.ok(maxArticleConcurrent >= 2, `expected >=2 concurrent articles, got ${maxArticleConcurrent}`);
  assert.equal(dir._files.size, 3);
  assert.equal(imagesDir._files.size, 3);
  console.log(`✓ End-to-end: 3 articles in parallel (max=${maxArticleConcurrent}), 3 md + 3 png written`);
}

console.log('\n🎉 All concurrency tests passed');
