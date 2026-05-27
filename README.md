# 飞书文档爬取助手 — 部署与使用指南

## 项目概述

飞书文档爬取助手是一个 Chrome 浏览器扩展（Manifest V3），能够从飞书 Wiki 知识库中提取文档内容，保存为本地 Markdown 文件。支持单篇提取和批量提取，自动处理表格、图片、高亮块等飞书特有元素。

---

## 环境要求

| 依赖 | 说明 |
| --- | --- |
| Chrome 浏览器 | 88 及以上版本（支持 Manifest V3） |
| Python 3.9+ | 运行本地 API 服务 |
| lark-cli | 飞书 CLI 工具，用于调用飞书 OpenAPI |
| macOS / Linux | 当前仅在这两个平台测试过 |

### 安装 lark-cli

```bash
# macOS (Homebrew)
brew install lark-cli

# 验证安装
lark-cli --version

# 首次使用需要认证
lark-cli auth login
```

`lark-cli` 默认安装路径为 `/opt/homebrew/bin/lark-cli`。如果你的安装路径不同，需要修改 `feishu_server.py` 第 22 行的 `LARK_CLI` 变量。

---

## 项目结构

```
飞书文档爬取插件/
├── manifest.json              # Chrome 扩展配置
├── feishu_server.py           # 本地 API 服务（Python）
├── .space_cache.json          # 空间根页面缓存（自动生成）
│
├── popup/
│   ├── popup.html             # 弹出窗口界面
│   ├── popup.js               # 弹出窗口逻辑
│   └── popup.css              # 弹出窗口样式
│
├── content/
│   └── content.js             # 内容脚本：侧边栏目录扫描
│
├── background/
│   └── background.js          # Service Worker
│
├── lib/
│   └── turndown.js            # HTML → Markdown 转换库
│
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 部署步骤

### 第一步：启动本地 API 服务

在终端中执行：

```bash
cd /Users/yaoxiong/Downloads/app-dev/飞书文档爬取插件
python3 feishu_server.py
```

成功启动后显示：

```
🚀 飞书文档爬取 API 服务已启动
   地址: http://127.0.0.1:8765
   /discover - 发现子文档列表
   /extract  - 提取单个文档内容
   健康检查: http://127.0.0.1:8765/health
   Ctrl+C 停止服务
```

**请保持此终端窗口运行**，关闭终端会导致 API 服务停止。

如需指定端口：

```bash
python3 feishu_server.py --port 8765
```

### 第二步：安装 Chrome 扩展

1. 打开 Chrome 浏览器，地址栏输入 `chrome://extensions/`
2. 打开右上角的「**开发者模式**」开关
3. 点击「**加载已解压的扩展程序**」
4. 选择项目目录：`/Users/yaoxiong/Downloads/app-dev/飞书文档爬取插件`
5. 确认扩展已出现在列表中，名称为「**飞书文档爬取助手**」

> 安装后如果修改了扩展代码，在 `chrome://extensions/` 页面点击扩展卡片上的刷新图标即可重新加载。

### 第三步：验证安装

访问任意飞书文档页面（如 `https://zcnv4hck1o2h.feishu.cn/wiki/XDpDwz1YbiUffSkAchpclPgAnrg`），点击 Chrome 工具栏的扩展图标，应该能看到弹出窗口显示页面结构和文章列表。

---

## 使用方法

### 基本流程

1. **打开飞书文档** — 在 Chrome 中访问飞书 Wiki 知识库的根页面
2. **点击扩展图标** — 弹出窗口会自动分析侧边栏目录
3. **勾选目标文章** — 勾选需要爬取的文章（支持全选/取消全选）
4. **选择保存文件夹** — 点击「选择文件夹」按钮指定输出目录
5. **开始爬取** — 点击「开始爬取」按钮，等待完成

### 两种提取模式

| 模式 | 操作 | 输出 |
| --- | --- | --- |
| 部分提取 | 勾选若干篇文章 | 仅生成对应的 .md 文件 |
| 全部提取 | 点击「全选」后开始 | 生成所有目录文章的 .md 文件 + images/ 子文件夹 |

### 输出结构

```
你选择的文件夹/
├── 一、为什么要学这套AI画图方法？.md
├── 二、工具准备：选择适合自己的工具即可.md
├── 三、核心技能：两步将废话变为神图.md
├── ...
└── images/
    ├── 一、为什么要学这套AI画图方法？_1.png
    ├── 二、工具准备：选择适合自己的工具即可_1.png
    └── ...
```

### 文件夹持久化

首次选择保存文件夹后，插件会通过 IndexedDB 持久化目录句柄。下次使用时无需重新选择，除非主动更改。

---

## API 接口说明

本地服务提供以下 HTTP 接口：

### 健康检查

```
GET http://127.0.0.1:8765/health
```

### 发现子文档

```
POST http://127.0.0.1:8765/discover
Content-Type: application/json

{ "token": "XDpDwz1YbiUffSkAchpclPgAnrg" }
```

返回该文档下的所有子文档列表（含标题和 doc_token）。

### 提取单篇文档

```
POST http://127.0.0.1:8765/extract
Content-Type: application/json

{ "token": "XDpDwz1YbiUffSkAchpclPgAnrg" }
```

返回文档的 Markdown 内容、标题和图片列表。

### 批量提取

```
POST http://127.0.0.1:8765/extract-batch
Content-Type: application/json

{ "tokens": ["token1", "token2", "token3"] }
```

---

## 功能特性

- 侧边栏目录自动发现，无需手动输入 URL
- 多文档批量提取，自动识别根页面并缓存
- 飞书富文本表格正确转换为 Markdown 表格
- 图片自动下载到本地 `images/` 目录，MD 中使用相对路径引用
- 高亮块（callout）转为 Markdown 引用块格式
- 内嵌电子表格（sheet）自动读取并转换为 Markdown 表格
- 自动过滤头像、图标等无关图片

---

## 常见问题

**Q: 弹出窗口显示"无法连接服务器"？**

A: 确认 `feishu_server.py` 正在运行，且端口 8765 未被占用。在终端执行 `curl http://127.0.0.1:8765/health` 验证。

**Q: 爬取的内容不完整？**

A: 当前版本依赖 `lark-cli` 调用飞书 OpenAPI。如果文档包含大量内嵌电子表格，提取可能较慢。确保在知识库的根页面（包含完整侧边栏目录的页面）使用插件。

**Q: 在子页面使用插件只能看到当前页？**

A: 插件会自动检测并尝试定位根页面。如果自动发现失败，请手动导航到知识库首页再使用。

**Q: 如何更新扩展？**

A: 修改代码后，在 `chrome://extensions/` 页面点击扩展卡片上的刷新按钮，然后重启 `feishu_server.py`。

**Q: lark-cli 认证过期？**

A: 重新执行 `lark-cli auth login` 完成认证。
