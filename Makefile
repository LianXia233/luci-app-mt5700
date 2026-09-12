include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for AT WebServer (MT5700M 5G modem)
# 后端 Rust 二进制已随本包一起编译安装（见 src/Makefile），不再依赖独立后端包。
# 不在 LUCI_DEPENDS 里声明 rpcd/ucode/usbutils：luci-base 已依赖 rpcd+ucode；
# usbutils 仅 init.d 可选探测，SDK 内硬依赖会拖 libusb 编译失败。
LUCI_DEPENDS:=
# 包内含架构相关二进制，不能是 all；置空让 package.mk 按板级架构打包
LUCI_PKGARCH:=

PKG_NAME:=luci-app-mt5700
PKG_VERSION:=1.3.3
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

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
