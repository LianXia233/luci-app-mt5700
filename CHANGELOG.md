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

### Known Issues / 边界
- `mt5700m-at` / `-manager` / `-traffic` 仍为 Shell 实现，待命令级等价验证后迁移为 Rust 符号链接。

---

## [2.3.x 之前]

更早的版本历史（纯 Shell / Python 实现阶段）未在本文件中逐条记录；
本日志自 2.3.32（Rust 后端落地 + 云端 CI）起作为基线维护。
