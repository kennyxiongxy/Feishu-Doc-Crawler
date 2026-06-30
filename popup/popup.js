// popup.js — 飞书文档爬取助手 v5.10
// v5.10: 一键打开保存文件夹 — 服务端 /open-folder 端点，prompt 输入完整路径
// v5.9: 暗色模式 — CSS 变量 + body.dark 覆盖；跟随系统 + 手动切换
// v5.8: 树形展示 — 父节点可展开/折叠子文档，可"展开/折叠全部"
// v5.7: 弹窗搜索/筛选 — 实时过滤 + selectedSet 跨筛选保持
// v5.6: 爬取并发化 — 文章池并发 + 文章内图片并发 + 原子文件名分配
// v5.4: 修复目录持久化 — 分离恢复显示与重新授权

import {
  computeVisible,
  getParentIndices,
  allExpanded,
  insertChildrenAfter,
} from './tree.js';

import {
  resolveInitialTheme,
  resolveNextTheme,
  themeButtonIcon,
  themeButtonLabel,
} from './theme.js';

// 可配置项：默认值 + 允许从 chrome.storage.local 覆盖
const CONFIG = {
  apiBase: 'http://127.0.0.1:8765',
  maxArticleConcurrency: 3,
  maxImageConcurrency: 2,
};

// 脚本加载时立即尝试读取用户自定义配置
(async function loadRuntimeConfig() {
  try {
    const stored = await chrome.storage.local.get(['apiBase']);
    if (stored.apiBase) CONFIG.apiBase = stored.apiBase;
    console.log('[Popup] API base:', CONFIG.apiBase);
  } catch (e) {
    console.warn('[Popup] Failed to load runtime config:', e.message);
  }
})();

// ============================================================
// IndexedDB 持久化目录句柄
// ============================================================
const DB_NAME = 'feishu-crawler-db';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('handles')) {
        db.createObjectStore('handles');
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveDirHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    const store = tx.objectStore('handles');
    store.put(handle, 'dirHandle');
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function loadDirHandle() {
  // 仅从 IndexedDB 加载句柄，不请求权限（权限需要用户手势）
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readonly');
      const store = tx.objectStore('handles');
      const req = store.get('dirHandle');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function verifyOrRequestPermission(handle) {
  // 在用户手势中调用：验证或请求目录权限
  if (!handle) return null;
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') return handle;
    const newPerm = await handle.requestPermission({ mode: 'readwrite' });
    return newPerm === 'granted' ? handle : null;
  } catch (e) {
    console.log('[Perm] verifyOrRequestPermission failed:', e.message);
    return null;
  }
}


function abortTimeout(ms) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

function sendMessageWithTimeout(tabId, message, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Content script timeout')), timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}


// State
let dirHandle = null;
let folderName = '';
let articles = [];
let isCancelled = false;
let crawlInProgress = false;
let originalUrl = '';
let serverAvailable = false;
let needsReauth = false;  // true 表示有已保存的句柄但需要用户手势重新授权

// Concurrency tuning (now centralized in CONFIG)
const MAX_ARTICLE_CONCURRENCY = CONFIG.maxArticleConcurrency;
const MAX_IMAGE_CONCURRENCY = CONFIG.maxImageConcurrency;

// Live crawl counters (shared across workers — safe in single-threaded JS)
let inFlightTitles = new Set();      // article titles currently being processed
let okCount = 0, failCount = 0;

// Search / filter state
let searchQuery = '';
let selectedSet = new Set();         // indices of checked articles (survives filter changes)

// Tree state (v5.8)
let expandedSet = new Set();         // parent indices whose children are visible
let childrenLoaded = new Set();      // parent indices whose children have been discovered
let childrenFailed = new Set();      // parent indices whose last discover attempt errored (allow retry)
let loadingParents = new Set();      // parent indices currently being discovered (for ⏳ caret)

// Theme state (v5.9) — 'light' | 'dark'
let currentTheme = 'light';

// DOM refs
const $loading = document.getElementById('status-loading');
const $ready = document.getElementById('status-ready');
const $crawling = document.getElementById('status-crawling');
const $complete = document.getElementById('status-complete');
const $error = document.getElementById('status-error');

const $pageTitle = document.getElementById('page-title');
const $articleCount = document.getElementById('article-count');
const $articleList = document.getElementById('article-list');
const $searchInput = document.getElementById('search-input');
const $filterStatus = document.getElementById('filter-status');
const $folderPath = document.getElementById('folder-path');
const $btnStart = document.getElementById('btn-start');
const $btnOpenFolder = document.getElementById('btn-open-folder');
const $serverStatus = document.getElementById('server-status');
const $debugInfo = document.getElementById('debug-info');
const $btnTheme = document.getElementById('btn-theme');

const $progressBar = document.getElementById('progress-bar');
const $crawlCurrent = document.getElementById('crawl-current');
const $crawlStats = document.getElementById('crawl-stats');
const $completeMsg = document.getElementById('complete-msg');
const $errorMsg = document.getElementById('error-msg');

function showStatus(id) {
  [$loading, $ready, $crawling, $complete, $error].forEach(el => el.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 100);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// 主题（v5.9）
// ============================================================
function applyTheme(theme) {
  currentTheme = theme;
  document.body.classList.toggle('dark', theme === 'dark');
  $btnTheme.textContent = themeButtonIcon(theme);
  $btnTheme.setAttribute('aria-label', themeButtonLabel(theme));
  $btnTheme.setAttribute('title', themeButtonLabel(theme));
}

function getSystemTheme() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch (e) {
    return 'light';
  }
}

async function loadAndApplyTheme() {
  let saved = null;
  try {
    const stored = await chrome.storage.local.get(['theme']);
    saved = stored.theme;
  } catch (e) { /* storage may be unavailable; fall through to system */ }
  applyTheme(resolveInitialTheme(saved, getSystemTheme()));
}

async function toggleTheme() {
  const next = resolveNextTheme(currentTheme);
  applyTheme(next);
  try {
    await chrome.storage.local.set({ theme: next });
  } catch (e) {
    console.warn('[Theme] Failed to save theme preference:', e.message);
  }
}

// ============================================================
// API 调用
// ============================================================
// Live lark-cli status from /health (path/version/version_ok/min_version)
let larkCliStatus = null;

async function checkServer() {
  try {
    const resp = await fetch(`${CONFIG.apiBase}/health`, { method: 'GET', signal: abortTimeout(3000) });
    if (resp.ok) {
      const data = await resp.json();
      if (data.status === 'ok') {
        serverAvailable = true;
        larkCliStatus = data.lark_cli || null;
        return true;
      }
    }
  } catch (e) { console.log('[Popup] Server check failed:', e.message); }
  serverAvailable = false;
  larkCliStatus = null;
  return false;
}

function getLarkCliWarning() {
  if (!larkCliStatus) return '';
  if (!larkCliStatus.version) {
    return `（未检测到 lark-cli 版本，请执行：lark-cli auth login）`;
  }
  if (!larkCliStatus.version_ok) {
    return `（lark-cli ${larkCliStatus.version} 版本过低，建议升级：lark-cli update）`;
  }
  return '';
}

async function callApi(endpoint, body) {
  console.log(`[Popup] API ${endpoint} <-`, JSON.stringify(body).substring(0, 80));
  const resp = await fetch(`${CONFIG.apiBase}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: abortTimeout(120000)
  });
  const text = await resp.text();
  try {
    const data = JSON.parse(text);
    console.log(`[Popup] API ${endpoint} ->`, data.error ? 'ERROR: ' + data.error : `OK (${(data.content||'').length} chars)`);
    return data;
  } catch (e) {
    console.log(`[Popup] API ${endpoint} -> PARSE ERROR:`, text.substring(0, 100));
    return { error: 'Invalid response: ' + text.substring(0, 100) };
  }
}

// ============================================================
// 文章列表（v5.8 树形）
// ============================================================
function renderArticles() {
  const visible = computeVisible(articles, expandedSet, searchQuery);
  const total = articles.length;
  const q = (searchQuery || '').trim().toLowerCase();

  $articleCount.textContent = q
    ? `${selectedSet.size} / ${visible.length} / ${total}`
    : `${selectedSet.size} / ${total}`;
  $filterStatus.textContent = q ? `匹配 ${visible.length}` : '';

  if (total === 0) {
    $articleList.innerHTML = '<div class="no-articles">未发现子文章</div>';
    updateTreeButton();
    return;
  }
  if (visible.length === 0) {
    $articleList.innerHTML = `<div class="no-articles">无匹配项 "${escapeHtml(q)}"</div>`;
    updateTreeButton();
    return;
  }

  $articleList.innerHTML = visible.map(({ index: i, depth }) => {
    const a = articles[i];
    const token = a.doc_token || a.token || '';
    const tokenShort = token ? token.substring(0, 12) : 'NO-TOKEN';
    const checked = selectedSet.has(i) ? 'checked' : '';
    const isParent = !!a.has_child;
    const isExpanded = expandedSet.has(i);
    const isLoading = loadingParents.has(i);
    const isFailed = childrenFailed.has(i);
    let caret;
    if (!isParent) {
      caret = '<span class="tree-caret placeholder">·</span>';
    } else if (isLoading) {
      caret = `<span class="tree-caret" data-toggle="${i}">⏳</span>`;
    } else if (isFailed) {
      caret = `<span class="tree-caret tree-caret-failed" data-toggle="${i}" title="展开失败，点击重试">✖</span>`;
    } else {
      caret = `<span class="tree-caret" data-toggle="${i}">${isExpanded ? '▼' : '▶'}</span>`;
    }
    const indent = depth * 16;
    return `
    <label class="article-item" title="Token: ${token}" style="padding-left: ${8 + indent}px">
      <input type="checkbox" data-idx="${i}" ${checked}>
      ${caret}
      <span class="type-badge">${isParent ? '📁' : '📄'}</span>
      <span class="article-title">${escapeHtml(a.title)}</span>
      <span class="token-hint">${tokenShort}</span>
    </label>`;
  }).join('');

  updateTreeButton();
}

function updateTreeButton() {
  const $btn = document.getElementById('btn-tree-toggle');
  const parents = getParentIndices(articles);
  if (parents.length === 0) {
    $btn.classList.add('hidden');
    return;
  }
  $btn.classList.remove('hidden');
  $btn.textContent = allExpanded(articles, expandedSet) ? '📂 折叠' : '📂 展开';
}

async function discoverChildrenOf(parentIdx) {
  const parent = articles[parentIdx];
  if (!parent || !parent.has_child) return { ok: false, reason: 'not-parent' };
  if (childrenLoaded.has(parentIdx)) return { ok: true, count: 0, cached: true };
  const token = parent.doc_token || parent.token;
  if (!token) return { ok: false, reason: 'no-token' };
  // v5.10.2: 优先用 URL (含 https:// 或 /wiki/ 或 feishu.cn), 兜底用 token
  // lark-cli 1.0.48+ 的 +node-get 对 URL 能自动推断 obj_type, 对 raw token 不行
  const url = parent.url;
  const reqBody = (url && (url.includes('://') || url.startsWith('/wiki/') || url.includes('feishu.cn')))
    ? { url }
    : { token };
  loadingParents.add(parentIdx);
  childrenFailed.delete(parentIdx);
  renderArticles();
  const t0 = Date.now();
  const logLine = msg => appendTreeDebug(`[${Date.now() - t0}ms] ${msg}`);
  logLine(`discoverChildrenOf(${parentIdx}) title="${(parent.title || '').slice(0, 30)}" ` +
          `req=${url ? 'url' : 'token'}=${(url || token || '').slice(0, 40)}`);
  try {
    const result = await callApi('/discover', reqBody);
    logLine(`API response keys=${result ? Object.keys(result).join(',') : 'null'}` +
            (result && result.articles ? ` count=${result.articles.length}` : '') +
            (result && result.error ? ` error="${result.error}"` : '') +
            (result && result.wiki_status ? ` wiki_status=${result.wiki_status}` : ''));
    if (result && result.error) {
      childrenFailed.add(parentIdx);
      return { ok: false, reason: 'api-error', error: result.error, response: result };
    }
    const children = (result && result.articles) || [];
    if (children.length === 0) {
      childrenLoaded.add(parentIdx);
      return { ok: true, count: 0, response: result };
    }
    articles = insertChildrenAfter(articles, parentIdx, children);
    childrenLoaded.add(parentIdx);
    return { ok: true, count: children.length, response: result };
  } catch (e) {
    logLine(`EXCEPTION: ${e.message}`);
    childrenFailed.add(parentIdx);
    return { ok: false, reason: 'network-error', error: e.message || String(e) };
  } finally {
    loadingParents.delete(parentIdx);
    renderArticles();
  }
}

function appendTreeDebug(msg) {
  console.log('[Tree v5.10.1]', msg);
  const $log = document.getElementById('tree-debug-log');
  if (!$log) return;
  const $wrap = document.getElementById('tree-debug');
  if ($wrap) $wrap.classList.remove('hidden');
  $log.textContent += msg + '\n';
  $log.scrollTop = $log.scrollHeight;
}

async function discoverAllUnloaded() {
  const unloaded = [];
  for (let i = 0; i < articles.length; i++) {
    if (articles[i].has_child && !childrenLoaded.has(i)) unloaded.push(i);
  }
  if (unloaded.length === 0) return 0;
  const results = await Promise.all(unloaded.map(idx => discoverChildrenOf(idx)));
  return results.reduce((a, r) => a + (r.ok ? r.count : 0), 0);
}

function getSelectedIndices() {
  // Return sorted indices from the persistent set, not from DOM checkboxes
  // (so filter changes don't lose or gain selections).
  const sel = [...selectedSet].sort((a, b) => a - b);
  console.log('[Popup] Selected indices:', sel, 'total', articles.length);
  return sel;
}

// ============================================================
// 文件夹显示更新
// ============================================================
async function updateFolderDisplay() {
  if (folderName && dirHandle && !needsReauth) {
    $folderPath.textContent = '📁 ' + folderName;
    $folderPath.style.color = '#1f2329';
    // v5.10.3: 已选文件夹但没设过路径 → 提示用户输入路径
    await updatePathHint();
  } else if (folderName && needsReauth) {
    $folderPath.textContent = '⚠️ ' + folderName + '（点击重新授权）';
    $folderPath.style.color = '#ff9500';
    await updatePathHint();
  } else {
    $folderPath.textContent = '未选择';
    $folderPath.style.color = '#8f959e';
    updatePathHint();  // 隐藏提示
  }
}

// v5.10.3: 控制 "未设置路径" 提示条 — 只在有 dirHandle 但没 lastFolderPath 时显示
async function updatePathHint() {
  const $hint = document.getElementById('folder-path-hint');
  if (!$hint) return;
  if (!dirHandle || !folderName) { $hint.classList.add('hidden'); return; }
  let stored = '';
  try {
    const r = await chrome.storage.local.get(['lastFolderPath']);
    stored = (r.lastFolderPath || '').trim();
  } catch (e) {}
  const hasValid = stored && !/yourname|<.*?>/.test(stored);
  $hint.classList.toggle('hidden', hasValid);
}

// ============================================================
// 初始化
// ============================================================
async function init() {
  // 立即显示就绪界面，避免卡在加载状态
  showStatus('status-ready');
  $pageTitle.textContent = '正在加载...';
  $serverStatus.innerHTML = '<span class="server-ok">● 正在连接 API...</span>';
  $articleList.innerHTML = '<div class="no-articles">正在获取文章列表...</div>';
  $debugInfo.textContent = '';

  // 第 0 步：恢复主题（必须在渲染前，避免深浅切换闪屏）
  await loadAndApplyTheme();

  // 第一步：恢复文件夹名（从 chrome.storage.local）
  try {
    const storedF = await chrome.storage.local.get(['folderName']);
    if (storedF.folderName) {
      folderName = storedF.folderName;
      console.log('[Popup] Restored folderName from storage:', folderName);
    }
  } catch (e) { console.log('[Popup] Load folderName failed:', e.message); }

  // 第二步：尝试恢复目录句柄（仅加载，不请求权限）
  try {
    const savedHandle = await loadDirHandle();
    if (savedHandle) {
      // 静默检查权限状态
      const perm = await savedHandle.queryPermission({ mode: 'readwrite' }).catch(() => 'denied');
      if (perm === 'granted') {
        dirHandle = savedHandle;
        needsReauth = false;
        console.log('[Popup] DirHandle restored with permission granted');
      } else {
        // 句柄有但权限不在 — 需要用户点击时重新授权
        dirHandle = savedHandle;
        needsReauth = true;
        console.log('[Popup] DirHandle restored but needs re-auth (perm:', perm, ')');
      }
    } else {
      console.log('[Popup] No saved DirHandle in IndexedDB');
    }
  } catch (e) { console.log('[Popup] Load dirHandle failed:', e.message); }

  updateFolderDisplay();
  updateStartButton();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || (!tab.url.includes('feishu.cn') && !tab.url.includes('larkoffice.com'))) {
      showError('请在飞书文档页面使用此插件');
      return;
    }
    originalUrl = tab.url;

    // 检查服务器
    const serverOk = await checkServer();
    const larkWarning = getLarkCliWarning();
    $serverStatus.innerHTML = serverOk
      ? `<span class="server-ok">● API 服务就绪</span>${larkWarning ? `<br><span class="server-err" style="font-size:11px">${larkWarning}</span>` : ''}`
      : '<span class="server-err">● API 服务未启动，使用 DOM 模式</span>';

    let apiArticles = [];
    let pageTitle = '';
    let discoverSource = 'none';
    let apiError = '';

    // 策略1: API
    if (serverOk) {
      try {
        const dr = await callApi('/discover', { url: originalUrl });
        if (!dr.error && dr.articles && dr.articles.length > 0) {
          apiArticles = dr.articles;
          pageTitle = dr.title || '';
          discoverSource = 'api';
        } else {
          apiError = dr.error || '无文章';
        }
      } catch (e) {
        apiError = '网络错误: ' + (e.message || e);
      }
    } else {
      apiError = 'API服务未启动';
    }

    // 策略2: DOM 兜底
    if (apiArticles.length === 0) {
      try {
        const resp = await sendMessageWithTimeout(tab.id, { action: 'getStructure' }, 8000);
        if (resp) {
          if (!pageTitle) pageTitle = resp.title || '';
          if (resp.articles && resp.articles.length > 0) {
            discoverSource = 'dom';
            apiArticles = resp.articles.map(a => ({
              title: a.title,
              doc_token: a.doc_token || extractTokenFromUrl(a.href || ''),
              url: a.href || originalUrl
            }));
          }
        }
      } catch (e) { apiError = apiError || ('DOM: ' + e.message); }
    }

    // 兜底：至少显示当前页面
    $pageTitle.textContent = pageTitle || '飞书文档';
    articles = apiArticles;
    if (articles.length === 0) {
      articles = [{ title: pageTitle || '当前页面', token: extractTokenFromUrl(originalUrl), url: originalUrl }];
    }
    // Tag top-level articles (parentIndex = -1) for tree view
    for (const a of articles) {
      if (typeof a.parentIndex !== 'number') a.parentIndex = -1;
    }

    // Reset search & selection & tree state on each init
    searchQuery = '';
    $searchInput.value = '';
    selectedSet = new Set(articles.map((_, i) => i));  // all selected by default
    expandedSet = new Set();
    childrenLoaded = new Set();
    childrenFailed = new Set();
    loadingParents = new Set();

    renderArticles();

    const uniqueTokens = new Set(articles.map(a => a.doc_token || a.token || '')).size;
    $debugInfo.innerHTML = `来源: ${discoverSource} | ${articles.length}篇 | ${uniqueTokens}个唯一token`;
    if (apiError) $debugInfo.innerHTML += ` | <span style="color:#${apiError.includes('未启动')?'ff9500':'8f959e'}">${apiError}</span>`;
    if (uniqueTokens < articles.length) $debugInfo.innerHTML += ' <span style="color:red">⚠️ Token重复!</span>';

    updateStartButton();

    const finalLarkWarning = getLarkCliWarning();
    $serverStatus.innerHTML = serverOk
      ? `<span class="server-ok">● API 服务就绪（${articles.length} 篇）</span>${finalLarkWarning ? `<br><span class="server-err" style="font-size:11px">${finalLarkWarning}</span>` : ''}`
      : '<span class="server-err">● API 服务未启动</span>';

  } catch (err) {
    showError('初始化失败: ' + err.message);
    console.error('[Popup] Init error:', err);
  }
}

function extractTokenFromUrl(url) {
  if (!url) return '';
  const parts = url.split('/');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === 'wiki' || parts[i] === 'docx' || parts[i] === 'docs') {
      if (i + 1 < parts.length) { let t = parts[i + 1]; if (t.includes('?')) t = t.split('?')[0]; return t; }
    }
  }
  const last = parts[parts.length - 1];
  return (last && last.length >= 20) ? last.split('?')[0] : '';
}

function showError(msg) {
  $errorMsg.textContent = msg;
  showStatus('status-error');
}

function updateStartButton() {
  const sel = getSelectedIndices();
  // 需要：至少选一篇文章 + 有文件夹名 + dirHandle 可用（不处于待授权状态）
  const hasDir = dirHandle && !needsReauth && folderName;
  $btnStart.disabled = (sel.length === 0) || !hasDir;

  if (sel.length === 0) {
    $btnStart.title = '请至少选择一篇文章';
  } else if (!folderName) {
    $btnStart.title = '请先点击左侧「选择文件夹」';
  } else if (needsReauth) {
    $btnStart.title = '请先点击「选择文件夹」重新授权';
  } else {
    $btnStart.title = '';
  }
}

// ============================================================
// 事件
// ============================================================

// 选择文件夹 — 优先尝试重新授权已保存的句柄
document.getElementById('btn-folder').addEventListener('click', async () => {
  try {
    // 如果有已保存的句柄但需要重新授权，先尝试授权
    if (dirHandle && needsReauth) {
      console.log('[Popup] Trying to re-auth existing handle...');
      const verified = await verifyOrRequestPermission(dirHandle);
      if (verified) {
        dirHandle = verified;
        needsReauth = false;
        console.log('[Popup] Re-auth succeeded');
        updateFolderDisplay();
        updateStartButton();
        return;
      }
      console.log('[Popup] Re-auth failed, will show picker');
      dirHandle = null;
      needsReauth = false;
    }

    // 打开新的目录选择器
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    folderName = dirHandle.name;
    needsReauth = false;

    // 持久化
    await chrome.storage.local.set({ folderName });
    await saveDirHandle(dirHandle);
    console.log('[Popup] New dirHandle saved:', folderName);

    updateFolderDisplay();
    updateStartButton();
  } catch (err) {
    if (err.name !== 'AbortError') console.error('[Popup] Folder picker error:', err);
    // 用户取消 — 如果之前有句柄但授权失败，保持 needsReauth 状态
    if (dirHandle && needsReauth) {
      updateFolderDisplay();
      updateStartButton();
    }
  }
});

// ============================================================
// 打开保存文件夹（v5.10）
// 首次需要用户输入完整路径（File System Access API 不暴露路径给 JS）
// ============================================================
async function openSavedFolder(forcePrompt = false) {
  let path = null;
  if (!forcePrompt) {
    try {
      const stored = await chrome.storage.local.get(['lastFolderPath']);
      path = (stored.lastFolderPath || '').trim();
    } catch (e) { /* fall through to prompt */ }
  }

  // 任何时候检测到占位符,一律视为无效,清掉重新提示 (修复 v5.10.0 残留坏路径)
  const hasPlaceholder = p => /yourname|<.*?>/.test(p || '');
  if (path && hasPlaceholder(path)) {
    console.warn('[OpenFolder] Stored path contains placeholder, clearing:', path);
    path = '';
    try { await chrome.storage.local.remove(['lastFolderPath']); } catch (e) {}
  }

  if (!path) {
    // v5.10.3: 用已选 folderName 拼出最可能的路径, 让用户只需要改用户名
    const selName = folderName || 'feishu-crawler';
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const isWin = navigator.platform.toLowerCase().includes('win');
    const defaultSuggestion = isMac
      ? `/Users/<你的用户名>/Documents/${selName}`
      : isWin
        ? `C:\\Users\\<你的用户名>\\Documents\\${selName}`
        : `/home/<你的用户名>/Documents/${selName}`;

    const howToFind = isMac
      ? '在 Finder 右键该文件夹 → 按住 Option 选择"将"文件名"拷贝为路径名"'
      : isWin
        ? '在文件管理器选中该文件夹 → 地址栏直接显示完整路径'
        : '在文件管理器选中该文件夹 → 属性中查看"位置"字段';

    const input = window.prompt(
      `请输入文件夹 "${selName}" 的完整路径:\n\n` +
      `预填(请把 <你的用户名> 改为真实用户名): ${defaultSuggestion}\n\n` +
      `不知道怎么找? ${howToFind}\n` +
      `点 "取消" 跳过(之后点 "📁 打开" 或下方"立即设置"按钮可再设)`,
      defaultSuggestion
    );
    if (input === null) return;  // user cancelled
    path = input.trim();
    if (!path) return;
    if (hasPlaceholder(path)) {
      alert('请将 <你的用户名> 替换为真实系统用户名后再试。\n\n收到：' + path);
      return;
    }
    try {
      await chrome.storage.local.set({ lastFolderPath: path });
    } catch (e) {
      console.warn('[OpenFolder] Failed to save path:', e.message);
    }
    await updatePathHint();  // 隐藏提示条
  }

  const originalLabel = '📁 打开';
  $btnOpenFolder.disabled = true;
  $btnOpenFolder.textContent = '打开中...';
  try {
    const result = await callApi('/open-folder', { path });
    if (result.error) {
      // 打开失败 → 清掉坏路径,下次点击重新提示
      try { await chrome.storage.local.remove(['lastFolderPath']); } catch (e) {}
      await updatePathHint();
      const retry = window.confirm(
        '打开失败：' + result.error + '\n\n是否重新输入路径？\n' +
        '(点 "取消" 仅关闭弹窗,下次打开将重新提示)'
      );
      if (retry) {
        await openSavedFolder(true);
      }
    } else {
      $folderPath.textContent = '✅ 已打开: ' + path;
      setTimeout(updateFolderDisplay, 2000);
    }
  } catch (e) {
    alert('网络错误: ' + (e.message || e));
  } finally {
    $btnOpenFolder.disabled = false;
    $btnOpenFolder.textContent = originalLabel;
  }
}

// 开始爬取前确保权限有效
async function ensureDirPermission() {
  if (!dirHandle) return false;
  if (needsReauth) {
    const verified = await verifyOrRequestPermission(dirHandle);
    if (!verified) return false;
    dirHandle = verified;
    needsReauth = false;
  }
  return true;
}

// Select all visible (respects current search filter)
document.getElementById('btn-select-all').addEventListener('click', () => {
  $articleList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    const idx = parseInt(cb.dataset.idx);
    selectedSet.add(idx);
    cb.checked = true;
  });
  $articleCount.textContent = (searchQuery.trim()
    ? `${selectedSet.size} / ${~~$articleList.querySelectorAll('input[type="checkbox"]').length} / ${articles.length}`
    : `${selectedSet.size} / ${articles.length}`);
  updateStartButton();
});
// Deselect all visible (does NOT affect items hidden by the filter)
document.getElementById('btn-deselect-all').addEventListener('click', () => {
  $articleList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    const idx = parseInt(cb.dataset.idx);
    selectedSet.delete(idx);
    cb.checked = false;
  });
  updateStartButton();
});
// Sync selectedSet when user toggles a checkbox
$articleList.addEventListener('change', e => {
  if (e.target.type !== 'checkbox') return;
  const idx = parseInt(e.target.dataset.idx);
  if (e.target.checked) selectedSet.add(idx);
  else selectedSet.delete(idx);
  updateStartButton();
});
// Search filter
$searchInput.addEventListener('input', e => {
  searchQuery = e.target.value;
  renderArticles();
});

// Tree: per-item caret click (toggle expand/collapse for one parent)
$articleList.addEventListener('click', e => {
  const caret = e.target.closest('.tree-caret');
  if (!caret || !caret.dataset.toggle) return;
  e.preventDefault();
  const idx = parseInt(caret.dataset.toggle);
  if (expandedSet.has(idx)) {
    expandedSet.delete(idx);
    renderArticles();
    return;
  }
  discoverChildrenOf(idx).then(result => {
    if (result.ok) {
      expandedSet.add(idx);
      if (result.count === 0 && !result.cached) {
        const a = articles[idx];
        const resp = result.response || {};
        const ws = resp.wiki_status || 'unknown';
        const msg = `"${a?.title || ''}" 没有子文档 (wiki_status=${ws})`;
        showTreeError(msg, result.response);
      }
      renderArticles();
    } else if (result.reason === 'api-error' || result.reason === 'network-error') {
      const a = articles[idx];
      const title = a ? a.title : `#${idx}`;
      showTreeError(`展开 "${title}" 失败：${result.error || '未知错误'}（点 ✖ 重试）`, result.response);
    }
  });
});

function showTreeError(msg, response) {
  console.warn('[Tree]', msg, response);
  const $status = document.getElementById('status');
  if ($status) {
    $status.textContent = msg;
    $status.classList.add('status-error');
    clearTimeout(showTreeError._t);
    showTreeError._t = setTimeout(() => {
      $status.classList.remove('status-error');
    }, 8000);
  }
  appendTreeDebug(`❌ ${msg}`);
  if (response) {
    if (response.wiki_status) {
      appendTreeDebug(`  wiki_status: ${response.wiki_status}`);
    }
    if (response.message) {
      appendTreeDebug(`  message: ${response.message}`);
    }
    appendTreeDebug('完整响应: ' + JSON.stringify(response, null, 2));
  }
}

// Tree: "展开/折叠全部" button
document.getElementById('btn-tree-toggle').addEventListener('click', async () => {
  const parents = getParentIndices(articles);
  if (parents.length === 0) return;
  if (allExpanded(articles, expandedSet)) {
    for (const i of parents) expandedSet.delete(i);
    renderArticles();
  } else {
    await discoverAllUnloaded();
    for (const i of parents) expandedSet.add(i);
    renderArticles();
  }
});

// ============================================================
// 并发原语
// ============================================================

// 信号量：限制同时执行的任务数。
class Semaphore {
  constructor(n) { this._n = n; this._waiters = []; }
  async acquire() {
    if (this._n > 0) { this._n--; return; }
    await new Promise(r => this._waiters.push(r));
  }
  release() {
    const w = this._waiters.shift();
    if (w) w();          // hand the slot to the next waiter
    else this._n++;      // no one waiting → return to pool
  }
}

// 并发调度器：使用信号量保证实际并发数严格 <= limit。
// isCancelledFn() 返回 true 时停止派发新任务（在飞的会自然完成）。
async function runPool(items, limit, worker, isCancelledFn) {
  if (items.length === 0) return;
  const sem = new Semaphore(limit);
  await Promise.all(items.map(async (item, i) => {
    if (isCancelledFn && isCancelledFn()) return;
    await sem.acquire();
    // Re-check after acquire: items may have queued while pool was saturated.
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

// 原子文件名分配：同一目录下同一 (base, ext) 链式排队，
// 避免并发 worker 撞到同一个名字。
// 不同 dirHandle 隔离（通过 WeakMap 标签）。
const _dirTagCounter = { n: 0 };
const _dirTags = new WeakMap();
function getDirTag(dirHandle) {
  let tag = _dirTags.get(dirHandle);
  if (!tag) {
    tag = `d${++_dirTagCounter.n}`;
    _dirTags.set(dirHandle, tag);
  }
  return tag;
}
const _nameChains = new Map();  // key -> tail Promise

function allocUniqueName(dirHandle, base, ext) {
  const key = `${getDirTag(dirHandle)}::${base}.${ext}`;
  const prev = _nameChains.get(key) || Promise.resolve();
  const next = prev.then(async () => {
    for (let n = 1; n < 1000; n++) {
      const name = n === 1 ? `${base}.${ext}` : `${base}_${n}.${ext}`;
      let exists = false;
      try {
        await dirHandle.getFileHandle(name, { create: false });
        exists = true;
      } catch (_) { /* not found -> unused */ }
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

// 更新爬取中的进度文案（处理中的文章列表）
function updateCrawlProgress() {
  const titles = [...inFlightTitles].slice(0, 3);
  const more = inFlightTitles.size > 3 ? ` 等 ${inFlightTitles.size} 篇` : '';
  const tail = titles.length > 0 ? ` — 处理中: ${titles.join(', ')}${more}` : '';
  $crawlCurrent.textContent = `完成 ${okCount + failCount}${tail}`;
  $crawlStats.textContent = `✅ ${okCount}  ❌ ${failCount}`;
}

// ============================================================
// 爬取
// ============================================================
$btnStart.addEventListener('click', async () => {
  // 点击时重新验证权限
  if (!(await ensureDirPermission())) {
    alert('目录权限已过期，请重新选择保存文件夹');
    dirHandle = null;
    folderName = '';
    updateFolderDisplay();
    updateStartButton();
    return;
  }
  if (!dirHandle || !folderName) return alert('请先选择保存文件夹');
  if (crawlInProgress) return;

  // 自动发现未展开的父节点的子文档（保持 v5.7 行为：点 Start 即可爬全部）
  const beforeCount = articles.length;
  const newChildrenCount = await discoverAllUnloaded();
  if (newChildrenCount > 0) {
    // 把新发现的父节点和子文档都加入选择（用户没在树视图里勾选过它们）
    for (let i = 0; i < articles.length; i++) {
      if (articles[i].has_child) selectedSet.add(i);
    }
    for (let i = beforeCount; i < articles.length; i++) {
      selectedSet.add(i);
    }
    renderArticles();
  }

  const selected = getSelectedIndices();
  if (selected.length === 0) return alert('请至少选择一个章节');

  console.log(`[Crawler] Starting crawl: ${selected.length} articles selected`);
  console.log('[Crawler] Articles:', articles.map((a,i) => `[${i}] ${a.title} token=${a.doc_token||a.token||'NONE'}`));

  crawlInProgress = true;
  isCancelled = false;
  showStatus('status-crawling');
  $progressBar.style.width = '0%';

  // Reset shared crawl state
  inFlightTitles = new Set();
  okCount = 0;
  failCount = 0;
  _nameChains.clear();
  updateCrawlProgress();

  let imagesDir;
  try { imagesDir = await dirHandle.getDirectoryHandle('images', { create: true }); }
  catch (e) { imagesDir = await dirHandle.getDirectoryHandle('images'); }

  const targets = selected.map(i => {
    const a = articles[i];
    console.log(`[Crawler] Target #${i}: ${a.title} | doc_token=${a.doc_token} | token=${a.token} | url=${a.url}`);
    return a;
  });

  const total = targets.length;
  const okFiles = [], failFiles = [];

  // 处理单篇文章：extract → 并行下图片 → 原子写文件
  async function processArticle(art) {
    if (isCancelled) return;
    inFlightTitles.add(art.title);
    updateCrawlProgress();

    try {
      const body = {};
      if (art.doc_token) body.token = art.doc_token;
      else if (art.token) body.token = art.token;
      else if (art.url) body.url = art.url;
      else body.url = originalUrl;

      const result = await callApi('/extract', body);
      if (isCancelled) return;
      if (result.error) throw new Error(result.error);

      let md = result.content || '';
      const title = result.title || art.title;
      const imgs = result.images || [];

      console.log(`[Crawler] ${art.title}: ${md.length} chars, ${imgs.length} images`);

      // 并行下图片（同一文章内最多 2 路）
      if (imgs.length > 0) {
        const urlReplacements = [];
        await runPool(imgs, MAX_IMAGE_CONCURRENCY, async (img, j) => {
          if (isCancelled) return;
          const fileToken = img.file_token;
          if (!fileToken) return;
          try {
            const imgResult = await callApi('/download-image', { file_token: fileToken });
            if (isCancelled) return;
            if (imgResult && imgResult.ok && imgResult.data) {
              const byteChars = atob(imgResult.data);
              const byteNums = new Uint8Array(byteChars.length);
              for (let k = 0; k < byteChars.length; k++) byteNums[k] = byteChars.charCodeAt(k);
              const blob = new Blob([byteNums], { type: 'image/' + img.ext });
              if (blob.size > 1000) {
                const desiredBase = sanitizeFilename(title) + '_' + (j + 1);
                const name = await allocUniqueName(imagesDir, desiredBase, img.ext);
                const fh = await imagesDir.getFileHandle(name, { create: true });
                const w = await fh.createWritable(); await w.write(blob); await w.close();
                urlReplacements.push({ from: img.url, to: './images/' + name });
                console.log(`[Crawler] Image saved: ${name} (${blob.size} bytes)`);
              } else {
                console.warn(`[Crawler] Image too small: ${blob.size} bytes`);
              }
            } else {
              console.warn(`[Crawler] Image failed:`, imgResult?.error);
            }
          } catch (ie) {
            console.warn(`[Crawler] Image error:`, ie.message);
          }
        }, () => isCancelled);
        // Apply URL replacements sequentially after all downloads finish
        for (const r of urlReplacements) {
          md = md.split(r.from).join(r.to);
        }
      }

      if (isCancelled) return;

      const full = '# ' + title + '\n\n' + md;
      const fn = await allocUniqueName(dirHandle, sanitizeFilename(title), 'md');
      const fh = await dirHandle.getFileHandle(fn, { create: true });
      const w = await fh.createWritable(); await w.write(full); await w.close();

      okCount++;
      okFiles.push(fn);
      console.log(`[Crawler] ✅ Saved: ${fn} (${full.length} chars)`);
    } catch (err) {
      failCount++;
      failFiles.push(art.title + ': ' + err.message);
      console.error(`[Crawler] ❌ FAIL: ${art.title}`, err);
    } finally {
      inFlightTitles.delete(art.title);
      $progressBar.style.width = Math.round(((okCount + failCount) / total) * 100) + '%';
      updateCrawlProgress();
    }
  }

  // 并发池跑所有文章（最多 3 路）
  await runPool(targets, MAX_ARTICLE_CONCURRENCY, processArticle, () => isCancelled);

  crawlInProgress = false;
  console.log(`[Crawler] Done: ${okCount} ok, ${failCount} fail (cancelled=${isCancelled})`);

  let msg = okCount > 0 ? `✅ 成功保存 ${okCount} 个文件` : '';
  if (okFiles.length <= 5 && okFiles.length > 0) msg += ':\n  ' + okFiles.join('\n  ');
  if (failCount > 0) msg += `\n❌ 失败 ${failCount} 个:\n  ` + failFiles.slice(0, 3).join('\n  ');
  if (isCancelled) msg += '\n⚠️ 已取消（部分文章可能未开始）';

  $completeMsg.innerHTML = msg.replace(/\n/g, '<br>');
  showStatus('status-complete');
});

document.getElementById('btn-cancel').addEventListener('click', () => { isCancelled = true; });
document.getElementById('btn-reset').addEventListener('click', init);
document.getElementById('btn-retry').addEventListener('click', init);
document.getElementById('btn-error-back').addEventListener('click', init);
$btnTheme.addEventListener('click', toggleTheme);
$btnOpenFolder.addEventListener('click', () => openSavedFolder(false));
document.getElementById('btn-edit-folder-path').addEventListener('click', async () => {
  // 显式编辑路径 — 永远弹出 prompt,忽略已存值
  try { await chrome.storage.local.remove(['lastFolderPath']); } catch (e) {}
  await openSavedFolder(true);
});
document.getElementById('btn-set-folder-path').addEventListener('click', async () => {
  // hint 提示条上的 "立即设置" 按钮 → 跟 ✏️ 等价
  try { await chrome.storage.local.remove(['lastFolderPath']); } catch (e) {}
  await openSavedFolder(true);
});

// 树形调试面板折叠/展开
document.getElementById('btn-tree-debug-toggle').addEventListener('click', () => {
  const $log = document.getElementById('tree-debug-log');
  const $btn = document.getElementById('btn-tree-debug-toggle');
  if ($log.style.display === 'none') {
    $log.style.display = 'block';
    $btn.textContent = '收起';
  } else {
    $log.style.display = 'none';
    $btn.textContent = '展开';
  }
});
document.getElementById('btn-tree-debug-copy').addEventListener('click', async () => {
  const $log = document.getElementById('tree-debug-log');
  const text = $log ? $log.textContent : '';
  try {
    await navigator.clipboard.writeText(text);
    const $btn = document.getElementById('btn-tree-debug-copy');
    const orig = $btn.textContent;
    $btn.textContent = '✅ 已复制';
    setTimeout(() => { $btn.textContent = orig; }, 1500);
  } catch (e) {
    alert('复制失败: ' + e.message);
  }
});

init();
