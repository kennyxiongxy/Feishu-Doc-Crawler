// Tests for popup.js search/filter behavior.
// Run with: node tests/test_search.mjs
//
// The filter logic is pure (searchQuery + articles + selectedSet) and
// doesn't depend on DOM. We mirror it here to verify the semantics.

// ============================================================
// Mirror of the filter logic (kept in sync with popup.js)
// ============================================================

function renderState(articles, searchQuery, selectedSet) {
  const q = (searchQuery || '').trim().toLowerCase();
  const matches = (a) => !q || (a.title || '').toLowerCase().includes(q);
  const visibleIndices = [];
  for (let i = 0; i < articles.length; i++) {
    if (matches(articles[i])) visibleIndices.push(i);
  }
  return {
    visibleIndices,
    selectedCount: selectedSet.size,
    countDisplay: q
      ? `${selectedSet.size} / ${visibleIndices.length} / ${articles.length}`
      : `${selectedSet.size} / ${articles.length}`,
    filterStatus: q ? `匹配 ${visibleIndices.length}` : '',
  };
}

// ============================================================
// Tests
// ============================================================
import assert from 'node:assert/strict';

const sample = [
  { title: '一、为什么要学 AI 画图？' },
  { title: '二、工具准备：Midjourney vs Stable Diffusion' },
  { title: '三、提示词优化技巧' },
  { title: 'AI 常见问题答疑' },
  { title: 'AI 速览' },
];

// No filter
{
  const r = renderState(sample, '', new Set([0, 1, 2, 3, 4]));
  assert.deepEqual(r.visibleIndices, [0, 1, 2, 3, 4]);
  assert.equal(r.countDisplay, '5 / 5');
  assert.equal(r.filterStatus, '');
  console.log('✓ no filter: shows all');
}

// Substring match
{
  const r = renderState(sample, 'AI', new Set([0, 1, 2, 3, 4]));
  assert.deepEqual(r.visibleIndices, [0, 3, 4]);
  assert.equal(r.countDisplay, '5 / 3 / 5');
  assert.equal(r.filterStatus, '匹配 3');
  console.log('✓ substring "AI" matches 3');
}

// Chinese substring
{
  const r = renderState(sample, '提示词', new Set([0, 1, 2, 3, 4]));
  assert.deepEqual(r.visibleIndices, [2]);
  assert.equal(r.countDisplay, '5 / 1 / 5');
  console.log('✓ Chinese substring matches');
}

// Case-insensitive
{
  const r = renderState(sample, 'midjourney', new Set([0, 1, 2, 3, 4]));
  assert.deepEqual(r.visibleIndices, [1]);
  console.log('✓ case-insensitive');
}

// Whitespace-only is treated as no filter
{
  const r = renderState(sample, '   ', new Set([0, 1, 2, 3, 4]));
  assert.equal(r.countDisplay, '5 / 5');
  assert.equal(r.filterStatus, '');
  console.log('✓ whitespace-only = no filter');
}

// No matches
{
  const r = renderState(sample, 'xyz不存在', new Set([0, 1, 2, 3, 4]));
  assert.deepEqual(r.visibleIndices, []);
  assert.equal(r.countDisplay, '5 / 0 / 5');
  assert.equal(r.filterStatus, '匹配 0');
  console.log('✓ no matches shows 0/0');
}

// selectedSet persists across filter changes
{
  const set = new Set([0, 2, 4]);
  const r1 = renderState(sample, 'AI', set);
  assert.equal(r1.selectedCount, 3);  // Set didn't change
  const r2 = renderState(sample, '', set);
  assert.equal(r2.selectedCount, 3);
  console.log('✓ selectedSet persists across filter changes');
}

// Partial selection visible in count display
{
  const r = renderState(sample, '', new Set([1, 3]));
  assert.equal(r.countDisplay, '2 / 5');
  console.log('✓ partial selection shown as 2/5');
}

// Filter narrows visible but selection stays
{
  const r = renderState(sample, '工具', new Set([0, 1, 2]));
  // "工具" only matches index 1
  assert.deepEqual(r.visibleIndices, [1]);
  // selectedSet has 0, 1, 2 — all still in set
  assert.equal(r.selectedCount, 3);
  assert.equal(r.countDisplay, '3 / 1 / 5');
  console.log('✓ filter narrows visible but selectedSet unchanged');
}

// Empty articles
{
  const r = renderState([], 'anything', new Set());
  assert.deepEqual(r.visibleIndices, []);
  assert.equal(r.countDisplay, '0 / 0 / 0');
  console.log('✓ empty articles');
}

// Article with no title
{
  const noTitle = [{ title: '' }, { title: 'Real' }];
  const r = renderState(noTitle, 'real', new Set([0, 1]));
  assert.deepEqual(r.visibleIndices, [1]);
  console.log('✓ missing title handled');
}

console.log('\n🎉 All search/filter tests passed');
