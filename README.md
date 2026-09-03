# Gharmonize (ytb-dl-web fork)

> **⚠️ 免责声明 / Disclaimer**
> 本项目仅供个人学习与研究，**中国大陆用户不允许使用**。本项目不托管、不分发任何受版权保护的内容。使用本项目产生的一切法律风险、责任与后果均由使用者本人承担，与本项目及开发者/维护者无关。任何误用皆与本项目无关。
> This project is for personal study and research only. **Users from mainland China are not permitted to use it.** All legal risks arising from use are borne by the user and are unrelated to this project or its maintainers.

自托管音乐/媒体下载 Web 应用 —— 搜索、歌单解析、平台登录与 VIP 状态检测、一键下载与转换。前端围绕 **10 个标签页** 组织，支持 6 种语言（中/英/土/西/德/法）。

## 标签页

| Tab | 内容 |
|-----|------|
| 🎵 首页 | 平台状态：小破站 / 鹅厂音乐 / 网抑云 / 油管 / 声破天 登录 + VIP 检测（每个渠道独立「检测」按钮；页面打开时自动检测一次） |
| 🔎 搜索 | 聚合搜索：多平台勾选 + 类型（歌曲 / 歌单），无需分别登录即可搜索；结果可多选下载 |
| 🔗 解析 | 链接解析：任意平台链接 / 歌单 / 合集展开为逐条项目，可下载 |
| ⬇️ 下载 | 下载任务与进度：逐条进度、失败原因、重试失败；每次下载可覆盖输出（格式 / 子目录） |
| ⬆️ 上传 | 上传文件 / URL 转换（经典面板） |
| ✨ YTLive | YTLive 音乐界面（独立页） |
| 📀 Disc | Disc Ripper（DVD 抓轨） |
| 🛩️ 浏览器 | 打开内置浏览器（chrome-driverless），用于扫码登录各平台 |
| ⚙️ 设置 | 完整设置页：默认下载设置（转换格式 / 码率 / 下载路径）、内置浏览器模式（镜像打包自动锁定）、浏览器地址 |
| 📄 日志 | 服务端实时日志（轮询刷新） |

顶部：主题切换小图标、语言切换小图标（🌐 点击轮换）、任务铃铛。

## 平台登录原理

登录在**内置浏览器**（chrome-driverless，镜像内或远程）中完成：

- 每个平台卡片点击「扫码登录」→ 新窗口打开浏览器并直达登录/扫码页（小破站 passport、QQ OAuth、网抑云登录、油管 sign-in、声破天 登录）。
- 「检测」通过浏览器内 JS 探测该平台**真实登录态与 VIP**（小破站 nav API、QQ musicu、网易 nuser/account、油管/声破天 cookie），并同步导出 cookies.txt 供 yt-dlp 下载使用（探测自动 + 启动 + 每 6 小时导出）。
- 微信登录 QQ 时自动合成 `uin` cookie，供 yt-dlp / vkey 鉴权。

## 下载

- **鹅厂音乐**：浏览器内 vkey 直链（支持微信登录、VIP 音源），yt-dlp 兜底。
- **网抑云 / 小破站 / 油管**：yt-dlp（携带导出 cookies，`YTDLP_COOKIES=/data/cookies/cookies.txt`）。
- 播放列表自动展开为逐条任务；每条任务独立进度（下载 / 转换）、失败原因可读；失败可一键重试。
- 输出目录：默认在设置页配置（`MEDIA_DOWNLOAD_DIR`）；每次下载可指定额外**子目录**（根目录只读，仅可编辑子路径）。
- 下载后转换：设置页默认格式/码率；下载标签页可按批次覆盖（跟随设置 / 不转换 / 指定格式）。

## 配置

| 环境变量 | 说明 |
|----------|------|
| `CHROME_DRIVERLESS_URL` | 浏览器 MCP 服务地址（内置镜像为 `http://127.0.0.1:9223`） |
| `CHROME_DRIVERLESS_EXTERNAL_URL` | 浏览器外部访问域名（如 `https://browser.tailnas.friddle.me/`） |
| `CHROME_DRIVERLESS_INTERNAL_URL` | 浏览器内部接口域名（如 `https://browser.naslan.friddle.me/`） |
| `CHROME_DRIVERLESS_BUNDLED` | `1` = 镜像已打包 chrome-driverless（设置页锁定浏览器配置） |
| `MEDIA_DOWNLOAD_DIR` | 默认下载目录（如 `/volume4/music`） |
| `YTDLP_COOKIES` | 下载用的 cookies.txt（默认 `/data/cookies/cookies.txt`） |
| `GHARMONIZE_ALLOWED_ORIGINS` | 允许的跨站 Origin 主机白名单（反代改 Host 时使用，逗号分隔） |

实时设置（设置页保存）通过 `POST /api/settings` 写入并在内存生效。

## 部署（Docker）

```bash
docker compose up -d
# 然后访问 http://<host>:5174/
```

镜像由 GitHub Actions 构建并推送到 GHCR：`ghcr.io/friddle/ytb-dl-web`（tags: `latest` / `main` / commit sha）。镜像类型有常规版与**打包 chrome-driverless 版**（后者设置页自动勾选并锁定「使用内置浏览器」）。

## 开发

```bash
npm install
npm test          # 语法 + 安全回归测试
node app.js       # 本地启动，默认 5174
```

- 安全：CSP（frame-src 动态允许已配置浏览器域名）、跨站请求校验（Host / X-Forwarded-Host / 白名单）、cookie 导出路径受限。
- 国际化：`public/i18n.js` + `public/lang/{zh,en,tr,es,de,fr}.json`，语言切换派发 `i18n:applied` 事件供动态 UI 重渲染。