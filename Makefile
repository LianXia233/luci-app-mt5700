include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for AT WebServer (MT5700M 5G modem)
# 后端 Rust 二进制已随本包一起编译安装（见 src/Makefile），不再依赖独立后端包。
# 不在 LUCI_DEPENDS 里声明 rpcd/ucode/usbutils：luci-base 已依赖 rpcd+ucode；
# usbutils 仅 init.d 可选探测，SDK 内硬依赖会拖 libusb 编译失败。
#
# 关于 nc：前端到后端的 RPC 由 rpcd ucode 插件 mt5700.uc 经 `nc 127.0.0.1 <port>`
# 打通（ucode 的 fs 无 socket 能力）。nc 由 busybox 提供，是否编译进固件取决于
# 各固件的 busybox 配置，无法用一个包依赖强行保证——因此这里不声明 netcat
# （它与 busybox 的 /usr/bin/nc 会冲突），改由 mt5700.uc 运行时探测并给出可诊断的报错。
LUCI_DEPENDS:=
# 包内含架构相关二进制，不能是 all；置空让 package.mk 按板级架构打包
LUCI_PKGARCH:=

PKG_NAME:=luci-app-mt5700
PKG_VERSION:=1.12.6
PKG_RELEASE:=1

# 兼容旧版：已安装 at-webserver-rust 的系统升级到单包后，声明提供同名能力，
# 避免残留依赖指向不存在的包。
PKG_PROVIDES:=at-webserver-rust

# 打包前强制 init.d / uci-defaults 可执行（防止部分 checkout 丢失 +x 导致
# post-install 报 Permission denied）
define Build/Prepare
	$(call Build/Prepare/Default)
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/init.d/at-webserver 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/uci-defaults/at-webserver 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/hotplug.d/iface/99-at-webserver 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/hotplug.d/usb/99-at-webserver 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/at-webserver/on-uplink.sh 2>/dev/null || true
endef

# 安装/升级完成后强制注册开机自启并拉起服务。
#
# 背景：本包的 root/etc/init.d/at-webserver 执行位曾两次静默回退
# （100755 → 100644），安装阶段的 enable 会以 Permission denied 失败，
# /etc/rc.d/S99at-webserver 从此缺失，服务永远不开机自启——LuCI 上就表现为
# 「未注册 / 进程未运行 / procd 无实例」。uci-defaults 只在首次启动时执行一次，
# 已装好的设备不会再走，所以这里再兜一道：装包或升包时补权限 + enable + 启动。
#
# 严重注意（本包自定义 postinst 的代价）：luci.mk 的默认 postinst 是用
# `ifndef Package/$(PKG_NAME)/postinst` 保护的，一旦本文件在 include luci.mk 之前
# 定义了同名目标，默认实现会被**整段跳过**。而默认实现里有三件必须做的事：
#     rm -f /tmp/luci-indexcache.*
#     rm -rf /tmp/luci-modulecache/
#     /etc/init.d/rpcd reload
# 缺了 rpcd reload，rpcd 不会重新扫描 /usr/share/rpcd/ucode/ 与 acl.d/，新装的
# mt5700.uc 与权限文件不生效，页面上所有 RPC 调用报 Access denied / Method not
# found——表现为「装完就能用的插件，重启前一直报错」，这正是全新安装的必踩故障。
# 因此下面把这三条显式搬进来。
#
# IPKG_INSTROOT 非空表示在为镜像根目录（SDK/ImageBuilder）打包，
# 此时不能真的去 enable/启动，否则会污染宿主机。
define Package/luci-app-mt5700/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	# ---------------------------------------------------------------------
	# 合并 apk/opkg 因「受保护路径」留下的 .apk-new
	#
	# OpenWrt 的 apk 把 /etc/init.d 视为受保护路径（与 /etc/config 同等对待）：
	# 升级时若判定目标文件被本地修改过，就把新版写成 <file>.apk-new 而**不覆盖**。
	# 后果是服务脚本永远停在上一个版本 —— 本插件的关键修复（接口自动创建、
	# 拨号对齐对账、hotplug 协同）全在 init.d 里，不合并等于没升级。
	#
	# 实测（Hiveton H5000M，1.12.3 → 1.12.5）：升级后 /etc/init.d/at-webserver
	# 仍是 11250 字节的旧版，新版 21753 字节躺在 /etc/init.d/at-webserver.apk-new。
	#
	# 这里只合并服务脚本与 uci-defaults；/etc/config 下的 .apk-new 一律不动——
	# 那是用户配置，应由用户决定是否采用新版默认值。
	# ---------------------------------------------------------------------
	for f in /etc/init.d/at-webserver /etc/uci-defaults/at-webserver; do
		for suf in .apk-new .opkg-new; do
			if [ -f "$$f$$suf" ]; then
				mv -f "$$f$$suf" "$$f" && logger -t at-webserver "已用新版覆盖 $$f（来自 $${suf}）"
			fi
		done
		if [ -f "$$f-opkg" ]; then
			mv -f "$$f-opkg" "$$f" && logger -t at-webserver "已用新版覆盖 $$f（来自 -opkg）"
		fi
		chmod 0755 "$$f" 2>/dev/null
	done

	chmod 0755 /etc/init.d/at-webserver 2>/dev/null
	/etc/init.d/at-webserver enable
	/etc/init.d/at-webserver restart 2>/dev/null || /etc/init.d/at-webserver start
	# 安装/升级后立即核对一次模组接口：不存在就创建（V4 必建并取址，V6 也建、
	# 按实际网络状况取址）。服务里的同类检查是在后台跑的，装完这一刻还没跑到。
	# 只建接口、不做 ifup，避免被 DHCP 等待拖住安装进程。
	/etc/init.d/at-webserver ensure_interfaces 2>/dev/null || true
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd reload 2>/dev/null
}
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
