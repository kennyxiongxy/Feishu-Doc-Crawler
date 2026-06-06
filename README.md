# 飞书文档爬取助手 — Feishu Doc Crawler

一个 Chrome 浏览器扩展（Manifest V3），能够从飞书 Wiki 知识库中提取文档内容，保存为本地 Markdown 格式文件。支持单篇提取和批量提取，自动处理表格、图片、高亮块、内嵌电子表格等飞书特有元素。

---

## 目录

- [功能特性](#功能特性)
- [环境要求](#环境要求)
- [必装依赖](#必装依赖)
- [安装步骤](#安装步骤)
- [使用方法](#使用方法)
- [输出结构](#输出结构)
- [项目架构](#项目架构)
- [API 接口](#api-接口)
- [常见问题](#常见问题)
- [故障排查](#故障排查)
- [开发调试](#开发调试)

---

## 功能特性

- **侧边栏目录自动发现**：自动扫描飞书 Wiki 知识库的侧边栏目录，无需手动输入 URL
- **批量提取**：支持全选或勾选任意文章，一次性导出多个 .md 文件
- **子文档递归展开**：选中带 📁 标记的目录节点，自动递归展开所有子文档
- **Markdown 格式转换**：飞书富文本完整转换为标准 Markdown
  - 表格 → Markdown 表格（含嵌套富文本清洗）
  - 高亮块（Callout）→ `> **emoji 标题**\n> 内容`
  - 代码块 → 保留 fenced code block
  - 内嵌电子表格 → 自动读取并转为 Markdown 表格
- **图片本地下载**：自动下载文档中的图片到 `images/` 子目录，Markdown 中使用相对路径引用
- **智能过滤**：自动跳过头像、图标、emoji 等无关图片
- **目录持久化**：首次选择保存文件夹后，下次打开自动恢复（通过 IndexedDB + chrome.storage）
- **非首页自动发现**：在知识库子页面使用插件时，自动回溯到根页面获取完整目录

---

## 环境要求

| 依赖 | 最低版本 | 说明 |
|------|----------|------|
| Chrome 浏览器 | 88+ | 支持 Manifest V3，建议使用最新稳定版 |
| Python | 3.9+ | 运行本地 API 服务 |
| lark-cli | 最新版 | 飞书 CLI 工具，调用飞书 OpenAPI |
| macOS / Linux | — | 当前仅在这两个平台测试通过 |

> **Windows 用户**：理论上可以运行，但 `lark-cli` 的安装方式和路径可能不同，需要自行调整 `feishu_server.py` 中的 `LARK_CLI` 路径。

---

## 必装依赖

### 1. 安装 Python 3

macOS 通常已预装 Python 3。确认版本：

```bash
python3 --version
# 需要输出 Python 3.9.x 或更高版本
```

如果未安装或版本过低，可通过 Homebrew 安装：

```bash
brew install python@3.11
```

### 2. 安装 lark-cli（飞书命令行工具）

这是**最关键的依赖**，负责调用飞书 OpenAPI 读取文档内容。

#### macOS

```bash
# 通过 Homebrew 安装
brew install lark-cli

# 验证安装
lark-cli --version
```

默认安装路径：`/opt/homebrew/bin/lark-cli`（Apple Silicon）或 `/usr/local/bin/lark-cli`（Intel）。

#### Linux

请参考飞书开放平台文档获取 Linux 安装方式，或使用 Docker。

### 3. lark-cli 用户认证（必须完成！）

安装 `lark-cli` 后，**必须完成认证**才能读取飞书文档：

```bash
lark-cli auth login
```

此命令会打开浏览器，引导你完成飞书账号授权登录。登录成功后，`lark-cli` 会将认证凭证保存在本地。

**验证认证状态**：

```bash
lark-cli auth whoami
# 应显示你的飞书用户信息
```

> ⚠️ **重要**：`lark-cli` 的认证 token 有时效性。如果某天插件报错「API 服务未启动」或「lark-cli failed」，请先重新执行 `lark-cli auth login` 刷新认证。

### 4. 修改 lark-cli 路径（如果安装路径不同）

如果你的 `lark-cli` 不在 `/opt/homebrew/bin/lark-cli`，需要修改 `feishu_server.py` 第 22 行：

```python
# 找到这一行（约第 89 行）：
LARK_CLI = '/opt/homebrew/bin/lark-cli'

# 改为你的实际路径，例如：
LARK_CLI = '/usr/local/bin/lark-cli'
```

你可以通过以下命令找到 `lark-cli` 的实际路径：

```bash
which lark-cli
```

---

## 安装步骤

### 第一步：启动本地 API 服务

打开终端，进入项目目录并启动 Python 服务：

```bash
cd /path/to/飞书文档爬取插件
python3 feishu_server.py
```

成功启动后终端会显示：

```
🚀 飞书文档爬取 API 服务已启动
   地址: http://127.0.0.1:8765
   /discover - 发现子文档列表
   /extract  - 提取单个文档内容
   健康检查: http://127.0.0.1:8765/health
   Ctrl+C 停止服务
```

> ⚠️ **请保持此终端窗口运行！** 关闭终端会导致 API 服务停止，插件将无法工作。

如需指定其他端口：

```bash
python3 feishu_server.py --port 8888
# 同时需要修改 popup.js 第 4 行的 API_BASE
```

### 第二步：安装 Chrome 扩展

1. 打开 Chrome 浏览器，地址栏输入 `chrome://extensions/` 并回车
2. 打开右上角的「**开发者模式**」开关
3. 点击左上角「**加载已解压的扩展程序**」
4. 在弹出的文件选择器中，选择项目文件夹（包含 `manifest.json` 的目录）
5. 确认扩展「**飞书文档爬取助手**」出现在列表中

> 💡 安装后如果修改了扩展代码，在 `chrome://extensions/` 页面点击扩展卡片上的 **刷新图标**（🔄）即可重新加载。

### 第三步：验证安装

1. 打开任意飞书知识库文档页面，例如：
   `https://zcnv4hck1o2h.feishu.cn/wiki/XDpDwz1YbiUffSkAchpclPgAnrg`
2. 点击 Chrome 工具栏右侧的**拼图图标**，找到「飞书文档爬取助手」并点击
3. 弹出窗口应显示：
   - 页面标题
   - 侧边栏目录中的文章列表（带复选框）
   - API 服务状态（绿色圆点 = 正常）

如果弹出窗口显示「请在飞书文档页面使用此插件」，说明当前页面不是飞书文档页。

---

## 使用方法

### 基本流程（5 步完成）

1. **打开飞书知识库根页面** — 在 Chrome 中访问包含完整侧边栏目录的知识库页面
2. **点击扩展图标** — 自动分析侧边栏目录并显示文章列表
3. **勾选目标文章** — 勾选需要爬取的文章，或点击「全选」导出全部
4. **选择保存文件夹** — 点击「选择文件夹」按钮指定本地输出目录
5. **开始爬取** — 点击「开始爬取」按钮，等待进度条完成

### 两种提取模式

| 模式 | 操作 | 输出 |
|------|------|------|
| 单篇提取 | 仅勾选一篇文章 | 生成 1 个 .md 文件 |
| 批量提取 | 全选或多选 | 生成 N 个 .md 文件 + images/ 子文件夹 |

### 📁 带子文档的节点

文章列表中带 📁 标记的条目表示该节点下还有子文档。勾选后会自动递归展开所有子文档并一并导出。

### 文件名命名规则

- 以文章标题作为文件名，非法字符自动替换为 `_`
- 同名文章自动追加序号（`_2`、`_3`...）
- 文件名最大长度 100 个字符

### 文件夹持久化

首次选择保存文件夹后，插件会自动记住。下次打开弹窗时：
- 如果显示正常文件夹名 → 可以直接使用，无需重新选择
- 如果显示 ⚠️ 标记 → 点击一次「选择文件夹」按钮重新授权即可（不会弹出文件选择器）

如需更换保存文件夹，点击「选择文件夹」并选择新目录即可。

---

## 输出结构

```
你选择的文件夹/
├── 如何使用本知识库（持续更新中）.md
├── 一、为什么要学这套AI画图方法？.md
├── 二、工具准备：选择适合自己的工具即可.md
├── 三、核心技能：两步将废话变为神图.md
├── 四、提示词优化原则+平台组合策略.md
├── 五、设计美学速成：让你的图更高级.md
├── 六、实战演练：从0到1做出第一组图.md
├── 七、案例灵感库：1000+提示词案例.md
├── 实操常见问题答疑篇（会持续更新）.md
└── images/
    ├── 一、为什么要学这套AI画图方法？_1.png
    ├── 二、工具准备：选择适合自己的工具即可_1.png
    └── ...
```

Markdown 文件中图片使用相对路径引用：`![alt](./images/xxx_1.png)`

---

## 项目架构

```
飞书文档爬取插件/
├── manifest.json              # Chrome 扩展清单（Manifest V3）
├── feishu_server.py           # 本地 API 服务（Python HTTP Server）
├── .space_cache.json          # 空间根页面缓存（自动生成，已加入 .gitignore）
│
├── popup/                     # 弹出窗口
│   ├── popup.html             #   界面结构
│   ├── popup.js               #   业务逻辑 & API 通信
│   └── popup.css              #   样式
│
├── content/                   # 内容脚本（注入飞书页面）
│   └── content.js             #   侧边栏目录 DOM 扫描（API 失败时的回退方案）
│
├── background/                # Service Worker
│   └── background.js          #   图片下载 & 扩展生命周期管理
│
├── lib/                       # 第三方库
│   └── turndown.js            #   HTML → Markdown 转换（DOM 回退方案使用）
│
├── icons/                     # 扩展图标
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
│
└── .gitignore
```

### 数据流

```
飞书页面（侧边栏目录）
    │
    ▼
Chrome Extension (popup.js)
    │  POST /discover { url }
    ▼
Python API Server (feishu_server.py)
    │  lark-cli wiki +node-get / +node-list
    │  (调用飞书 OpenAPI 获取文档节点树)
    ▼
返回文章列表 ──► popup.js 渲染复选框列表
    │
    │  用户勾选并点击「开始爬取」
    ▼
POST /extract { token }
    │  lark-cli docs +fetch (获取 Markdown)
    │  lark-cli docs +media-preview (下载图片)
    ▼
返回 Markdown 内容 ──► popup.js 写入本地文件系统
                       (File System Access API)
```

---

## API 接口

本地 Python 服务监听 `http://127.0.0.1:8765`，提供以下接口：

### 健康检查

```
GET /health
→ { "status": "ok", "service": "feishu-crawler-server" }
```

### 发现子文档

```
POST /discover
Content-Type: application/json

{
  "url": "https://xxx.feishu.cn/wiki/TOKEN"
}
```

返回：

```json
{
  "title": "知识库标题",
  "page_token": "XDpDwz1YbiUffSkAchpclPgAnrg",
  "articles": [
    {
      "title": "一、为什么要学这套AI画图方法？",
      "doc_token": "abc123...",
      "url": "https://internal.feishu.cn/wiki/abc123",
      "has_child": false
    }
  ]
}
```

### 提取单篇文档

```
POST /extract
Content-Type: application/json

{
  "token": "XDpDwz1YbiUffSkAchpclPgAnrg"
}
```

返回：

```json
{
  "title": "文档标题",
  "content": "## 第一章\n\n正文内容...",
  "images": [
    { "url": "https://...", "file_token": "img_xxx", "ext": "png" }
  ],
  "token": "..."
}
```

### 下载图片

```
POST /download-image
Content-Type: application/json

{
  "file_token": "img_xxx"
}
→ { "ok": true, "data": "<base64>", "size": 12345 }
```

---

## 常见问题

### Q: 弹出窗口显示「API 服务未启动」？

**A:** 确认 `feishu_server.py` 正在运行。在终端执行以下命令验证：

```bash
curl http://127.0.0.1:8765/health
```

如果返回 `{"status": "ok"}`，说明服务正常。否则需要重新启动 `python3 feishu_server.py`。

### Q: 弹出窗口显示「请在飞书文档页面使用此插件」？

**A:** 当前页面不是飞书文档。请先导航到飞书知识库页面（URL 包含 `feishu.cn/wiki/`）。

### Q: 文章列表为空，只显示「当前页面」？

**A:** 可能原因：
1. 当前页面不是知识库的根页面，侧边栏目录不可见 → 导航到知识库首页
2. `lark-cli` 认证过期 → 重新执行 `lark-cli auth login`
3. 文档权限不足 → 确认你有该知识库的阅读权限

### Q: 在子页面只能看到当前页，看不到其他文章？

**A:** 插件会自动通过缓存的根页面回溯获取完整目录。如果你之前没有在根页面使用过插件，请先导航到知识库首页打开一次插件，之后在子页面也能获取完整目录。

### Q: 图片下载失败或 Markdown 中图片不显示？

**A:** 图片下载依赖 `lark-cli docs +media-preview`，该接口对跨租户文档有限制。如果你访问的是他人创建的知识库，图片可能无法下载。此时 Markdown 中会保留原始图片 URL。

### Q: 表格内容显示为乱码或 HTML 标签？

**A:** 这是飞书富文本段的序列化格式。v5.3+ 版本已内置自动清洗逻辑，如果仍有残留，请升级到最新版本。

### Q: 如何更新扩展？

**A:**
1. `git pull` 拉取最新代码
2. 在 `chrome://extensions/` 点击扩展卡片的刷新图标
3. 重启 `feishu_server.py`（Ctrl+C 然后重新运行）

### Q: lark-cli 认证过期了怎么办？

**A:**

```bash
lark-cli auth login
# 按提示完成浏览器授权
```

认证后无需重启 Python 服务，下次请求会自动使用新凭证。

---

## 故障排查

### 检查清单（按顺序）

1. ✅ `python3 feishu_server.py` 是否在运行？终端有无报错？
2. ✅ `curl http://127.0.0.1:8765/health` 是否返回 `{"status":"ok"}`？
3. ✅ `lark-cli auth whoami` 是否正常显示用户信息？
4. ✅ Chrome 扩展是否已加载且版本号正确（`chrome://extensions/`）？
5. ✅ 当前页面 URL 是否包含 `feishu.cn/wiki/`？
6. ✅ 你是否对该知识库有阅读权限？

### 调试日志

插件会在多个层级输出日志：

- **Popup 弹窗**：打开 Chrome DevTools（右键弹窗 → 检查），查看 Console
- **Content Script**：在飞书页面按 F12，Console 中过滤 `[FeishuCrawler]`
- **Python 服务**：查看运行 `feishu_server.py` 的终端输出

### 清除缓存

如果目录发现异常，可以删除缓存文件后重试：

```bash
rm .space_cache.json
# 重启 feishu_server.py
```

---

## 开发调试

### 本地开发

```bash
# 1. 启动 API 服务
git clone https://github.com/kennyxiongxy/feishu-doc-download.git
cd feishu-doc-download
python3 feishu_server.py

# 2. 加载扩展到 Chrome
# chrome://extensions/ → 开发者模式 → 加载已解压的扩展程序 → 选择项目目录
```

### 版本历史

| 版本 | 主要变更 |
|------|----------|
| v5.9 | **暗色模式**：CSS 变量 + `body.dark` 覆盖层；首次启动跟随系统（`matchMedia prefers-color-scheme`），点击头部 🌙/☀ 按钮手动切换并保存到 `chrome.storage.local`；新增 31 个 theme 单元测试 |
| v5.8 | **树形展示**：父节点可展开/折叠子文档（▶/▼ 箭头 + 缩进），支持单点展开和"展开/折叠全部"按钮；搜索时自动展开匹配项的祖先链；`popup.js` 拆为 `popup.js + tree.js` ES module（纯函数可 Node 端单测）；新增 47 个 tree 单元测试 |
| v5.7 | 服务端 lark-cli 重试（指数退避 1s/2s/4s，最多 4 次）+ 进程级并发限流（信号量 3 路）；弹窗搜索/筛选（实时过滤 + selectedSet 跨筛选保持） |
| v5.6 | 爬取并发化：文章池 3 路并发 + 文章内图片池 2 路并发 + 原子文件名分配（信号量+链式去重）；13 个并发单元测试 |
| v5.5 | P0 安全清理：删除 `/read-file` 任意文件读写端点、清理 background.js 死代码、精简 manifest 权限；`HTTPServer` 升级 `ThreadingHTTPServer` 支持并发；新增 52 个 pytest 单元测试 |
| v5.4 | 修复目录选择持久化（IndexedDB 权限分离） |
| v5.3 | 批量提取优化、子文档递归展开、图片智能过滤 |
| v5.0 | wiki API 优先、多文档空间支持（48 篇级别知识库） |
| v4.x | Markdown 转换增强（表格、callout、电子表格） |
| v3.x | lark-cli 集成、富文本段清洗 |
| v2.x | File System Access API、图片下载 |
| v1.x | 基础 DOM 提取、Turndown 转换 |

### 技术栈

- **Chrome Extension**: Manifest V3, File System Access API, IndexedDB, chrome.storage
- **Python**: http.server (标准库), subprocess, threading
- **飞书 API**: lark-cli（wiki +node-get, wiki +node-list, docs +fetch, docs +media-preview）
- **前端**: Vanilla JS, CSS（无框架依赖）

### 测试

**Python 端**（77 个 pytest）：服务端纯函数 — Markdown 清洗、cite 解析、图片提取、token 解析、空间缓存、**重试分类 + with_retry + 并发限流**。

**JS 端**（102 个 Node × 4 套件）：并发原语 + 搜索/筛选 + 树形 + 主题。

```bash
# Python 测试
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest tests/

# JS 测试（无需安装）
node tests/test_concurrency.mjs
node tests/test_search.mjs
node tests/test_tree.mjs
node tests/test_theme.mjs
```

测试覆盖：`cell_to_text`、`clean_rich_text_in_markdown`、`parse_cite_elements`、`extract_title_from_markdown`、`extract_images`、`extract_token_from_url`、`get_space_key`、`clean_markdown`（含 callout/cite/富文本段/空行合并）、空间根缓存的"取最多子文档"逻辑、`is_retryable_failure` 永久/瞬时错误分类、`_extract_lark_code` JSON 错误码解析、`with_retry` 指数退避 + 永久错误立即返回、`run_lark_cli_limited` 信号量限流、`Semaphore` JS 信号量、`runPool` 信号量限流 + 取消语义、`allocUniqueName` 原子链式去重 + 跨目录隔离、搜索 filter 大小写不敏感/中文匹配/空集/selectedSet 跨筛选保持、树形 `getDepth` 循环检测、`computeVisible` 展开/搜索/祖先链、`getParentIndices`/`allExpanded`/`insertChildrenAfter` 不可变性、主题 `resolveInitialTheme` 用户偏好覆盖/跟随系统/非法值降级、`resolveNextTheme` 切换 + 未知值默认亮色、按钮图标/aria-label 联动、主题持久化往返。

---

## License

MIT
