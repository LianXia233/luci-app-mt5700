# Changelog

## v1.12.4 (2026-09-16)

### 修复

- **fix(service)**: 修复服务永远「未注册 / 进程未运行 / procd 无实例」。根因不是 init 脚本缺失或被 overlay 白化，而是 **服务从未被 enable**：`/etc/rc.d/S99at-webserver` 软链接不存在。v1.12.2 及更早版本的 `root/etc/init.d/at-webserver` 执行位回退为 100644，安装期 enable 以 `Permission denied` 失败；enable 只在安装那一刻执行一次，错过之后即使执行位修好（v1.12.3）也不会自动重试，于是存量设备每次重启后服务都不再启动。
- **fix(service)**: `start_service` 新增开机自启注册自愈。每次 start 检查 `/etc/rc.d/S${START}at-webserver`，缺失就补权限并 `enable`，存量设备只要执行一次 `/etc/init.d/at-webserver start`（或点一次「重载服务」）即永久修好，不再随重启复发。
- **fix(pkg)**: `root/etc/uci-defaults/at-webserver` 增加显式 `enable`（先补执行位再 enable），保证新装与升级路径都把服务注册进 rc.d。
- **fix(pkg)**: Makefile 新增 `Package/luci-app-mt5700/postinst`，安装/升级后强制 `enable` + 启动（`IPKG_INSTROOT` 非空时跳过，避免污染 SDK/ImageBuilder 宿主）。
- **fix(ui)**: 「重载服务」不再只用 ubus `service.set` 直连注册实例——那条路径绕开 init.d，只是临时拉起进程，永远补不上 `/etc/rc.d` 链接，导致每次重启必然复发。现改为优先经 rpcd `rc.init` 调用 init.d（会触发自愈注册），失败才回退到 ubus 直连兜底。
- **fix(ui)**: 「未注册」状态的诊断文案修正为「未注册开机自启（rc.d 链接缺失）」优先，避免一律误导为 overlay 白化。

### 变更

- ACL `luci-app-mt5700.json` 新增 `rc` 对象授权（read: `list`，write: `init`），供前端经 rpcd 调用 init.d。
- PKG_VERSION 1.12.3 → 1.12.4。
## v1.12.3 (2026-09-15)

### 修复

- **fix(pkg)**: 修复 `root/etc/init.d/at-webserver` 执行位回退。`e186885`（v1.2.2）已通过 `git update-index --chmod=+x` 修复为 100755，但被后续提交 `b629839`（v1.3.1）静默退回 100644，导致非 SDK 构建路径（feed 集成、手工复制 `root/`）在 post-install 阶段再次出现 `Permission denied`，init 服务无法 enable、`/etc/rc.d/S99at-webserver` 软链接缺失。本次重新补回执行位；Makefile `Build/Prepare` 与 `scripts/sdk-build.sh` 的 `chmod 0755` 构建期兜底保留。
- **fix(service)**: 修复 `stop_service` 防火墙规则清理不完整。`start_service` / `reload_service` 创建并清理 7 条规则，而 `stop_service` 仅清理 5 条，`at_rpc_wan_allow` / `at_rpc_wan_block` 两条 RPC WAN 规则在停服后残留——开启过 `websocket_allow_wan=1` 的设备停服后 WAN 到 RPC 端口仍被放行。清理列表已补齐至 7 条。

### 文档

- README 版本号同步至 v1.12.3；新增「开机自启」章节，说明后端（init.d S99 + procd + UCI enabled 联动）、前端（rpcd/uhttpd 加载 menu.d / acl.d / ucode 代理）与 MT5700M / MT5700Mv6 接口自启（auto=1 + ifup）的完整链路与排查命令。

### 变更

- PKG_VERSION 1.12.2 → 1.12.3。
