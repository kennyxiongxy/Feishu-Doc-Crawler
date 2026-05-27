// popup.js — 飞书文档爬取助手 v4.3
// 增强调试：显示 token 信息，详细日志

const API_BASE = 'http://127.0.0.1:8765';

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
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readonly');
      const store = tx.objectStore('handles');
      const req = store.get('dirHandle');
      req.onsuccess = () => {
        const handle = req.result;
        if (handle) {
          // 验证权限
          handle.queryPermission({ mode: 'readwrite' }).then(perm => {
            if (perm === 'granted') {
              resolve(handle);
            } else {
              handle.requestPermission({ mode: 'readwrite' }).then(newPerm => {
                resolve(newPerm === 'granted' ? handle : null);
              }).catch(() => resolve(null));
            }
          }).catch(() => resolve(null));
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch (e) {
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

// DOM refs
const $loading = document.getElementById('status-loading');
const $ready = document.getElementById('status-ready');
const $crawling = document.getElementById('status-crawling');
const $complete = document.getElementById('status-complete');
const $error = document.getElementById('status-error');

const $pageTitle = document.getElementById('page-title');
const $articleCount = document.getElementById('article-count');
const $articleList = document.getElementById('article-list');
const $folderPath = document.getElementById('folder-path');
const $btnStart = document.getElementById('btn-start');
const $serverStatus = document.getElementById('server-status');
const $debugInfo = document.getElementById('debug-info');

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
// API 调用
// ============================================================
async function checkServer() {
  try {
    const resp = await fetch(`${API_BASE}/health`, { method: 'GET', signal: abortTimeout(3000) });
    if (resp.ok) { const data = await resp.json(); if (data.status === 'ok') { serverAvailable = true; return true; } }
  } catch (e) { console.log('[Popup] Server check failed:', e.message); }
  serverAvailable = false;
  return false;
}

async function callApi(endpoint, body) {
  console.log(`[Popup] API ${endpoint} <-`, JSON.stringify(body).substring(0, 80));
  const resp = await fetch(`${API_BASE}${endpoint}`, {
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
// 文章列表
// ============================================================
function renderArticles() {
  $articleCount.textContent = articles.length;
  $articleList.innerHTML = articles.map((a, i) => {
    const token = a.doc_token || a.token || '';
    const tokenShort = token ? token.substring(0, 12) : 'NO-TOKEN';
    return `
    <label class="article-item" title="Token: ${token}">
      <input type="checkbox" value="${i}" checked>
      <span class="type-badge">${a.has_child ? '📁' : '📄'}</span>
      <span class="article-title">${escapeHtml(a.title)}</span>
      <span class="token-hint">${tokenShort}</span>
    </label>`;
  }).join('');

  if (articles.length === 0) {
    $articleList.innerHTML = '<div class="no-articles">未发现子文章，将抓取当前页面</div>';
    articles = [{ title: '当前页面', token: null, url: originalUrl, doc_token: null }];
    $articleCount.textContent = '1';
    $articleList.innerHTML = `<label class="article-item active-article">
      <input type="checkbox" value="0" checked>
      <span class="type-badge">📄</span>
      <span class="article-title">当前页面</span>
      <span class="token-hint">FALLBACK</span></label>`;
  }
}

function getSelectedIndices() {
  const cbs = $articleList.querySelectorAll('input[type="checkbox"]');
  const sel = [];
  cbs.forEach(cb => { if (cb.checked) sel.push(parseInt(cb.value)); });
  console.log('[Popup] Selected indices:', sel, 'from', cbs.length, 'checkboxes');
  return sel;
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
  updateStartButton();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('feishu.cn')) {
      showError('请在飞书文档页面使用此插件');
      return;
    }
    originalUrl = tab.url;

    // 检查服务器
    const serverOk = await checkServer();
    $serverStatus.innerHTML = serverOk
      ? '<span class="server-ok">● API 服务就绪</span>'
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

    // 恢复已保存的目录句柄
    try {
      const savedHandle = await loadDirHandle();
      if (savedHandle) {
        dirHandle = savedHandle;
        const storedF = await chrome.storage.local.get(['folderName']);
        if (storedF.folderName) {
          folderName = storedF.folderName;
          $folderPath.textContent = folderName;
          $folderPath.style.color = '#1f2329';
        }
      }
    } catch (e) { console.log('Load dirHandle failed:', e.message); }

    renderArticles();

    const uniqueTokens = new Set(articles.map(a => a.doc_token || a.token || '')).size;
    $debugInfo.innerHTML = `来源: ${discoverSource} | ${articles.length}篇 | ${uniqueTokens}个唯一token`;
    if (apiError) $debugInfo.innerHTML += ` | <span style="color:#${apiError.includes('未启动')?'ff9500':'8f959e'}">${apiError}</span>`;
    if (uniqueTokens < articles.length) $debugInfo.innerHTML += ' <span style="color:red">⚠️ Token重复!</span>';

    updateStartButton();

    $serverStatus.innerHTML = serverOk
      ? `<span class="server-ok">● API 服务就绪（${articles.length} 篇）</span>`
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
  $btnStart.disabled = (sel.length === 0) || !folderName;
}

// ============================================================
// 事件
// ============================================================
document.getElementById('btn-folder').addEventListener('click', async () => {
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    folderName = dirHandle.name;
    $folderPath.textContent = folderName;
    $folderPath.style.color = '#1f2329';
    await chrome.storage.local.set({ folderName });
    await saveDirHandle(dirHandle);
    updateStartButton();
  } catch (err) { if (err.name !== 'AbortError') console.error(err); }
});

document.getElementById('btn-select-all').addEventListener('click', () => {
  $articleList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
  updateStartButton();
});
document.getElementById('btn-deselect-all').addEventListener('click', () => {
  $articleList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  updateStartButton();
});
$articleList.addEventListener('change', e => { if (e.target.type === 'checkbox') updateStartButton(); });

// ============================================================
// 爬取
// ============================================================
$btnStart.addEventListener('click', async () => {
  if (!dirHandle || !folderName) return alert('请先选择保存文件夹');
  if (crawlInProgress) return;

  const selected = getSelectedIndices();
  if (selected.length === 0) return alert('请至少选择一个章节');

  console.log(`[Crawler] Starting crawl: ${selected.length} articles selected`);
  console.log('[Crawler] Articles:', articles.map((a,i) => `[${i}] ${a.title} token=${a.doc_token||a.token||'NONE'}`));

  crawlInProgress = true;
  isCancelled = false;
  showStatus('status-crawling');
  $progressBar.style.width = '0%';

  let imagesDir;
  try { imagesDir = await dirHandle.getDirectoryHandle('images', { create: true }); }
  catch (e) { imagesDir = await dirHandle.getDirectoryHandle('images'); }

  const targets = selected.map(i => {
    const a = articles[i];
    console.log(`[Crawler] Target #${i}: ${a.title} | doc_token=${a.doc_token} | token=${a.token} | url=${a.url}`);
    return a;
  });
  
  // 展开带有子文档的文章 (has_child: true)
  console.log(`[Crawler] Checking ${targets.length} targets for children...`);
  const childTargets = [];
  for (const t of targets) {
    if (t.has_child) {
      console.log(`[Crawler] Expanding children of: ${t.title}`);
      $crawlStats.textContent = `正在发现 "${t.title}" 的子文档...`;
      try {
        const childResult = await callApi('/discover', { token: t.doc_token || t.token });
        if (childResult.articles && childResult.articles.length > 0) {
          console.log(`[Crawler] Found ${childResult.articles.length} children for: ${t.title}`);
          for (const child of childResult.articles) {
            childTargets.push(child);
          }
        }
      } catch (e) {
        console.warn(`[Crawler] Failed to discover children of: ${t.title}`, e.message);
      }
    }
  }
  targets.push(...childTargets);
  console.log(`[Crawler] Total targets after expansion: ${targets.length} (added ${childTargets.length} children)`);
  const total = targets.length;
  let done = 0, okCount = 0, failCount = 0;
  const okFiles = [], failFiles = [];

  for (let i = 0; i < targets.length; i++) {
    if (isCancelled) break;
    const art = targets[i];

    console.log(`[Crawler] === Iteration ${i+1}/${total}: ${art.title} ===`);
    $crawlCurrent.textContent = `[${i + 1}/${total}] ${art.title}`;
    $crawlStats.textContent = `正在调用 API...`;

    try {
      const body = {};
      if (art.doc_token) {
        body.token = art.doc_token;
        console.log(`[Crawler] Using doc_token: ${art.doc_token}`);
      } else if (art.token) {
        body.token = art.token;
        console.log(`[Crawler] Using token: ${art.token}`);
      } else if (art.url) {
        body.url = art.url;
        console.log(`[Crawler] Using url: ${art.url}`);
      } else {
        body.url = originalUrl;
        console.log(`[Crawler] FALLBACK to originalUrl: ${originalUrl}`);
      }

      const result = await callApi('/extract', body);
      if (result.error) throw new Error(result.error);

      let md = result.content || '';
      const title = result.title || art.title;
      const imgs = result.images || [];

      console.log(`[Crawler] Got content: title="${title}", ${md.length} chars, ${imgs.length} images`);

      // 图片下载（通过服务端 lark-cli media-preview）
      for (let j = 0; j < imgs.length; j++) {
        if (isCancelled) break;
        const fileToken = imgs[j].file_token;
        if (!fileToken) continue;
        try {
          $crawlStats.textContent = `下载图片 ${j+1}/${imgs.length}...`;
          const imgResult = await callApi('/download-image', { file_token: fileToken });
          if (imgResult && imgResult.ok && imgResult.data) {
            const byteChars = atob(imgResult.data);
            const byteNums = new Uint8Array(byteChars.length);
            for (let k = 0; k < byteChars.length; k++) byteNums[k] = byteChars.charCodeAt(k);
            const blob = new Blob([byteNums], { type: 'image/' + imgs[j].ext });
            if (blob.size > 1000) {
              const name = sanitizeFilename(title) + '_' + (j + 1) + '.' + imgs[j].ext;
              const fh = await imagesDir.getFileHandle(name, { create: true });
              const w = await fh.createWritable(); await w.write(blob); await w.close();
              md = md.split(imgs[j].url).join('./images/' + name);
              console.log(`[Crawler] Image saved: ${name} (${blob.size} bytes)`);
            } else {
              console.warn(`[Crawler] Image too small (${blob.size} bytes)`);
            }
          } else {
            console.warn(`[Crawler] Image failed:`, imgResult?.error);
          }
        } catch (ie) {
          console.warn(`[Crawler] Image error:`, ie.message);
        }
      }

      const full = '# ' + title + '\n\n' + md;

      // 文件名去重
      let fn = sanitizeFilename(title) + '.md';
      try {
        await dirHandle.getFileHandle(fn);
        const base = sanitizeFilename(title);
        for (let s = 2; s < 100; s++) {
          try { await dirHandle.getFileHandle(base + '_' + s + '.md'); }
          catch (e) { fn = base + '_' + s + '.md'; break; }
        }
      } catch (e) {}

      const fh = await dirHandle.getFileHandle(fn, { create: true });
      const w = await fh.createWritable(); await w.write(full); await w.close();

      okCount++;
      okFiles.push(fn);
      console.log(`[Crawler] ✅ Saved: ${fn} (${full.length} chars)`);
      $crawlStats.textContent = `${done + 1}/${total} 已完成`;
    } catch (err) {
      failCount++;
      failFiles.push(art.title + ': ' + err.message);
      console.error(`[Crawler] ❌ FAIL #${i+1}: ${art.title}`, err);
      $crawlStats.textContent = `${done + 1}/${total} (${failCount} 失败)`;
    }

    done++;
    $progressBar.style.width = Math.round((done / total) * 100) + '%';
  }

  crawlInProgress = false;
  console.log(`[Crawler] Done: ${okCount} ok, ${failCount} fail`);

  let msg = okCount > 0 ? `✅ 成功保存 ${okCount} 个文件` : '';
  if (okFiles.length <= 5) msg += ':\n  ' + okFiles.join('\n  ');
  if (failCount > 0) msg += `\n❌ 失败 ${failCount} 个:\n  ` + failFiles.slice(0, 3).join('\n  ');
  if (isCancelled) msg += '\n⚠️ 已取消';

  $completeMsg.innerHTML = msg.replace(/\n/g, '<br>');
  showStatus('status-complete');
});

document.getElementById('btn-cancel').addEventListener('click', () => { isCancelled = true; });
document.getElementById('btn-reset').addEventListener('click', init);
document.getElementById('btn-retry').addEventListener('click', init);
document.getElementById('btn-error-back').addEventListener('click', init);

init();
