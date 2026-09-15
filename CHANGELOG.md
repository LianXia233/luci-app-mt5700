# Changelog

## v1.12.3 (2026-09-15)

### 修复

- **fix(pkg)**: 修复 `root/etc/init.d/at-webserver` 执行位回退。`e186885`（v1.2.2）已通过 `git update-index --chmod=+x` 修复为 100755，但被后续提交 `b629839`（v1.3.1）静默退回 100644，导致非 SDK 构建路径（feed 集成、手工复制 `root/`）在 post-install 阶段再次出现 `Permission denied`，init 服务无法 enable、`/etc/rc.d/S99at-webserver` 软链接缺失。本次重新补回执行位；Makefile `Build/Prepare` 与 `scripts/sdk-build.sh` 的 `chmod 0755` 构建期兜底保留。
- **fix(service)**: 修复 `stop_service` 防火墙规则清理不完整。`start_service` / `reload_service` 创建并清理 7 条规则，而 `stop_service` 仅清理 5 条，`at_rpc_wan_allow` / `at_rpc_wan_block` 两条 RPC WAN 规则在停服后残留——开启过 `websocket_allow_wan=1` 的设备停服后 WAN 到 RPC 端口仍被放行。清理列表已补齐至 7 条。

### 文档

- README 版本号同步至 v1.12.3；新增「开机自启」章节，说明后端（init.d S99 + procd + UCI enabled 联动）、前端（rpcd/uhttpd 加载 menu.d / acl.d / ucode 代理）与 MT5700M / MT5700Mv6 接口自启（auto=1 + ifup）的完整链路与排查命令。

### 变更

- PKG_VERSION 1.12.2 → 1.12.3。
