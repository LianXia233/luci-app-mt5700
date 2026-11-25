#!/bin/sh
# Copyright (C) 2026 LianXia233
# SPDX-License-Identifier: GPL-3.0-only
#
# 一次性迁移：旧版本遗留数据与文件
#
# ============================================================================
# 这是**临时兼容脚本**，只为「从旧版本升级」存在，新装设备运行它等于空转。
# 确认不再有设备从旧版本升级后（建议下一个大版本），按下面四步整体删除：
#   1) 删除本文件 root/usr/libexec/mt5700d/migrate-legacy.sh；
#   2) 删除三处调用：
#        - Makefile 的 Package/luci-app-mt5700/preinst（仅 UCI 配置内联段）
#        - Makefile 的 Package/luci-app-mt5700/postinst
#        - root/etc/uci-defaults/mt5700d
#   3) 删除 tests/lib/exec-mode.js 的 REQUIRED_EXECUTABLES 里的本文件条目；
#   4) 删除 Makefile 的 Build/Prepare 里对本文件的 chmod 行。
# 四步做完，仓库内不再有旧版本路径引用（grep 旧路径应归零）。
# ============================================================================
#
# 为什么 UCI 配置内联在 preinst，其余逻辑独立成脚本：
#   1) UCI 配置必须在包文件解包前搬迁，否则新默认文件先落地会让迁移失效，
#      这个时序只有 preinst 能满足，因此一处内联不可避免；
#   2) 其余遗留数据在 postinst 与开机期（uci-defaults）都要跑，内联两份
#      必然漂移，集中在本脚本可以避免遗漏；
#   3) 调用点各留一行，主流程保持可读。
#
# 幂等：每个动作都先判断来源存在且目标不存在，重复执行安全。
# 尽力而为：任何单步失败都不阻断调用方（安装/开机的其余步骤更重要），
# 失败原因写 logger 供排查。
# ============================================================================

set -u

log() { logger -t mt5700d "迁移: $*" 2>/dev/null || true; }

# --- 1. UCI 配置（preinst 已处理，此处仅兜底）-------------------------------
# 正常升级时 preinst 已在新文件解包前完成本步；这里覆盖只执行 uci-defaults
# 的异常场景。段类型与配置值里的旧路径必须同步替换，否则新服务读到的仍是
# 旧段类型与旧路径（例如 log_plugin_file 仍指向旧目录），日志页会显示空文件。
if [ -f /etc/config/at-webserver ] && [ ! -f /etc/config/mt5700d ]; then
	mv -f /etc/config/at-webserver /etc/config/mt5700d
	sed -i -e 's#at-webserver#mt5700d#g' \
	       -e 's#at-notifications[.]log#mt5700d-notifications.log#g' \
	       /etc/config/mt5700d 2>/dev/null
	log "已将 UCI 配置迁移到 /etc/config/mt5700d"
fi

# --- 2. 短信归档（overlay 上的用户数据，丢了不可恢复）------------------------
# 只搬目录、不改内容：读端同时认新旧两种容器魔数，旧归档搬过去即可正常浏览；
# 写入始终使用新魔数，旧文件在下次归档时自然被新格式覆盖。
if [ -d /etc/at-webserver/SMS ] && [ ! -d /etc/mt5700d/SMS ]; then
	mkdir -p /etc/mt5700d
	mv -f /etc/at-webserver/SMS /etc/mt5700d/SMS
	log "已迁移旧短信归档到 /etc/mt5700d/SMS（旧格式仍可读取）"
fi

# --- 3. 月用量持久化 ---------------------------------------------------------
if [ -f /etc/at-webserver-usage.json ] && [ ! -f /etc/mt5700d-usage.json ]; then
	mv -f /etc/at-webserver-usage.json /etc/mt5700d-usage.json
fi

rmdir /etc/at-webserver 2>/dev/null

# --- 4. 旧版本遗留的防火墙规则 -----------------------------------------------
# 旧版本创建过 RPC 端口放行 / 模组端口限制规则。当前 init.d 的清理列表
# 不再包含这些规则名，若不在升级时清掉，它们会一直留在 firewall 配置里，
# 表现为旧策略继续生效（例如之前放行过 RPC 端口，新版已关闭，端口却仍开放）。
for rule_name in at_webserver_wan_block at_webserver_wan_allow; do
	rule_idx=$(uci show firewall 2>/dev/null | grep "\.name='$rule_name'" | cut -d'[' -f2 | cut -d']' -f1 | head -n1)
	[ -n "$rule_idx" ] && uci delete firewall.@rule[$rule_idx] 2>/dev/null
done
uci commit firewall 2>/dev/null

# --- 5. 旧进程与旧文件 -------------------------------------------------------
# 旧二进制必须删：它独占同一路 PCUI 串口，与 mt5700d 同时运行会互相抢锁，
# 表现为 AT 指令串流错乱、超时断线——这比「留着占空间」严重得多。
# 先停 procd 实例再删文件，避免 procd 在删除后按 respawn 拉起一个不存在的程序。
# service delete 不保证立刻终止进程；repo 的 reload_service 也保留 killall 兜底，
# 这里必须同样处理，否则旧进程会残留并继续占用 PCUI 串口。
if ubus -q call service list '{"name":"at-webserver"}' >/dev/null 2>&1; then
	ubus call service delete '{"name":"at-webserver"}' >/dev/null 2>&1 || true
	sleep 1
fi
[ -x /etc/init.d/at-webserver ] && /etc/init.d/at-webserver stop >/dev/null 2>&1
killall -q at-webserver-rust 2>/dev/null || true
sleep 1
rm -f /usr/bin/at-webserver-rust
rm -f /etc/init.d/at-webserver
rm -f /etc/rc.d/S99at-webserver /etc/rc.d/K10at-webserver
rm -f /etc/hotplug.d/iface/99-at-webserver /etc/hotplug.d/usb/99-at-webserver
rm -rf /usr/libexec/at-webserver
rm -f /var/run/at-webserver-rust.pid

exit 0
