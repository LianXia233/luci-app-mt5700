include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for AT WebServer (MT5700M 5G modem)
# 后端 Rust 二进制已随本包一起编译安装（见 src/Makefile），不再依赖独立后端包。
# 不在 LUCI_DEPENDS 里声明 rpcd/ucode/usbutils：luci-base 已依赖 rpcd+ucode；
# usbutils 仅 init.d 可选探测，SDK 内硬依赖会拖 libusb 编译失败。
LUCI_DEPENDS:=
# 包内含架构相关二进制，不能是 all；置空让 package.mk 按板级架构打包
LUCI_PKGARCH:=

PKG_NAME:=luci-app-mt5700
PKG_VERSION:=1.12.4
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
endef

# 安装/升级完成后强制注册开机自启并拉起服务。
#
# 背景：本包的 root/etc/init.d/at-webserver 执行位曾两次静默回退
# （100755 → 100644），安装阶段的 enable 会以 Permission denied 失败，
# /etc/rc.d/S99at-webserver 从此缺失，服务永远不开机自启——LuCI 上就表现为
# 「未注册 / 进程未运行 / procd 无实例」。uci-defaults 只在首次启动时执行一次，
# 已装好的设备不会再走，所以这里再兜一道：装包或升包时补权限 + enable + 启动。
#
# IPKG_INSTROOT 非空表示在为镜像根目录（SDK/ImageBuilder）打包，
# 此时不能真的去 enable/启动，否则会污染宿主机。
define Package/luci-app-mt5700/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	chmod 0755 /etc/init.d/at-webserver 2>/dev/null
	/etc/init.d/at-webserver enable
	/etc/init.d/at-webserver restart 2>/dev/null || /etc/init.d/at-webserver start
}
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
