// background.js — Service Worker

chrome.runtime.onInstalled.addListener(() => {
  console.log('飞书文档爬取助手已安装');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchImage') {
    const url = request.url;
    const filename = request.filename || ('img_' + Date.now() + '.png');
    console.log('[BG] fetchImage via downloads:', url.substring(0, 80));
    
    // Use Chrome's download manager which has full cookie access
    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: false,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.warn('[BG] download failed:', chrome.runtime.lastError.message);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      console.log('[BG] download started, id:', downloadId);
      
      // Wait for download to complete
      const listener = (delta) => {
        if (delta.id !== downloadId) return;
        if (delta.state && delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(listener);
          
          // Get the downloaded file path
          chrome.downloads.search({ id: downloadId }, (results) => {
            if (!results || results.length === 0) {
              sendResponse({ ok: false, error: 'Download result not found' });
              return;
            }
            const localPath = results[0].filename;
            const fileSize = results[0].fileSize || 0;
            console.log('[BG] download complete:', localPath, fileSize, 'bytes');
            
            if (fileSize < 100) {
              sendResponse({ ok: false, error: 'Downloaded file too small: ' + fileSize });
              return;
            }
            
            sendResponse({ ok: true, filePath: localPath, size: fileSize });
          });
        } else if (delta.state && delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(listener);
          console.warn('[BG] download interrupted:', delta.error);
          sendResponse({ ok: false, error: 'Download interrupted: ' + (delta.error?.current || 'unknown') });
        }
      };
      chrome.downloads.onChanged.addListener(listener);
      
      // Timeout after 30s
      setTimeout(() => {
        chrome.downloads.onChanged.removeListener(listener);
        chrome.downloads.cancel(downloadId);
        sendResponse({ ok: false, error: 'Download timeout' });
      }, 30000);
    });
    return true;
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url && tab.url.includes('feishu.cn')) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/turndown.js'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
    } catch (err) {
      console.error('Script injection failed:', err);
    }
  }
});
