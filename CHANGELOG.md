# Changelog

本文件记录 **`Debian` 分支**的变更。

> **与 `main` 分支的关系**：`main` 是 OpenWrt/LuCI 插件（v1.x 线，产物为 ipk/apk），
> 变更记录见 `main` 分支的 `CHANGELOG.md`。本分支自 `76d1f82` 起脱离 LuCI 体系独立演进，
> 版本号与 `main` **完全独立**，不对应 `main` 的 v1.x 编号。
>
> **版本号来源**：后端 `src/rust/Cargo.toml` 的 `version` 即 deb 包版本（`2.0.0`），
> 由 `debian/build-deb.sh` 单点读取；Release 标签统一用 `debian-v*` 前缀
> （当前已发布：`debian-v2.0.0`，含 amd64 / arm64 两个 deb）。
>
> **详细说明**：逐版本的完整设计说明与实测记录见 `docs/release-notes/`。

## [未发布]

### 变更

- **ci(debian)**: **移除工作流的日志归档步骤，云编译不再产出 `ci-logs` 分支** ——
  原「日志归档」步骤（`if: always()` + `continue-on-error: true`）会在构建时把工具版本、
  产物清单与 deb 元数据写入 `logs/debian/debian-<arch>-<时间>.txt` 并推送到仓库的
  `ci-logs` 分支。移除后 Actions 不再向仓库写入任何内容，构建日志仅保留在 Actions
  运行日志中（保留期由 GitHub 侧控制）。编译 job 由 9 步缩为 **8 步**，发布 job 保持 7 步，
  步骤编号顺延为 1~15。`permissions: contents: write` 保留 —— 发布 Release 步骤仍需该权限。
  > 历史记录说明：v2.0.0 曾包含该步骤及其两处修复（`.gitignore` 的 `*.log` 冲突、
  > 首次创建分支的 `git fetch` 容错）。步骤移除后，这些修复不再有意义，故不再列入当前代码；
  > 相关说明保留在 v2.0.0 的历史条目中以备追溯。

## v2.0.0 (2026-10-07)

首次以 Debian 独立版身份发布。相对 `main` 分支为**不兼容变更**（移除全部 OpenWrt 依赖），
业务功能（状态监测 / 拨号 / 短信 / 扫频 / 锁频 / FOTA / AT 终端 / 推送）与 `main` 保持一致。

### 架构：独立 WebUI + HTTP API 后端（不兼容变更）

- **feat!(backend)**: 新增 `src/rust/src/httpserver.rs`（981 行）—— HTTP API（`0.0.0.0:9000`）+
  WebSocket（`/ws` 事件推送）+ 静态 WebUI 托管，内含路由分发、文件白名单与
  `restart_required` 配置变更追踪。
- **feat!(backend)**: 新增 `src/rust/src/configstore.rs` —— JSON 扁平键值配置存储替代
  OpenWrt UCI；键名沿用原 UCI 语义，配置文件落在 `/etc/mt5700/config.json`。
- **refactor(backend)**: `config.rs` 由读 UCI 改为读文件；`schedconfig.rs` 配置热应用逻辑同步调整；
  `rpcserver.rs`（TCP newline-JSON RPC）保留，改为 e2e 测试与调试通道。
- **feat(backend)**: AT 通道仍由后端独占异步管理 —— 用户操作 High 优先级、后台刷新 Low 优先级
  串行下发，WebUI 加载与页面操作永不阻塞；`events`/`logs` 走增量拉取（`/api/events?since=`）。
- **feat!(webui)**: 新增 `webui/` 独立前端 —— `luci.js`（285 行）提供 `L.rpc` / `L.uci` / `L.fs` /
  `E` 的 LuCI 兼容垫片，`app.js`（221 行）承担 hash 路由与模块加载，`index.html` +
  `shell.css` 为外壳。**原 12 个视图与组件零修改复用**，故功能表现与 `main` 一致。
- **refactor!(webui)**: `view/at-webserver/service.js` 重写为 systemd 服务管理
  （`/api/service/status|restart` + `/dev` 串口扫描 + `/api/config/apply` 热应用），
  替代 `main` 的 init.d 方案。
- **refactor(webui)**: `at-webserver/rpc.js` 重写为 HTTP API 客户端 —— 含鉴权头注入与
  401 → `REQUIRE_AUTH_KEY` 流程，替代 `main` 的 `L.rpc.declare` + rpcd/ucode 代理链路。
  **此二文件为本分支独立实现，后续同步 `main` 前端时必须保留。**
- **feat(debian)**: 新增 `debian/at-webserver.service`（systemd 单元，`Restart=always`）、
  `debian/config.json`（默认配置）、`debian/on-uplink.sh`（拨号就绪钩子）、
  `debian/install.sh`（一键编译安装）。
- **refactor(debian)**: 移除 OpenWrt 专用体系 —— `Makefile`、`htdocs/`、`po/`（i18n）、
  `scripts/sdk-build.sh`、`.github/workflows/build-openwrt.yml`；业务功能全部保留在 `webui/`。
- **refactor(ops)**: 接口管理由 netifd/init.d/hotplug 改为 `on-uplink.sh` 钩子（DHCP 尽力而为），
  系统日志由 logread 改为 journalctl。
- **test**: `cargo test` 37/37 通过；冒烟测试覆盖静态资源、HTTP API、WebSocket、config 链路全绿。

### 前端：同步 main v1.14.3 ~ v1.14.9

`webui/luci-static/resources/**` 与 `main` 的 `htdocs/luci-static/resources/**` 保持同源，
本档为 7 个提交的字节级移植（13 个资源文件），逐项说明见 `docs/release-notes/v1.14.3.md` ~ `v1.14.9.md`。

- **refactor(ui)**: v1.14.3 —— 全页面移除「AT 服务在线」连接状态卡片（10 个视图删除
  `connBar` 容器与 `renderConnectionBar` 调用，`mt5700.js` / `ui.js` 改为空实现 stub 兜底）。
- **fix(status)**: v1.14.4 —— status 页底部栅格由 `auto-fit` 改为确定性 2 列，奇数末卡
  `grid-column: 1 / -1` 横跨全宽，消除换行空位与孤行；新增
  `webui/_layout-test/status-mock.html` 布局回归样张。
- **style(ui)**: v1.14.5 —— 全站英雄区紧凑化，12 项参数收紧，桌面端高度由约 170px 降至 130px。
- **feat(modem-settings)**: v1.14.6 —— 「系统控制」区分级操作条：重启（警戒级，1 次确认）/
  恢复出厂（危险级，3 次连续警告确认），命令下发路径未改。
- **style(modem-settings)**: v1.14.8 —— IMEI 卡片排版优化（**仅 UI 展示层**，四重验证流程与
  `AT^PHYNUM` 写入数据流零改动）。
- **style(modem-settings)**: v1.14.9 —— 「修改 IMEI」按钮复用 `mt-sysctl-item is-danger`，
  与系统控制区操作条视觉规格统一（`min-width: 128px` / `radius: 10px`）。
- **chore(build)**: v1.14.7 —— 「关闭前端 JS 压缩」诉求在本分支**天然满足**：无任何构建期压缩
  逻辑，WebUI 经 `cp -r` 直出并由 `serve_static()` 原样返回，浏览器所得始终为未压缩源码。
- **不移植项及依据**：`.github/workflows/`、`scripts/sdk-build.sh`、`Makefile` 属 OpenWrt 构建体系，
  本分支已移除 SDK 交叉编译与 apk/ipk 打包，无对应物。
- **fix(test)**: `tests/mock-modem` 下 3 个单测仍指向 `main` 已删除的 `htdocs/` 路径，在本分支
  必然读取失败；改指 `webui/` 后测试闭环恢复（73 项断言全通过）。
- **验证**：25 个 JS 语法校验通过；无头浏览器实测 6 个页面卡片均已移除、英雄区实测 130px、
  三按钮尺寸完全对齐、栅格奇数行末卡横跨双列；74 个文本文件全 LF。

### 打包与发布：GitHub Actions 云编译产出 deb

- **ci(debian)**: 新增 `.github/workflows/build-deb.yml` —— 编译 job 8 步
  （检出代码 / 环境准备 / 依赖安装 / 构建执行 / 产物校验·二进制 / 打包执行 /
  产物校验·deb 元数据闸门 / 产物归档）+ 发布 job 7 步，步骤名与输出全汉化。
- **ci(debian)**: 架构矩阵两架构**均用官方原生 runner** —— `amd64` = `ubuntu-24.04`，
  `arm64` = `ubuntu-24.04-arm`（Cobalt 100 / Arm Neoverse N2，4 vCPU）。
  原生化的三项收益：无需注入交叉链接器与 `AR`（配置面更小、失败点更少）；产物不经交叉翻译层
  （可信度与兼容性更佳）；`ring`（ureq/rustls 的 TLS 后端）需 C 编译器与汇编器，原生 runner 自带 gcc。
  > **前置条件：仓库必须为 public。** `ubuntu-*-arm` 免费标签仅对公开仓库开放，转 private 后
  > 该标签不被调度，workflow 直接失败而不会静默降级。
- **ci(debian)**: 新增**双重架构闸门** —— 构建前校验 `uname -m` 与目标架构匹配
  （`amd64:x86_64` / `arm64:aarch64`），不匹配即 `exit 1`；构建后断言产物 ELF `Machine`
  与目标一致，防止误配静默产出错包。
- **ci(debian)**: 触发条件为 push 到 `Debian` 分支 / `debian-v*` 标签 / `workflow_dispatch`
  （可指定 deb 修订号）；标签前缀与 `main` 的 `v*` **空间隔离**；并发按 `github.sha` 串行
  （`cancel-in-progress: false`），消除分支推送与标签推送同 sha 时的 Release 竞争。
- **feat(debian)**: 新增 `debian/build-deb.sh`（357 行，CI 与本地共用同一脚本，避免两套逻辑漂移），
  10 个中文阶段：环境检查 / 版本 / 准备二进制 / 架构判定 / 依赖推导 / 组装文件树 /
  DEBIAN 元数据 / 元数据自检 / 构建 / 产物校验。三项关键设计：
  1. **版本单一来源** —— 取 `Cargo.toml` 的 `version`，修订号由 `--revision` 指定，
     upstream 中的 `-` 替换为 `~`，杜绝包版本与二进制版本不一致；
  2. **架构自 ELF 判定** —— 从 `readelf -h` 的 `Machine` 字段判定（统一小写后匹配
     `aarch64` / `x86-64`），**不信任 `dpkg --print-architecture`**：交叉编译下后者返回宿主架构，
     会产出 `Architecture: amd64` 却内含 aarch64 二进制的坏包，在 arm64 设备上被 dpkg 直接拒绝
     （实测发现并修复的缺陷）；本分支 CI 原生化后仍保留该判定以支撑本地交叉打包；
  3. **依赖动态推导** —— 读 `objdump -p` 的 `NEEDED` 映射为 Debian 包名并按首次出现顺序去重
     （`libc.so.6` / `libm.so.6` / `libpthread.so.0` 均映射 `libc6`），未识别库告警不静默丢弃。
- **feat(debian)**: 新增 `debian/ci-verify.sh` —— 本地模拟 CI 全套闸门（构建 / 架构校验 /
  打包 / 元数据校验），不开 Actions 也能验证产物。
- **feat(debian)**: 包内容布局 —— `/usr/bin/at-webserver`、`/usr/share/mt5700/webui/**`、
  `/etc/mt5700/config.json`（**conffile**，升级保留用户修改）、`/etc/mt5700/on-uplink.sh`、
  `/lib/systemd/system/at-webserver.service`、`/usr/share/doc/at-webserver/`。
  `postinst` 遵循 `deb-systemd-helper` 惯例且**启动失败不中断安装**（未接模组属预期状态）。
- **实测（Debian 13 x86_64，Rust 1.99.0）**：amd64 编译 1m12s / arm64 1m00s；两架构
  control 声明与包内二进制实际架构交叉校验一致；安装生命周期（安装 → 改 `config.json` →
  重装保留用户修改 → purge 全清除）通过；7 项静态资源与 `/api/service/status` 抽测正常。
  从 Release 下载官方产物实测 `dpkg -i` 安装、启动、资源 HTTP 200 均通过。

### 修复

- **fix(ci)**: 修复 deb 云编译两处工作流失败（首次 run `37623300688` 两架构同步骤中止）：
  1. `GITHUB_ENV` 写入格式非法 —— 原 `echo "$DEB" >> "$GITHUB_ENV"` 把相对路径裸值写入
     env 文件，GitHub 的 env 指令解析器要求 `KEY=value`，故报
     `Invalid format 'dist/at-webserver_2.0.0-1_amd64.deb'` 并 `exit 1`。该变量本就未被消费
     （后续用 `ls dist/*.deb` 重新定位），直接删除，从根上消除跨步骤依赖；
  2. 日志归档步骤（**该步骤已于「未发布」段落中整体移除，以下仅作历史追溯**）——
     仓库 `.gitignore` 含 `*.log` 导致 `git add` 被忽略而失败，
     改用 `.txt` 扩展名（并保留 `git add -f` 双保险）；`git fetch origin ci-logs` 在分支不存在时
     以非 0 退出，改用 `git ls-remote --exit-code --heads` 判存在后再 fetch；push 失败降级为警告；
     步骤级加 `continue-on-error: true`（日志属附带产物，不应阻断构建）。
- **fix(build)**: `build-deb.sh` 修正 `OUT_DIR` 相对路径在 `cd` 进临时构建树后失效
  （`dpkg-deb: unable to create ... No such file or directory`）—— 脚本启动时即绝对化。
- **fix(ci)**: 修正 Actions job 日志拉取的 401 —— 日志接口 302 重定向会丢失 `Authorization` 头，
  改用跟随重定向的 `curl -sL` 并加时间戳绕过缓存。

### 文档

- **docs**: 新增 `docs/release-notes/v1.14.3.md` ~ `v1.14.9.md`（前端移植逐项说明）与
  `v2.0.0-deb-packaging.md`（deb 打包设计说明）。
- **docs**: README 重写为 Debian 独立版说明 —— 新增「安装 deb 包」部署方式、本地打包、
  云编译章节、原生 runner 说明与前置条件、`amd64`/`arm64` 架构选择指南；
  目录结构补充 `build-deb.sh` / `ci-verify.sh` / `build-deb.yml`；
  「与 main 分支的差异」表新增「前端压缩」「二进制分发」「CI」三行；
  新增「前端同步机制」小节，明确 `rpc.js` 与 `service.js` 为独立实现、同步时不得覆盖。
- **docs**: 新增本 `CHANGELOG.md`。
