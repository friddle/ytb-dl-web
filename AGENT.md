# AGENT.md — 迭代交付规则（必须遵守）

## 标准交付闭环

每次代码修改后，按以下顺序完成交付与验证，不得跳步：

```
git push → GitHub Actions 编译镜像 → NAS 更新 → chrome-driverless 截图验证功能
```

### 1. git push 代码

- 提交信息用约定式前缀（feat/fix/chore/perf），一句话说清改动与动机。
- push 到 `origin main`（`https://github.com/friddle/ytb-dl-web.git`），push 自动触发 `.github/workflows/docker-build.yml`。

### 2. GitHub Actions 编译镜像

- 用 `gh run list --repo friddle/ytb-dl-web --branch main --workflow "Build & Push Docker Image" --limit 1` + `gh run watch <runId> --exit-status` 等待构建完成。
- 产物：`ghcr.io/friddle/ytb-dl-web:main`。构建失败必须先修复再继续，不允许跳过验证。

### 3. NAS 更新（musicdownload 容器）

- NAS 登录与 docker 用法见 `nas-services` skill；ghcr 拉取不稳时用 tools 中转（见 `nas-mirrors` / `cicd` skill）：
  ```bash
  # tools 上：docker pull ghcr.io/friddle/ytb-dl-web:main
  #   docker save -o ~/ytbdl-img.tar <image>
  #   cat ~/ytbdl-img.tar | ssh -i ~/.ssh/nas_key -p 2223 friddle@127.0.0.1 "cat > ~/ytbdl-img.tar"
  # NAS 上：/usr/local/bin/docker load -i /var/services/homes/friddle/ytbdl-img.tar
  #   cd /volume6/docker/musicdownload && /usr/local/bin/docker compose up -d --force-recreate
  ```
- 传输后必须核对 NAS 侧 tar 大小与 tools 侧一致（曾因截断导致 `docker load: unexpected EOF`）。
- 完成后删除两侧临时 tar（各 ~2.7GB）。
- 注意：`compose up -d` 对同名 tag 不会重建容器，必须 `--force-recreate`。

### 4. chrome-driverless 截图验证功能

- 用本机 chrome-driverless（127.0.0.1:9223，MCP 接口或 DSH browser_* 工具，见 `chrome-driverless` skill）访问 `https://musicdownload.tools.yicoson.cn` 对应页面截图。
- 必须在**专属 tag 的 tab** 里操作（多会话并发，tab 会被抢），每次操作前校验 `location.href` 仍指向 musicdownload。
- 截图存 `draft_365f4e89_folder/`（评审/PLAN 文档引用），并确认与上轮截图不同（功能确实生效）。
- 容器内 Chrome 访问宿主机服务用 LAN IP（本机 `10.10.32.137`），不要用 127.0.0.1。

### 5. 文档回写

- 验证通过后把结果（commit 号 + 截图）回写到对应飞书文档：
  - 功能评审：`U0gidS4WDog7ZRxv2jhcG3j2nLd`
  - 迭代 PLAN：`YQ2ldQs9LoCkLcxVpDvcytC1ndb`
  - UI 优化建议：`CV0Hd3krmoFHGCxZsSic2v60ng7`

## 环境速查

- 机器密码：本机 root / tools friddle = `88636311`；NAS friddle = `Lyd88636311`（SSH 经 tools socat：`ssh -p 2223 friddle@10.10.32.220`）。
- 无 sshpass 时用 `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` + `setsid`（见 `nas-services` skill）。
- 代理：本机/tools 的 docker daemon 已配 `http://10.10.32.14:7890`；NAS 容器走 `192.168.50.11:7890`（mihomo）。
- 并发警告：多个 agent 会话共用本机 docker 与 chrome-driverless，容器/tab 可能被其他会话改动，操作前先确认现状，不要假设。
