#!/bin/sh
# ============================================================================
# MT5700 断网排查 —— 系统侧只读采集
# ----------------------------------------------------------------------------
# 用法：  sh /usr/share/mt5700/diag-probe.sh
# 输出：  每行一条 `key=value`（供 rpcd ucode 的 mt5700.sysdiag 解析）
#
# ★ 定位：这个文件只负责**采集事实**，不判定对错。
#   判定（通/存疑/不通、给什么建议）全在前端的检查项注册表里 —— 加一项判据
#   只要改前端，加一项**事实**才改这里。这样两边都能独立扩展。
#
# ★★ 安全边界：
#   ① 不接受任何参数（参数一律忽略）。ucode 调用时也不会拼任何外部输入进来，
#      所以不存在命令注入面；即便有人手工带参数跑，行为也完全一致。
#   ② 全程只读：不改 UCI、不写文件、不重启服务、不动模组。
#      唯一"对外动作"是 L3 的三个探测（ICMP / DNS 查询 / TCP 443 握手），
#      它们本身就是"能不能上网"这一问题的答案，无副作用。
#   ③ 每条网络探测都带 timeout，且命令缺失时输出 -1（未知）而不是 0（假失败）
#      —— 判错的代价比"没测到"大得多。
#
# 本文件是**唯一的体检入口**（看门狗已于 2026-09-20 整体移除）：
#   一次性体检，只回答"是哪一层、哪一项不通"，不做任何自愈动作。
#   断网后的恢复由用户在终端里决定——自动动作本身也是断网源（见前端说明）。
# 探测目标写死为公共 DNS IP 而不是域名：本机装过 mosdns / OpenClash，
#   拿域名当探测目标会被本地解析器误导，得出"能上网"的错误结论。
# ============================================================================

DEF_IFACE='MT5700M'
DEF_DEV='eth2'
# 探测目标：两个都回 ICMP，且是公网 IP 不受本地 DNS 影响
PING_A='119.29.29.29'
PING_B='223.5.5.5'
# 单次网络探测上限（秒）。宁可判得快，也不要拖住 rpcd 的工作线程。
PROBE_TIMEOUT=2
NS_TIMEOUT=5
TCP_TIMEOUT=4

have_cmd() {
	command -v "$1" >/dev/null 2>&1
}

# 限时执行：有 timeout 就用它，没有就退回随包的等价脚本。
# ★ 2026-10-24 真机：Mwrt @Manper r33382 的 busybox 没编译 timeout applet，
#   也没有 coreutils-timeout —— 原来直接写 timeout 会让这两条 DNS 探测
#   永远失败（dns_resolve_ok 恒 0），看上去像「DNS 坏了」，其实是缺程序。
#   同一病因还会让 ucode 的 6 处 shell 调用全哑（见 /usr/share/mt5700/to 文件头）。
to() {
	if have_cmd timeout; then
		timeout "$@"
	else
		/usr/share/mt5700/to "$@"
	fi
}

# 输出一条事实。值里禁止出现换行与 '='（前者会破坏行格式，后者会破坏解析），
# 长度截断避免超长值把响应撑大。
emit() {
	v=$(printf '%s' "$2" | tr -d '\r\n' | tr '=' '-' | cut -c1-120)
	printf '%s=%s\n' "$1" "$v"
}

# ---------- 接口与设备名 ----------
# 优先 UCI network.MT5700M；没有就退回 eth2。
# 不硬编码到"只有 MT5700M 才认"，将来改接口命名时只需改 DEF_IFACE。
IFACE=''
DEV=''
if [ -n "$(uci -q get network."$DEF_IFACE".proto 2>/dev/null)" ]; then
	IFACE="$DEF_IFACE"
	DEV=$(uci -q get network."$IFACE".device 2>/dev/null)
	[ -n "$DEV" ] || DEV=$(uci -q get network."$IFACE".ifname 2>/dev/null)
fi
[ -n "$IFACE" ] || IFACE="$DEF_IFACE"
[ -n "$DEV" ] || DEV="$DEF_DEV"

emit iface_name "$IFACE"
emit iface_device "$DEV"

if [ -n "$(uci -q get network."$IFACE".proto 2>/dev/null)" ]; then
	emit iface_exists 1
else
	emit iface_exists 0
fi

# ★ auto='1' 漏掉是"刷机后完全没网"的头号原因：接口存在但永不自动拉起
emit iface_auto "$(uci -q get network."$IFACE".auto 2>/dev/null)"
emit iface_proto "$(uci -q get network."$IFACE".proto 2>/dev/null)"
emit iface_metric "$(uci -q get network."$IFACE".metric 2>/dev/null)"

if ifstatus "$IFACE" 2>/dev/null | grep -q '"up": true'; then
	emit iface_up 1
else
	emit iface_up 0
fi
if ifstatus "$IFACE" 2>/dev/null | grep -q '"pending": true'; then
	emit iface_pending 1
else
	emit iface_pending 0
fi

# 接口拿到的 IPv4（用于和模组侧 CGPADDR 交叉比对：不一致说明租约失效）
addr=$(ip -4 addr show dev "$DEV" 2>/dev/null | awk '/inet /{print $2; exit}' | cut -d/ -f1)
emit iface_addr "$addr"

mtu=$(ip link show dev "$DEV" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="mtu") {print $(i+1); exit}}')
emit iface_mtu "$mtu"

# ---------- 路由与邻居 ----------
rdev=$(ip route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')
rgw=$(ip route show default 2>/dev/null | awk '$1=="default"{print $3; exit}')
rcount=$(ip route show default 2>/dev/null | grep -c '^default')
emit route_dev "$rdev"
emit route_gw "$rgw"
emit route_count "$rcount"

# ★ ARP 状态：接口 up 但网关邻居 INCOMPLETE = 经典的"静默断网"
#   （模组 USB 重枚举后 netifd 不重跑 DHCP，路由器继续持有失效地址）
if [ -n "$rgw" ] && [ -n "$rdev" ]; then
	emit gw_neigh "$(ip neigh show "$rgw" dev "$rdev" 2>/dev/null | awk '{print $NF; exit}')"
else
	emit gw_neigh ''
fi

# ---------- 防火墙 ----------
# 加 WAN 后不 restart firewall、或 wan zone 没覆盖这个接口，都会"有 IP 出不去"
FW_WAN_NETS=''
scan_zone() {
	local cfg="$1"
	local name net
	config_get name "$cfg" name ''
	[ "$name" = "wan" ] || return 0
	config_get net "$cfg" network ''
	FW_WAN_NETS="$net"
}
. /lib/functions.sh
config_load firewall
config_foreach scan_zone zone

fw_cover=0
for n in $FW_WAN_NETS; do
	[ "$n" = "$IFACE" ] && fw_cover=1
done
emit fw_wan_nets "$FW_WAN_NETS"
emit fw_wan_cover "$fw_cover"
emit mss_clamp "$(uci -q get firewall.@defaults[0].mss_clamping 2>/dev/null)"
emit flow_offload "$(uci -q get firewall.@defaults[0].flow_offloading 2>/dev/null)"
emit flow_offload_hw "$(uci -q get firewall.@defaults[0].flow_offloading_hw 2>/dev/null)"

# ---------- 服务与串口 ----------
# ★ init.d 脚本是 100644（没有执行位）→ 开机根本不自启，这是高复发故障。
# ★★ 真机坑（2026-09-19 实测）：这台设备上**没有 stat 命令**（busybox 没编进来），
#    用 `stat -c '%a'` 会拿回空值，于是"权限位"凭空变成一个空字符串 ——
#    健康检查会把一台好好的机器报成「缺执行位」。改用 ls -l 的第 1~10 列，
#    并把"能不能执行"单独判定（[ -x ] 是最可靠的口径，不依赖任何外部命令）。
if [ -e /etc/init.d/at-webserver ]; then
	emit initd_mode "$(ls -l /etc/init.d/at-webserver 2>/dev/null | cut -c1-10 | tr -d ' ')"
	[ -x /etc/init.d/at-webserver ] && emit initd_exec 1 || emit initd_exec 0
	/etc/init.d/at-webserver running >/dev/null 2>&1 && emit svc_at_running 1 || emit svc_at_running 0
	/etc/init.d/at-webserver enabled >/dev/null 2>&1 && emit svc_at_enabled 1 || emit svc_at_enabled 0
else
	emit initd_mode ''
	emit initd_exec 0
	emit svc_at_running 0
	emit svc_at_enabled 0
fi

tty_n=$(ls /dev/ttyUSB* 2>/dev/null | wc -l | tr -d ' ')
emit ttyusb_count "$tty_n"

# ---------- USB 链路速率 ----------
# ★ 本机真实发生过：开机枚举成 USB2（480），几百秒后重枚举成 USB3（5000），
#   速率差三倍多。取所有 USB 设备里最大的 speed，并给出它所在的路径。
# ★★ 真机坑（2026-09-19 实测）：直接取最大值会取到 **根 Hub** —— 这台机器上
#   usb2 报 20000（USB 3.2 Gen2x2）、usb1 报 480，而真正的模组 2-1 只有 5000。
#   结果排查界面显示「20000 Mbps」，比实际高三倍，问题被完全掩盖。
#   → 必须按 bDeviceClass=09（Hub）把集线器排除掉，只比较真实设备。
usb_best=0
usb_path=''
usb_ver=''
usb_prod=''
for d in /sys/bus/usb/devices/*; do
	[ -f "$d/speed" ] || continue
	# 排除根 Hub 与所有集线器：它们的 speed 是总线能力，不是实际链路速率
	[ "$(cat "$d/bDeviceClass" 2>/dev/null)" = "09" ] && continue
	case "${d##*/}" in usb*) continue ;; esac
	s=$(cat "$d/speed" 2>/dev/null)
	case "$s" in ''|*[!0-9]*) continue ;; esac
	if [ "$s" -gt "$usb_best" ]; then
		usb_best="$s"
		usb_path="${d##*/}"
		usb_ver=$(cat "$d/version" 2>/dev/null | tr -d ' ')
		usb_prod=$(cat "$d/product" 2>/dev/null | tr -d '\r\n')
	fi
done
emit usb_speed "$usb_best"
emit usb_path "$usb_path"
emit usb_version "$usb_ver"
emit usb_product "$usb_prod"

# ---------- DNS ----------
dns_servers=''
for f in /tmp/resolv.conf.d/resolv.conf.auto /etc/resolv.conf; do
	[ -f "$f" ] || continue
	dns_servers=$(awk '/^nameserver/{printf "%s%s", sep, $2; sep=","}' "$f" 2>/dev/null)
	[ -n "$dns_servers" ] && break
done
emit dns_servers "$dns_servers"
if have_cmd dnsmasq && pidof dnsmasq >/dev/null 2>&1; then
	emit dnsmasq_running 1
else
	emit dnsmasq_running 0
fi

# ---------- SQM 与分载 ----------
# SQM 配到 DOWN 的接口（eth1）是陷阱；且 SQM 与 flow offload 互斥
SQM_ENABLED=0
SQM_IFACE=''
scan_sqm() {
	local cfg="$1"
	local en ifc
	config_get en "$cfg" enabled 0
	config_get ifc "$cfg" interface ''
	if [ "$en" = "1" ]; then
		SQM_ENABLED=1
		SQM_IFACE="$ifc"
	fi
}
config_load sqm 2>/dev/null
config_foreach scan_sqm queue 2>/dev/null
emit sqm_enabled "$SQM_ENABLED"
emit sqm_iface "$SQM_IFACE"

# ---------- 系统 ----------
emit uptime "$(awk '{print int($1)}' /proc/uptime 2>/dev/null)"
emit loadavg "$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"
emit mem_free_mb "$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo 2>/dev/null)"
# 时间没同步会让 HTTPS 证书校验失败，表现为"部分网站打不开"
y=$(date +%Y 2>/dev/null)
case "$y" in
	''|*[!0-9]*) emit time_synced -1 ;;
	*) [ "$y" -ge 2024 ] && emit time_synced 1 || emit time_synced 0 ;;
esac

# ---------- L3 端到端探测（耗时部分放最后） ----------
if have_cmd ping; then
	if [ -n "$rgw" ]; then
		ping -c1 -W "$PROBE_TIMEOUT" "$rgw" >/dev/null 2>&1 && emit ping_gw 1 || emit ping_gw 0
	else
		emit ping_gw -1
	fi
	ping -c1 -W "$PROBE_TIMEOUT" "$PING_A" >/dev/null 2>&1 && emit ping_public_a 1 || emit ping_public_a 0
	ping -c1 -W "$PROBE_TIMEOUT" "$PING_B" >/dev/null 2>&1 && emit ping_public_b 1 || emit ping_public_b 0
else
	emit ping_gw -1
	emit ping_public_a -1
	emit ping_public_b -1
fi

if have_cmd nslookup; then
	to "$NS_TIMEOUT" nslookup www.qq.com >/dev/null 2>&1 && emit dns_resolve_ok 1 || emit dns_resolve_ok 0
elif have_cmd drill; then
	to "$NS_TIMEOUT" drill -Q www.qq.com >/dev/null 2>&1 && emit dns_resolve_ok 1 || emit dns_resolve_ok 0
else
	emit dns_resolve_ok -1
fi

# HTTPS：有些网络禁 ICMP，ping 不通不代表上不了网 —— 这一项用来兜住那种情况。
# ★★ 两个真机坑（2026-09-19 实测，都是照着文档写会踩的）：
#   ① busybox 的 nc 不支持 -z（用法就一行 `nc [IPADDR PORT]`），`nc -z` 必返回 1，
#      于是「443 建连」永远失败 —— 一台能正常上网的机器会天天报存疑。
#   ② 拿 119.29.29.29:443 当目标也会误判：该 IP 只答 ICMP、不开 HTTPS
#      （curl 过去是 rc=28 超时，而 curl https://www.qq.com 是 rc=0）。
#   → 改用 curl 打 https://www.qq.com，并按退出码区分「连上但证书不认」与「连不上」。
#     退出码：0 正常；35/51/58/60 = TCP+TLS 已经握手成功（只是证书层面不认 IP/域名）；
#     6 = 域名解析失败（那是 DNS 的问题，不是链路）；7/28 = 连不上 / 超时。
if have_cmd curl; then
	# ★ 2026-09-28：这里原来硬编码 `--max-time 4`，而上面定义的 TCP_TIMEOUT=4
	#   **全脚本只出现一次（就是它自己的定义处）** —— 改常量不生效，改的人会以为改好了。
	#   三个探测超时常量（PROBE_TIMEOUT / NS_TIMEOUT / TCP_TIMEOUT）本意都是给对应的
	#   探测用的，前两个都用上了，只有这个漏了。改成引用常量。
	curl -s -o /dev/null --max-time "$TCP_TIMEOUT" https://www.qq.com >/dev/null 2>&1
	case "$?" in
		0|35|51|58|60) emit tcp_443 1 ;;
		6) emit tcp_443 6 ;;
		7|28) emit tcp_443 0 ;;
		*) emit tcp_443 -1 ;;
	esac
else
	emit tcp_443 -1
fi

exit 0
