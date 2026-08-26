# ytb-dl-web (fork of Gharmonize)

<div align="center">

[![CI](https://github.com/friddle/ytb-dl-web/actions/workflows/ci.yml/badge.svg)](https://github.com/friddle/ytb-dl-web/actions/workflows/ci.yml)

**Download • Convert • 转音频** —— 一个 Web UI 音乐下载器 / 转换器，基于 **yt-dlp** + **FFmpeg**。

支持 **YouTube / YouTube Music / 网易云音乐 / QQ 音乐 / Bilibili** 等平台，内嵌无头浏览器（chrome-driverless）统一登录，也可在前端自由配置 HTTP 代理。界面支持**中文**。

</div>

---

## ✨ 功能

- **多平台下载**：YouTube、YouTube Music、网易云音乐（music.163.com）、QQ 音乐（y.qq.com / music.qq.com）、Bilibili（bilibili.com / b23.tv），以及 X、Facebook、Instagram、Vimeo、Dailymotion、TikTok 等 yt-dlp 支持的站点。
- **Bilibili 自动转音频**：开启 `BILI_AUTO_AUDIO=1` 后，Bilibili 下载会自动提取为音频（`-x`），无需保留视频。
- **统一登录（推荐）**：内置一个 chrome-driverless 浏览器 Tab，直接在该浏览器里登录网易云 / QQ音乐 / Bilibili，登录态自动落盘为 cookies，下载时复用 —— **不强制使用固定账号密码**。
- **可选账号密码**：若不想用浏览器登录，也可在设置里为每个平台配置 `NETEASE_USERNAME/PASSWORD`、`QQ_USERNAME/PASSWORD`、`BILI_USERNAME/PASSWORD`（传给 yt-dlp 的 `--username/--password`）。
- **HTTP 代理**：前端设置 `HTTP_PROXY`（例如 `http://user:pass@host:port`），下载通过代理。
- **中文界面**：内置简体中文（`zh`），可一键切换；支持 en / zh / tr / de / fr / es。
- **格式转换 / 打标签 / 铃声 / 音视频转码**：由 FFmpeg 驱动，含 NVENC / VAAPI / QSV 硬件加速。
- **yt-dlp 已升级**：默认拉取最新稳定版（`2026.08.19`）。

---

## 🚀 快速开始（本地）

```bash
git clone https://github.com/friddle/ytb-dl-web
cd ytb-dl-web

BUILD_ELECTRON=1 npm i
npm start
```

打开 **http://localhost:5174**。启动时会自动检查并下载 ffmpeg / ffprobe / yt-dlp 等运行时二进制。

> Linux / Windows 桌面打包、Docker 部署与 NVIDIA/NVENC 参见 `docs/INSTALLATION.md`、`docs/DOCKER.md`。

---

## 🐳 Docker 三种镜像 + docker-compose demo

提供三种镜像打包方式（见下方 docker-compose demo）：

| 镜像 | 说明 |
| --- | --- |
| `ytb-dl-web:mini` | 最小镜像：仅 Gharmonize web 下载器（含 ffmpeg + yt-dlp），不带浏览器。 |
| `ytb-dl-web:all-in-one` | 一体化镜像：Gharmonize + **chrome-driverless** 内嵌浏览器 Tab + 二进制全内置。 |
| `chrome-driverless` | 独立浏览器服务（嵌入 / 单独部署皆可）。 |

### docker-compose.yml（demo，all-in-one）

```yaml
services:
  ytbdl:
    image: ytb-dl-web:all-in-one
    container_name: ytb-dl-web
    ports:
      - "5174:5174"      # Gharmonize web UI
      - "9223:9223"      # chrome-driverless web UI（内置 Tab 已引用）
    environment:
      - ADMIN_PASSWORD_HASH=CHANGE_ME
      - GHARMONIZE_HOST=0.0.0.0
      - CHROME_DRIVERLESS_URL=http://127.0.0.1:9223   # 内置浏览器 Tab 地址
      - HTTP_PROXY=                                 # 可选，例如 http://user:pass@host:port
      - BILI_AUTO_AUDIO=1                           # 1 = Bilibili 自动转音频
    volumes:
      - ./data:/app/data                             # 下载输出、cookies、浏览器登录态
    restart: unless-stopped
```

完整示例见本文件内 `/examples/` 或项目根 `docker-compose.demo.yml`。

---

## 🖥️ 内置浏览器 Tab（chrome-driverless）怎么工作的

打开主界面，点导航栏的 **🛩️ 内置浏览器** 按钮，会内嵌一个 chrome-driverless 面板：

1. 设置 `CHROME_DRIVERLESS_URL` 指向 chrome-driverless 服务（all-in-one 镜像里已内置在 `:9223`）。
2. 在该浏览器 Tab 里打开 `music.163.com` / `y.qq.com` / `bilibili.com` 并**登录一次**。
3. 登录态自动写入 `data/profiles/<name>/auth.json`（cookies / storageState）。
4. 下载时 yt-dlp 复用该 cookies 完成登录后内容下载（Bilibili 高清、网易云 VIP 歌曲等）。

> 每个平台账号只需在浏览器里登录一次，即可长期复用，无需在设置里填死账号密码。

---

## ▶️ 下载后的文件怎么查看 / 播放

本工具负责“下载 + 转换”，下载完成后文件落在 `/data/output`。**建议用专门的家媒体工具查看与播放**：

- **[alist](https://github.com/alist-org/alist)** —— 一个文件列表 / WebDAV 服务，把 `/data/output` 挂载后即可在浏览器里浏览并下载、串流播放。
- **[Navidrome](https://github.com/navidrome/navidrome)** —— 一个自托管音乐服务器（Subsonic 兼容），把 `/data/output` 设为其媒体目录，即可拥有完整的**在线播放、歌单、刮削封面**体验。

这是最简单的“播放”方案：下载器专注下载，播放交给 alist / Navidrome。当前版本只提供文件下载接口（`/download/...`），不内置完整播放器。

---

## 📚 文档

| 文档 | 说明 |
| --- | --- |
| `docs/INSTALLATION.md` | 本地 / 桌面安装与构建 |
| `docs/DOCKER.md` | Docker / docker-compose / NVIDIA-NVENC |
| `docs/FEATURES.md` | 完整功能与平台支持 |
| `docs/CONFIGURATION.md` | `.env` 全量变量说明 |
| `docs/COOKIES.md` | cookies / 登录态说明 |
| `SECURITY.md` | 安全与发布核验 |

---

## 📄 许可证

本项目基于 **GPL-3.0**，上游为 [G-grbz/Gharmonize](https://github.com/G-grbz/Gharmonize)。
内置第三方工具（FFmpeg、MKVToolNix、yt-dlp、deno）的许可证见 `THIRD_PARTY_LICENSES.md`。

> 声明：仅供个人学习 / 自用。请遵守各平台的服务条款与版权法规。