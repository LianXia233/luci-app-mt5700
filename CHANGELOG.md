# Changelog

本文件记录 `luci-app-mt5700m` 的显著变更，格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号与包内 `PKG_VERSION` 对齐。

## [2.3.32] - 2026-08-17

### Added
- **AT WebSocket 终端 (`at-server`) 重写为 Rust**：并入单一二进制 `mt5700m`，
  以 `at-server` 符号链接 + `argv[0]` 基名派发；`std-only`、零外部 crate
  （自研 RFC6455 WebSocket / SHA1+Base64 / GSM-7·UCS2 PDU 解码 / 双栈 `TcpListener`，
  企微 Webhook 经 `curl` shell-out）。
- **CI/CD**：新增 `.github/workflows/build.yml`，云端自动编译并发布双格式产物：
  - `rust` 作业用自带 `rust-lld`（自包含链接，无需交叉 gcc）为 6 个 musl 目标交叉编译；
  - `openwrt` 矩阵（架构 × SDK 版本）调用 `openwrt/gh-action-sdk` 打包；
  - `release` 作业汇集 `.ipk`（opkg / 24.10.8）与 `.apk`（apk / 25.12.5）并附 SHA256 推送到 Releases。
- **`.gitattributes`**：强制 LF 行尾，避免 `Makefile` 续行被 CRLF 破坏。

### Changed
- **Makefile**：
  - 移除 `LUCI_PKGARCH:=all`（改为随目标 PKGARCH 发布架构相关二进制）；
  - `LUCI_DEPENDS` 去掉 `python3` / `python3-websockets` / `python3-pyserial`，新增 `curl`
    （Rust 后端企微通知依赖）；
  - 内联 `RUST_TARGET` 架构 → musl 三元组映射（可用 `CONFIG_RUST_TARGET` 覆盖）；
  - `Build/Compile` 优先拷贝 CI 注入的预编译二进制（`prebuilt/<triple>/mt5700m`），否则回退到
    `cargo build`；路径锚定改用 `$(MAKEFILE_LIST)`，兼容 gh-action-sdk 的 feeds 树构建上下文；
  - 产物 stage 到 `root/usr/bin/mt5700m` + `at-server` 软链（luci.mk 默认 `Package/install` 自动随 `root/*` 发出）。
- **`root/etc/init.d/at-webserver`**：`PROG=/usr/bin/at-server`，`procd_set_param command "$PROG"`，
  移除 python3 探测。
- **`root/etc/uci-defaults/93-mt5700m-webui`**：`chmod 0755 /usr/bin/at-server`。

### Removed
- 删除 `root/usr/bin/at-server.py`（原 2803 行 Python 实现，已由 Rust 取代）。
- 移除遗留 CI：`ci.yml`（静态检查，仍断言已删除的 `at-server.py` 可执行位，会在 PR 门禁失败）、
  `release.yml`（仅产出 `.apk`、`scripts/build-release.sh` 旧构建路径，会与 `build.yml` 在 `v*` 标签推送时竞争发布）。
  现仅保留 `build.yml` 作为唯一 CI：打 `pull_request` 构建门禁、打 `v*` 标签 / `workflow_dispatch` 产出 ipk+apk 并发布到 Releases。
- 停止跟踪本地 `.workbuddy/` 工作记忆（纳入 `.gitignore`，不进入代码仓库）。

### Fixed
- **CI 架构矩阵收敛为 arm64 + amd64**：Rust *stable* 渠道已下架 `mips` / `mipsel` / `i686` 的
  `rust-std`，导致这两个 Rust 交叉编译作业失败、进而 `openwrt` 打包作业被依赖链整体跳过；
  现仅构建 `x86_64` 与 `aarch64_generic`（各 ipk@24.10.8、apk@25.12.5），与需求一致。
- **补充 QModem feed（`EXTRA_FEEDS`）**：`luci-app-mt5700m` 声明依赖 `ubus-at-daemon` 与
  `sms-tool_q`，二者仅存在于 QModem feed；未注入会导致 SDK `feeds install` 解析依赖失败。
  现通过 `openwrt/gh-action-sdk` 的 `EXTRA_FEEDS` 注入 `src-git qmodem https://github.com/FUjr/QModem.git;main`。
- **核验 SDK 容器标签**：`gh-action-sdk` 的 `ARCH` 须匹配 `ghcr.io/openwrt/sdk` 真实标签
  （如 `x86_64-24.10.8`）；已确认 24.10.8 / 25.12.5 下 `x86_64` 与 `aarch64_generic` 标签存在。
- **CI 矩阵新增 Cortex-A53（arm64）目标**：加入 `mediatek-filogic`（MT798x / Filogic，MT5700M 平台）
  的 ipk@24.10.8 与 apk@25.12.5 构建，与 `aarch64_generic` 共用同一 `aarch64-unknown-linux-musl` 预编译二进制。
- **修复 CI `release` 作业"空壳发布"缺陷**：`download-artifact@v4` 的 `merge-multiple: true`
  在合并 6 个架构产物时，同名 `_all` 包互相覆盖，导致绝大多数包在收集阶段丢失——
  实锤：上轮 `latest` 预发布仅含 `cgi-io` / `curl` / `libcurl4` / `libnghttp2-14` 四类依赖，
  而 app 本体 `luci-app-mt5700m`、i18n 语言包、以及 `ubus-at-daemon` / `sms-tool_q` 全部缺失
  （编译阶段实际已产出 `luci-app-mt5700m_2.3.32-r1_all.ipk`，仅发布环节漏收）。
  修复：① 去掉 `merge-multiple`，改用 `find` 递归收集所有 `.ipk`/`.apk` 到 `dist/upload`；
  ② 增加 app 本体完整性闸门，本体缺失则直接 `exit 1`，杜绝再次发布空壳。
- **`Makefile` `Build/Compile` 加固**：当构建环境缺少 `cargo` 且未注入 CI 预编译 musl 二进制时，
  给出清晰可执行的报错（二选一：放入预编译二进制 / 安装 `cargo` + 对应 `rust-std`），
  替代原先晦涩的 `cargo: command not found` 失败。
- **发布产物精简（白名单收集）**：上一轮修复 `merge-multiple` 后改用 `find` 全量收集，
  导致 `latest` 发布了 300+ 个无关包（40+ 种语言的 `luci-i18n-base-*`、所有 base 运行时库
  `libubox`/`ubus`/`uci`/`lua`/`ucode`、甚至 `zlib-dev`/`lua-examples`）。现改为按包名前缀
  白名单挑选，仅发布 `luci-app-mt5700m`（本体）、`luci-i18n-mt5700m-zh-cn`（简中）、
  直接依赖 `ubus-at-daemon`/`sms-tool_q`/`curl`/`luci-base`，剔除所有无关包。
- **滚动 `latest` 发布提升为正式「Latest」Release（不再预发布）**：原先 `workflow_dispatch`
  未填 `release_tag` 时发布的 `latest` 被标记为 **prerelease**，GitHub 仓库首页会把预发布弱化、
  侧栏「Releases」不显示「Latest」徽标，用户只能看到「1 tag」。
  现改为 `prerelease: false` + `make_latest: true`，`latest` 在首页作为「最新 Release」直接展示，
  可下载其中的 ipk/apk 包，不再是被弱化的标签。

### Known Issues / 边界
- 精简发布逻辑（白名单）的改动需在重跑 CI（`workflow_dispatch`）后验证 `latest` 是否仅含
  白名单内的包；base 运行时依赖（`libubox`/`ubus`/`uci`/`lua` 等）与 `ca-bundle`/
  `ca-certificates` 不再随发布提供，依赖目标系统已装 Luci 环境，或安装时由包管理器从仓库解析。
- `mt5700m-at` / `-manager` / `-traffic` 仍为 Shell 实现，待命令级等价验证后迁移为 Rust 符号链接。

---

## [2.3.x 之前]

更早的版本历史（纯 Shell / Python 实现阶段）未在本文件中逐条记录；
本日志自 2.3.32（Rust 后端落地 + 云端 CI）起作为基线维护。
