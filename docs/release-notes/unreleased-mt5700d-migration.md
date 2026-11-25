# mt5700d 标识统一与升级迁移修复

日期：2026-11-25  
分支：refactor/mt5700d  
状态：未发布，包版本仍为 1.32.13

## 背景

该分支把可执行文件、procd 服务名、UCI 配置名、前端资源目录与运行日志目录统一为 `mt5700d`。重命名覆盖安装期与开机期迁移脚本、init.d、hotplug、uci-defaults、rpcd 插件、ACL、菜单和全部 LuCI 视图。审查发现升级链路存在两处高风险，本修订针对这两处补齐保护。

## 修复内容

### 1. UCI 配置迁移前移到包文件解包前

原实现只在 postinst 与 uci-defaults 中调用迁移脚本，且要求目标 `/etc/config/mt5700d` 不存在。但升级安装时新包会先把默认配置写到该路径，postinst 随后判断目标已存在而跳过迁移，用户配置会被静默丢弃。

修订后在 `Package/luci-app-mt5700/preinst` 中内联最小迁移逻辑。preinst 在包文件解包前运行，此时旧配置仍在、新默认文件尚未落地，可以安全完成搬迁。迁移同时替换段类型与配置值中的旧路径字面量，包括通知日志与插件日志路径。

异常升级态下若新旧配置同时存在，保留较新的 `/etc/config/mt5700d`，把旧文件另存为 `/etc/config/at-webserver.pre-migration` 并记录日志，避免任一侧被静默覆盖。

### 2. 声明配置文件保留

Makefile 新增 `Package/luci-app-mt5700/conffiles`，声明 `/etc/config/mt5700d`。迁移完成后，后续 opkg/apk 升级会保留该文件，不会被包内默认版本覆盖。

### 3. 旧后端进程兜底清理

原迁移脚本只调用 `ubus service delete` 与旧 init.d 的 stop，然后删除旧二进制。若旧 init.d 已被包管理器移除，旧进程可能残留；删除磁盘文件不会终止已运行进程，新旧后端会争抢同一路 PCUI 串口，导致 AT 指令串流错乱与超时断线。

修订后在 service delete 后增加短等待、旧 init.d stop、`killall -q at-webserver-rust` 与再次等待，然后再删除旧二进制。这与仓库既有 reload_service 的兜底策略一致。

### 4. 旧短信归档兼容

短信归档容器魔数由 `AWSS` 改为 `M57D`，读端同时接受新旧魔数。升级前写下的归档仍可浏览；写入始终使用新魔数，旧文件在后续归档时自然收敛，避免读操作产生写放大。

## 影响范围

- 仅影响从旧版本升级到该分支的设备；全新安装时 preinst 与迁移脚本均为空转。
- 运行期行为与配置键保持不变，前端视图路径与资源目录已随分支重命名同步更新。
- `/tmp` 下的旧通知日志与插件日志不会搬移；这些文件位于 tmpfs，升级后不可见属于预期行为。

## 验证建议

1. 从 v1.32.13 升级到该分支，确认 `/etc/config/mt5700d` 保留用户原有的短信、通知、壁纸与量统计配置。
2. 升级完成后用 `ps` 确认系统中只存在 `mt5700d` 后端，不存在 `at-webserver-rust` 残留。
3. 验证短信中心可读取升级前的历史归档，且新归档使用新魔数。
4. 运行 `node tests/static-check.js`、全部 `tests/*-test.js`、`cargo test --locked`、`cargo clippy --all-targets -- -D warnings` 与 mock 模组端到端测试。
