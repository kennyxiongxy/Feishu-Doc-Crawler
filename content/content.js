// content.js — 飞书文档侧边栏目录发现 v4.5
// 只读扫描，不执行任何点击操作

(function () {
  'use strict';

  function debug(msg, data) {
    console.log('[FeishuCrawler]', msg, data || '');
  }

  function cleanText(text) {
    return (text || '').replace(/^[\s\u200b\u200c\u200d\uFEFF]+/g, '').replace(/[\s\u00a0]+$/g, '').trim();
  }

  function isNoise(text) {
    var t = (text || '').toLowerCase();
    var patterns = [
      'ai 速览', 'ai速览', 'ai summary', '反向引用', 'backlink',
      '本文引用', 'reference', '关系图', 'graph', 'relation',
      '你可能还想问', '你可能还想看', 'related', '页面信息',
      '点赞', '评论', '分享到', '复制链接', '举报', '反馈',
      '帮助中心', '回收站', '已删除', '更多', '展开', '折叠',
      '添加页面', '新建页面', '添加子页面', '更多操作'
    ];
    for (var i = 0; i < patterns.length; i++) {
      if (t.indexOf(patterns[i].toLowerCase()) !== -1) return true;
    }
    if (/^[\s\d\.\,\、\;\:\!\?\-\+\=\_\/\|\\@\#\$\%\^\&\*\(\)\[\]\{\}<>\"\'\`\~，。！？；：""'']+$/.test(text)) return true;
    return false;
  }

  function estimateIndent(el) {
    var left = el.getBoundingClientRect().left;
    if (left < 50) return 0;
    if (left < 100) return 1;
    if (left < 160) return 2;
    if (left < 220) return 3;
    return 0;
  }

  // ============================================================
  // 发现根页面 URL（只读扫描）
  // ============================================================
  function findRootUrl() {
    var baseUrl = window.location.origin + '/wiki/';
    var currentToken = window.location.pathname.split('/wiki/')[1];
    if (currentToken) currentToken = currentToken.split('?')[0].split('#')[0];

    // 策略A: 扫描 data 属性
    var sidebarSelectors = [
      '[class*="sidebar"]', '[class*="Sidebar"]', '[class*="side-bar"]',
      '[class*="left-panel"]', '[class*="nav-tree"]', '[class*="workspace-nav"]',
      '[role="tree"]', '[role="navigation"]'
    ];

    for (var si = 0; si < sidebarSelectors.length; si++) {
      var containers = document.querySelectorAll(sidebarSelectors[si]);
      for (var ci = 0; ci < containers.length; ci++) {
        var el = containers[ci];
        var rect = el.getBoundingClientRect();
        if (rect.left > 500 || rect.width < 100) continue;

        var pageEls = el.querySelectorAll('[data-page-id]');
        for (var pi = 0; pi < pageEls.length; pi++) {
          var pageId = pageEls[pi].getAttribute('data-page-id');
          if (pageId && pageId.length > 15 && pageId !== currentToken) {
            return baseUrl + pageId;
          }
        }

        var nodeEls = el.querySelectorAll('[data-node-id]');
        for (var ni = 0; ni < nodeEls.length; ni++) {
          var nodeId = nodeEls[ni].getAttribute('data-node-id');
          if (nodeId && nodeId.length > 15 && nodeId !== currentToken) {
            return baseUrl + nodeId;
          }
        }
      }
    }

    // 策略B: 从 wiki 链接中找最短路径的
    var allLinks = document.querySelectorAll('a[href*="/wiki/"]');
    var bestLink = null, bestScore = Infinity;

    for (var ai = 0; ai < allLinks.length; ai++) {
      var a = allLinks[ai];
      var ar = a.getBoundingClientRect();
      if (ar.left > 500 || ar.width < 40) continue;
      var token = a.href.split('/wiki/')[1];
      if (!token) continue;
      token = token.split('?')[0].split('#')[0];
      if (token === currentToken) continue;
      var score = token.split('/').length * 100 + ar.top;
      if (score < bestScore) {
        bestScore = score;
        bestLink = a.href;
      }
    }

    return bestLink || '';
  }

  // ============================================================
  // 获取侧边栏文章列表（只读扫描）
  // ============================================================
  function findSidebarArticles() {
    var articles = [];
    var seen = {};
    var baseUrl = window.location.origin + '/wiki/';
    var currentToken = window.location.pathname.split('/wiki/')[1];
    if (currentToken) currentToken = currentToken.split('?')[0].split('#')[0];

    // 在侧边栏区域找
    var sidebarSelectors = [
      '[class*="sidebar"]', '[class*="Sidebar"]', '[class*="side-bar"]',
      '[class*="left-panel"]', '[class*="nav-tree"]', '[class*="workspace-nav"]',
      '[role="tree"]'
    ];

    for (var si = 0; si < sidebarSelectors.length; si++) {
      var containers = document.querySelectorAll(sidebarSelectors[si]);
      for (var ci = 0; ci < containers.length; ci++) {
        var el = containers[ci];
        var rect = el.getBoundingClientRect();
        if (rect.left > 500 || rect.width < 100) continue;

        // 从 data-page-id 获取
        var pageEls = el.querySelectorAll('[data-page-id]');
        for (var pi = 0; pi < pageEls.length; pi++) {
          var pageId = pageEls[pi].getAttribute('data-page-id');
          if (!pageId || pageId.length < 15) continue;
          var text = cleanText(pageEls[pi].textContent || '');
          if (!text || text.length < 3 || text.length > 150) continue;
          if (isNoise(text)) continue;
          if (pageId === currentToken) continue;
          if (seen[pageId]) continue;
          seen[pageId] = true;
          articles.push({
            title: text, href: baseUrl + pageId,
            doc_token: pageId, indent: estimateIndent(pageEls[pi]), type: 'page'
          });
        }

        // 从 wiki 链接获取
        var links = el.querySelectorAll('a[href*="/wiki/"]');
        for (var li = 0; li < links.length; li++) {
          var a = links[li];
          var token = a.href.split('/wiki/')[1];
          if (!token) continue;
          token = token.split('?')[0].split('#')[0];
          if (token === currentToken) continue;
          if (seen[token]) continue;
          var text = cleanText(a.textContent || '');
          if (!text || text.length < 3 || text.length > 150) continue;
          if (isNoise(text)) continue;
          seen[token] = true;
          articles.push({
            title: text, href: a.href,
            doc_token: token, indent: estimateIndent(a), type: 'page'
          });
        }

        if (articles.length >= 3) return articles;
      }
    }

    // 兜底：页面所有 wiki 链接
    var allLinks = document.querySelectorAll('a[href*="/wiki/"]');
    for (var ai = 0; ai < allLinks.length; ai++) {
      var la = allLinks[ai];
      var lr = la.getBoundingClientRect();
      if (lr.left > 500 || lr.width < 40) continue;
      var token = la.href.split('/wiki/')[1];
      if (!token) continue;
      token = token.split('?')[0].split('#')[0];
      if (token === currentToken) continue;
      if (seen[token]) continue;
      var text = cleanText(la.textContent || '');
      if (!text || text.length < 3 || text.length > 150) continue;
      if (isNoise(text)) continue;
      seen[token] = true;
      articles.push({
        title: text, href: la.href,
        doc_token: token, indent: estimateIndent(la), type: 'page'
      });
    }

    return articles;
  }

  // ============================================================
  // 主入口（只读）
  // ============================================================
  function getArticleStructure() {
    var articles = findSidebarArticles();
    var rootUrl = findRootUrl();
    debug('Articles: ' + articles.length + ', rootUrl: ' + rootUrl);
    return { articles: articles, rootUrl: rootUrl };
  }

  // ============================================================
  // 消息处理
  // ============================================================
  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request.action === 'getStructure') {
      var result = getArticleStructure();
      var title = cleanText((document.title || '').replace(/\s*[-–—]\s*(飞书|Feishu|Lark).*$/, ''));
      sendResponse({
        title: title || '飞书文档',
        articles: result.articles,
        rootUrl: result.rootUrl,
        currentUrl: window.location.href,
        currentHash: window.location.hash
      });
    } else if (request.action === 'fetchImage') {
      var url = request.url;
      console.log('[FeishuCrawler] downloadImage:', url.substring(0, 80));
      chrome.downloads.download({ url: url, saveAs: false, conflictAction: 'uniquify' }, function(downloadId) {
        if (chrome.runtime.lastError) {
          console.warn('[FeishuCrawler] download failed:', chrome.runtime.lastError.message);
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        console.log('[FeishuCrawler] download id:', downloadId);
        var listener = function(delta) {
          if (delta.id !== downloadId) return;
          if (delta.state && delta.state.current === 'complete') {
            chrome.downloads.onChanged.removeListener(listener);
            chrome.downloads.search({ id: downloadId }, function(results) {
              if (!results || results.length === 0) { sendResponse({ ok: false, error: 'not found' }); return; }
              var p = results[0].filename;
              var s = results[0].fileSize || 0;
              console.log('[FeishuCrawler] complete:', p, s, 'bytes');
              sendResponse({ ok: true, filePath: p, size: s });
            });
          } else if (delta.state && delta.state.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            sendResponse({ ok: false, error: 'interrupted' });
          }
        };
        chrome.downloads.onChanged.addListener(listener);
        setTimeout(function() { chrome.downloads.onChanged.removeListener(listener); chrome.downloads.cancel(downloadId); sendResponse({ ok: false, error: 'timeout' }); }, 30000);
      });
      return true;
    } else if (request.action === 'ping') {
      sendResponse({ pong: true, url: window.location.href });
    } else if (request.action === 'debug') {
      var els = document.querySelectorAll('[data-page-id], [data-node-id], [data-block-id]');
      var attrs = [];
      for (var i = 0; i < Math.min(els.length, 20); i++) {
        var e = els[i], r = e.getBoundingClientRect();
        attrs.push({
          tag: e.tagName,
          pageId: e.getAttribute('data-page-id') || '',
          nodeId: e.getAttribute('data-node-id') || '',
          text: cleanText(e.textContent || '').substring(0, 40),
          left: Math.round(r.left), top: Math.round(r.top)
        });
      }
      sendResponse({
        url: window.location.href, title: document.title,
        rootUrl: findRootUrl(),
        articlesCount: findSidebarArticles().length,
        sidebarDataAttrs: attrs
      });
    }
    return true;
  });

})();
