#!/bin/sh
# 由 Rust 后端在「自动拨号达成期望状态」时调用（路径可由配置键 uplink_hook 指定）。
#
# Debian 上没有 OpenWrt 的 netifd/ifup 体系，承载接口（模组 USB 网口，通常为
# usb0/eth1 等）由 DHCP 客户端接管。本脚本尽力而为：
#   1) 找到模组对应的 USB 网络接口（/sys/class/net 下带 USB 物理设备的接口）
#   2) 置为 up，并尝试可用的 DHCP 客户端（dhclient / udhcpc）
# 失败静默退出（exit 0），接口侧兜底交给系统 networkd / NetworkManager 等既有配置。

IFACE=""
for d in /sys/class/net/*; do
    name=$(basename "$d")
    [ "$name" = "lo" ] && continue
    [ -e "$d/device" ] || continue
    link=$(readlink -f "$d/device" 2>/dev/null)
    case "$link" in
        *usb*)
            IFACE="$name"
            break
            ;;
    esac
done

[ -n "$IFACE" ] || exit 0

ip link set "$IFACE" up 2>/dev/null

# 已有 IPv4 地址则不重复要
if ip -4 addr show "$IFACE" 2>/dev/null | grep -q 'inet '; then
    exit 0
fi

if command -v dhclient >/dev/null 2>&1; then
    dhclient -1 -q "$IFACE" >/dev/null 2>&1 &
elif command -v udhcpc >/dev/null 2>&1; then
    udhcpc -i "$IFACE" -q -n -b >/dev/null 2>&1 &
fi

exit 0
