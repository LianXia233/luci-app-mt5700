#!/bin/sh
# ============================================================================
# MT5700 音频驱动装载器
# ----------------------------------------------------------------------------
# 目的：让「换成带 USB Audio Class 的模组」这件事在软件侧零成本 —— 插件已经
#       把 ALSA 依赖链的 11 个内核模块一起打包，插上就自动装，不需要重编固件。
#
# 为什么需要它（2026-10-22 实测结论，详见 REFERENCE §声音）：
#   · MT5700M-CN 的 USB 只有两个配置，六个接口全是 CDC-NCM / CDC-Data /
#     vendor(ff/06)×4，**没有任何 Audio Class 接口**，也没有等时端点。
#   · 手册 244 条命令里没有任何音频数据通道（^CSCHANNELINFO 只报带宽状态）。
#   · 所以本模组的语音音频在物理上就没有引到软件能读到的地方。
#   但厂商固件里那套 ALSA 模块的 vermagic 与本机内核字节一致，实测 11 个
#   全部 insmod 成功、snd-usb-audio 已注册到 usbcore —— 也就是说**一旦有
#   带 UAC 的模组插上，音频立刻就能出 /dev/snd**，代价只是装这批模块。
#
# ★ 为什么文件后缀是 .kmod 而不是 .ko（2026-10-22 CI 实测）
#   OpenWrt 打包时 scripts/gen-dependencies.sh 会对包内**每一个 -name '*.ko'**
#   的文件 objcopy 出 .modinfo 的 depends=，展开成「需要哪些模块」，再与包自身
#   .provides（同一套 *.ko 规则收的文件名）做差集，差集非空就 build 失败：
#       Package luci-app-mt5700 is missing dependencies for the following libraries:
#       usbcore.ko
#   本批里 snd-usb-audio / snd-usbmidi-lib 的 depends 含 usbcore，而 usbcore 在
#   各平台都是内建的、不存在 usbcore.ko 可供，于是差集恒为 {usbcore.ko}。
#   改成 .kmod 后两处 glob 同时不再命中它，问题消失；insmod 靠 ELF 内容而非
#   文件名装载，所以运行期行为一字未变。**别「顺手改回 .ko」**。
#
# 设计纪律：
#   1. 没有 UAC 设备时**一个模块都不装**（probe 不过就静默返回），
#      当前这台机器上是零开销、零内存占用，不存在「加载了但闲着」的假功能。
#   2. 顺序是硬依赖序，不能交给 depmod —— 这些模块不在 /lib/modules 的
#      搜索路径里，模块名解析由本次 insmod 顺序保证。
#   3. 任何一步 insmod 失败就停下并记录原因，绝不「跳过去继续装」：半套
#      音频栈不会报错，只会让 /proc/asound 空着，看起来像「驱动没生效」。
#   4. vermagic 用目录名做前置判断，最终裁决交给 insmod 自己 —— 它会把
#      「version magic ... should be ...」写进 stderr，那条才是真凭据。
#
# 用法：
#   audio-ko.sh probe     有 UAC 设备返回 0，否则 1（不发日志，供调用方判断）
#   audio-ko.sh load      需要时装（幂等）
#   audio-ko.sh unload    逆序卸掉（调试用）
#   audio-ko.sh status    人读的状态报告
# ============================================================================

KO_ROOT=/usr/share/mt5700/audio

# 拓扑序，改顺序前先读上面第 2 条纪律。
# 依赖关系取自各模块的 modinfo depends（2026-10-22 提取）：
#   snd→soundcore / snd-timer→snd / snd-pcm→snd,snd-timer / snd-hwdep→snd
#   snd-seq-device→snd / snd-rawmidi→snd,snd-seq-device
#   snd-usbmidi-lib→usbcore,snd-rawmidi,snd / mc、input-core 无依赖
#   snd-usb-audio→mc,usbcore,snd,snd-pcm,input-core,snd-usbmidi-lib,snd-hwdep
KO_ORDER="soundcore snd snd-timer snd-pcm snd-hwdep snd-seq-device snd-rawmidi snd-usbmidi-lib mc input-core snd-usb-audio"

ERRFILE=/tmp/.mt5700-audio-err

log() {
	logger -t mt5700-audio "$*" 2>/dev/null
}

# lsmod 里连字符会变成下划线（snd-usb-audio → snd_usb_audio），比对前统一
mod_name() {
	echo "$1" | tr '-' '_'
}

is_loaded() {
	lsmod 2>/dev/null | awk -v want="$1" 'NR > 1 && $1 == want { hit = 1 } END { exit !hit }'
}

# 是否存在 Audio Class 接口。
#
# bInterfaceClass 0x01 = Audio。这里只认 Audio Control 接口（0x01）而不是
# 整个音频设备：UAC 设备必定先暴露一个 Audio Control 接口，而 Audio
# Streaming 接口（同样 class 01）只有在 AcInterface 之后才出现 —— 用前者
# 判断能在枚举更早的阶段命中。
has_uac() {
	local f cls
	for f in /sys/bus/usb/devices/*/bInterfaceClass; do
		[ -r "$f" ] || continue
		cls=$(cat "$f" 2>/dev/null)
		[ "$cls" = "01" ] && return 0
	done
	return 1
}

ko_dir() {
	echo "$KO_ROOT/$(uname -r)"
}

cmd_probe() {
	has_uac
}

cmd_load() {
	local dir ver m nm f
	ver=$(uname -r)
	dir=$(ko_dir)

	# 没有 UAC 设备 ⇒ 什么都不做。这条必须在最前面：hotplug 会在每次 USB
	# 插入时调过来，包括插 U 盘、插键盘，不能每次都去碰内核模块。
	has_uac || return 3

	if [ ! -d "$dir" ]; then
		log "跳过：本内核($ver)没有随包模块（当前包只带 $(ls "$KO_ROOT" 2>/dev/null | tr '\n' ' ')）"
		return 2
	fi

	for m in $KO_ORDER; do
		nm=$(mod_name "$m")
		is_loaded "$nm" && continue

		f="$dir/$m.kmod"
		if [ ! -f "$f" ]; then
			log "失败：缺少模块文件 $m.kmod"
			return 4
		fi

		rm -f "$ERRFILE"
		if ! insmod "$f" 2>"$ERRFILE"; then
			log "失败：insmod $m —— $(tr '\n' ' ' < "$ERRFILE" 2>/dev/null)"
			rm -f "$ERRFILE"
			return 5
		fi
	done
	rm -f "$ERRFILE"

	log "音频驱动已就绪（$(uname -r)）"
	return 0
}

cmd_unload() {
	local rev m nm
	# 逆序：后装的先卸，否则 rmmod 会因为「被使用中」失败
	rev=$(echo $KO_ORDER | awk '{ for (i = NF; i > 0; i--) printf "%s ", $i }')
	for m in $rev; do
		nm=$(mod_name "$m")
		is_loaded "$nm" || continue
		rmmod "$nm" 2>/dev/null || log "卸载 $m 失败（可能仍被占用）"
	done
	log "音频驱动已卸载"
}

cmd_status() {
	local ver dir n_ko n_loaded card
	ver=$(uname -r)
	dir=$(ko_dir)
	n_ko=$(ls "$dir"/*.kmod 2>/dev/null | wc -l)
	n_loaded=$(lsmod 2>/dev/null | grep -c '^snd')
	card=$(sed -n '2p' /proc/asound/cards 2>/dev/null)

	echo "内核        : $ver"
	echo "模块目录    : $dir"
	echo "随包模块数  : $n_ko"
	if has_uac; then
		echo "USB Audio   : 已检测到 UAC 接口"
	else
		echo "USB Audio   : 无（本机模组不含 Audio Class，模块不会装载）"
	fi
	echo "已加载 snd  : $n_loaded 个"
	if [ -n "$card" ]; then
		echo "声卡        : $card"
	elif [ -d /proc/asound ]; then
		echo "声卡        : 无（/proc/asound/cards 为空）"
	else
		echo "声卡        : /proc/asound 不存在（snd 栈未加载）"
	fi
}

case "$1" in
	probe)  cmd_probe ;;
	load)   cmd_load ;;
	unload) cmd_unload ;;
	status) cmd_status ;;
	*)
		echo "用法: $0 {probe|load|unload|status}" >&2
		exit 1
		;;
esac
