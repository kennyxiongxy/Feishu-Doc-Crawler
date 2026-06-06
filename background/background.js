// background.js — Service Worker

chrome.runtime.onInstalled.addListener(() => {
  console.log('飞书文档爬取助手已安装');
});
