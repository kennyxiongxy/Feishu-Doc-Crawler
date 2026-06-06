// popup/tree.js — 纯函数树形逻辑（v5.8）
// 与浏览器/Chrome API 解耦，可在 Node 中直接 import 测试。
// 依赖：articles[i] 形如 { title, has_child, parentIndex, ... }
//       parentIndex = -1 表示顶层
//       expandedSet: Set<number> 已展开的父节点 index

export function getDepth(articles, idx) {
  let depth = 0;
  let cur = idx;
  const seen = new Set();
  while (cur >= 0) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const parent = articles[cur]?.parentIndex;
    if (typeof parent !== 'number' || parent < 0) break;
    cur = parent;
    depth++;
    if (depth > 100) break;
  }
  return depth;
}

export function computeVisible(articles, expandedSet, searchQuery) {
  const q = (searchQuery || '').trim().toLowerCase();
  const hasSearch = q.length > 0;
  const matches = (a) => !hasSearch || (a.title || '').toLowerCase().includes(q);

  // First: collect candidate indices.
  // - No search: respect tree expansion (parent must be expanded for child to be visible).
  // - With search: include matching items AND their ancestor chain so context is preserved
  //   (e.g., if a hidden grandchild's title matches, show it plus its parent + grandparent,
  //   even if those ancestors don't match the query).
  const candidates = new Set();
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const parent = typeof a.parentIndex === 'number' ? a.parentIndex : -1;
    if (!hasSearch && parent >= 0 && !expandedSet.has(parent)) continue;
    if (matches(a)) {
      candidates.add(i);
      // Walk up the ancestor chain so the user sees the context for matching children.
      let cur = parent;
      while (cur >= 0 && !candidates.has(cur)) {
        candidates.add(cur);
        cur = typeof articles[cur]?.parentIndex === 'number' ? articles[cur].parentIndex : -1;
      }
    }
  }

  // Second: emit in flat-array order, with depth.
  const result = [];
  for (let i = 0; i < articles.length; i++) {
    if (!candidates.has(i)) continue;
    result.push({ index: i, depth: getDepth(articles, i) });
  }
  return result;
}

export function getParentIndices(articles) {
  const result = [];
  for (let i = 0; i < articles.length; i++) {
    if (articles[i].has_child) result.push(i);
  }
  return result;
}

export function allExpanded(articles, expandedSet) {
  const parents = getParentIndices(articles);
  if (parents.length === 0) return false;
  for (const i of parents) {
    if (!expandedSet.has(i)) return false;
  }
  return true;
}

export function insertChildrenAfter(articles, parentIdx, children) {
  // 返回新数组（不修改入参），children 紧跟 parentIdx 之后插入，
  // 每个 child 的 parentIndex 设为 parentIdx。
  const tagged = children.map(c => ({ ...c, parentIndex: parentIdx }));
  const out = articles.slice();
  out.splice(parentIdx + 1, 0, ...tagged);
  return out;
}
