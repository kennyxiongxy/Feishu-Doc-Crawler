// tests/test_tree.mjs — 树形逻辑单元测试（v5.8）
// 跑法：node tests/test_tree.mjs
//
// 测 popup/tree.js 的纯函数：getDepth / computeVisible / getParentIndices /
// allExpanded / insertChildrenAfter。Node 端无 DOM/Chrome 依赖。

import {
  getDepth,
  computeVisible,
  getParentIndices,
  allExpanded,
  insertChildrenAfter,
} from '../popup/tree.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ ' + msg); }
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}\n      expected: ${e}\n      actual:   ${a}`); }
}

function section(name) {
  console.log(`\n[${name}]`);
}

// ============================================================
// getDepth
// ============================================================
section('getDepth');
{
  const articles = [
    { title: 'A', parentIndex: -1 },
    { title: 'B', parentIndex: 0 },   // child of A
    { title: 'C', parentIndex: -1 },  // top-level
    { title: 'D', parentIndex: 1 },   // child of B (grandchild of A)
    { title: 'E', parentIndex: 3 },   // child of D (great-grandchild)
  ];
  assertEq(getDepth(articles, 0), 0, 'top-level A has depth 0');
  assertEq(getDepth(articles, 1), 1, 'B is depth 1');
  assertEq(getDepth(articles, 2), 0, 'C is top-level depth 0');
  assertEq(getDepth(articles, 3), 2, 'D is depth 2');
  assertEq(getDepth(articles, 4), 3, 'E is depth 3');
}

// cycle safety
{
  const cyclic = [
    { title: 'X', parentIndex: 1 },
    { title: 'Y', parentIndex: 0 },
  ];
  const d = getDepth(cyclic, 0);
  assert(d >= 0 && d <= 100, 'cycle returns bounded depth (no infinite loop)');
}

// missing parentIndex field defaults to -1
{
  const articles = [{ title: 'NoField' }];
  assertEq(getDepth(articles, 0), 0, 'missing parentIndex treated as top-level');
}

// ============================================================
// computeVisible — expansion
// ============================================================
section('computeVisible — expansion');
{
  // 数据遵循不变量：子节点 C0 紧跟父节点 T0 之后
  const articles = [
    { title: 'T0', parentIndex: -1, has_child: true },
    { title: 'C0', parentIndex: 0, has_child: false },
    { title: 'T1', parentIndex: -1, has_child: false },
  ];
  const empty = new Set();
  let vis = computeVisible(articles, empty, '');
  assertEq(vis.map(v => v.index), [0, 2], 'collapsed: T0 + T1 visible, C0 hidden');
  assertEq(vis[0].depth, 0, 'T0 depth 0');
  assertEq(vis[1].depth, 0, 'T1 depth 0');

  // expand T0
  const expanded = new Set([0]);
  vis = computeVisible(articles, expanded, '');
  assertEq(vis.map(v => v.index), [0, 1, 2], 'expanded T0: C0 visible, T1 follows in array order');
  assertEq(vis[0].depth, 0, 'T0 depth 0');
  assertEq(vis[1].depth, 1, 'C0 depth 1');
  assertEq(vis[2].depth, 0, 'T1 depth 0');
}

// multi-level expansion
{
  // Data follows invariant: children appear right after parent in the flat array
  const articles = [
    { title: 'P', parentIndex: -1, has_child: true },
    { title: 'C1', parentIndex: 0, has_child: true },
    { title: 'G1', parentIndex: 1, has_child: false },  // grandchild of P
    { title: 'C2', parentIndex: 0, has_child: false },
  ];
  const expandP = new Set([0]);
  let vis = computeVisible(articles, expandP, '');
  assertEq(vis.map(v => v.index), [0, 1, 3], 'expand P: C1 + C2 visible, G1 hidden (C1 not expanded)');

  const expandPAndC1 = new Set([0, 1]);
  vis = computeVisible(articles, expandPAndC1, '');
  assertEq(vis.map(v => v.index), [0, 1, 2, 3], 'expand P+C1: full tree visible');
  assertEq(vis.find(v => v.index === 2).depth, 2, 'G1 depth 2');
}

// ============================================================
// computeVisible — search
// ============================================================
section('computeVisible — search');
{
  // Data: H (parent) → HS (child) → HSS (grandchild)
  //       F (top-level) → FO (child)
  const articles = [
    { title: 'Hello World', parentIndex: -1, has_child: true },
    { title: 'Hello Sub', parentIndex: 0, has_child: true },
    { title: 'Hello Sub Sub', parentIndex: 1, has_child: false },
    { title: 'Foo Bar', parentIndex: -1, has_child: true },
    { title: 'Foo Other', parentIndex: 3, has_child: false },
  ];

  // search "hello" with nothing expanded: reveals matching items + ancestor context
  let vis = computeVisible(articles, new Set(), 'hello');
  assertEq(vis.map(v => v.index), [0, 1, 2], 'search "hello": H + HS + HSS (all ancestors included)');

  // search "sub" — only HS and HSS match; H included as ancestor of HS
  vis = computeVisible(articles, new Set(), 'sub');
  assertEq(vis.map(v => v.index), [0, 1, 2], 'search "sub": H (ancestor) + HS + HSS');

  // search "sub sub" — only HSS matches; HS + H included as ancestors
  vis = computeVisible(articles, new Set(), 'sub sub');
  assertEq(vis.map(v => v.index), [0, 1, 2], 'search "sub sub": full chain shown');

  // search "other" — only FO matches; F included as ancestor
  vis = computeVisible(articles, new Set(), 'other');
  assertEq(vis.map(v => v.index), [3, 4], 'search "other": F (ancestor) + FO');

  // case-insensitive
  vis = computeVisible(articles, new Set(), 'HELLO');
  assertEq(vis.length, 3, 'search is case-insensitive');

  // whitespace trimmed
  vis = computeVisible(articles, new Set(), '   ');
  // No search: top-level only
  assertEq(vis.map(v => v.index), [0, 3], 'empty/whitespace search shows top-level only');
}

// ============================================================
// getParentIndices
// ============================================================
section('getParentIndices');
{
  const articles = [
    { title: 'A', parentIndex: -1, has_child: true },
    { title: 'B', parentIndex: -1, has_child: false },
    { title: 'C', parentIndex: 0, has_child: true },
    { title: 'D', parentIndex: -1, has_child: false },
    { title: 'E', parentIndex: 2, has_child: false },
  ];
  assertEq(getParentIndices(articles), [0, 2], 'returns indices of has_child items (in order)');
}

// ============================================================
// allExpanded
// ============================================================
section('allExpanded');
{
  const articles = [
    { title: 'A', parentIndex: -1, has_child: true },
    { title: 'B', parentIndex: -1, has_child: true },
    { title: 'C', parentIndex: -1, has_child: false },
    { title: 'CA', parentIndex: 0, has_child: false },
  ];
  assertEq(allExpanded(articles, new Set()), false, 'empty set: not all expanded');
  assertEq(allExpanded(articles, new Set([0])), false, 'one of two parents expanded: not all');
  assertEq(allExpanded(articles, new Set([0, 1])), true, 'all parents expanded');
  assertEq(allExpanded([], new Set()), false, 'no parents: returns false (button hidden anyway)');
}

// ============================================================
// insertChildrenAfter
// ============================================================
section('insertChildrenAfter');
{
  const articles = [
    { title: 'A', parentIndex: -1 },
    { title: 'B', parentIndex: -1 },
  ];
  const newChildren = [
    { title: 'A1' },
    { title: 'A2' },
  ];
  const result = insertChildrenAfter(articles, 0, newChildren);
  assertEq(result.map(a => a.title), ['A', 'A1', 'A2', 'B'], 'children inserted right after parent');
  assertEq(result[1].parentIndex, 0, 'A1.parentIndex = 0');
  assertEq(result[2].parentIndex, 0, 'A2.parentIndex = 0');
  assertEq(result[3].parentIndex, -1, 'B unchanged');
}

section('insertChildrenAfter — empty children');
{
  const articles = [{ title: 'A', parentIndex: -1 }];
  const result = insertChildrenAfter(articles, 0, []);
  assertEq(result.length, 1, 'no children: array length unchanged');
  assertEq(result[0].title, 'A', 'first element preserved');
}

section('insertChildrenAfter — does not mutate input');
{
  const articles = [{ title: 'A', parentIndex: -1 }];
  const snapshot = JSON.stringify(articles);
  insertChildrenAfter(articles, 0, [{ title: 'X' }]);
  assertEq(JSON.stringify(articles), snapshot, 'input array not mutated');
}

// ============================================================
// Integration scenarios (composing pure functions)
// ============================================================
section('Integration: expand → search → depth propagation');
{
  const articles = [
    { title: 'Top', parentIndex: -1, has_child: true },
  ];
  // Step 1: discover children of Top
  const expanded = insertChildrenAfter(articles, 0, [
    { title: 'Sub A', has_child: true },
    { title: 'Sub B', has_child: false },
  ]);
  // Step 2: discover grandchildren of Sub A
  const expanded2 = insertChildrenAfter(expanded, 1, [
    { title: 'SubSub 1', has_child: false },
  ]);

  assertEq(expanded2.map(a => a.title), ['Top', 'Sub A', 'SubSub 1', 'Sub B'], 'two-level expansion order correct');
  assertEq(expanded2[2].parentIndex, 1, 'SubSub 1 has parentIndex=1 (Sub A)');

  // expand both
  const vis = computeVisible(expanded2, new Set([0, 1]), '');
  assertEq(vis.map(v => v.index), [0, 1, 2, 3], 'all visible when both parents expanded');
  const byIdx = Object.fromEntries(vis.map(v => [v.index, v.depth]));
  assertEq(byIdx[0], 0, 'Top depth 0');
  assertEq(byIdx[1], 1, 'Sub A depth 1');
  assertEq(byIdx[2], 2, 'SubSub 1 depth 2');
  assertEq(byIdx[3], 1, 'Sub B depth 1');
}

section('Integration: search reveals hidden subtree with ancestors');
{
  // Hidden parent → child. Child title matches search.
  // Search should reveal both (parent as ancestor, child as match).
  const articles = [
    { title: 'Public', parentIndex: -1, has_child: false },
    { title: 'Hidden Parent', parentIndex: -1, has_child: true },
    { title: 'Secret Title', parentIndex: 1, has_child: false },
  ];
  // No expansion, search "secret" — child is hidden, but search reveals it + its parent
  const vis = computeVisible(articles, new Set(), 'secret');
  assertEq(vis.map(v => v.index), [1, 2], 'search "secret": hidden parent + matching child both visible');
  assertEq(vis[0].depth, 0, 'parent shown at depth 0');
  assertEq(vis[1].depth, 1, 'child shown at depth 1 (correct hierarchy)');
}

section('Integration: select-all-visible math (mimic btn-select-all)');
{
  // 模拟"全选"按钮：只勾选当前可见的项。
  // 数据遵循"子节点紧跟父节点"不变量（真实运行中由 insertChildrenAfter 保证）。
  const articles = [
    { title: 'A', parentIndex: -1, has_child: true },
    { title: 'A1', parentIndex: 0, has_child: false },
    { title: 'A2', parentIndex: 0, has_child: false },
    { title: 'B', parentIndex: -1, has_child: false },
  ];
  const vis = computeVisible(articles, new Set(), '');  // collapsed
  const selectedVisible = vis.map(v => v.index);
  assertEq(selectedVisible, [0, 3], 'select-all-visible with no expansion: A and B only');

  const vis2 = computeVisible(articles, new Set([0]), '');
  const selectedVisible2 = vis2.map(v => v.index);
  assertEq(selectedVisible2, [0, 1, 2, 3], 'select-all-visible after expand A: A, A1, A2, B (in tree order)');
}

// ============================================================
// Summary
// ============================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
