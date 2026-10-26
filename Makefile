include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for AT WebServer (MT5700M 5G modem)
# 后端 Rust 二进制已随本包一起编译安装（见 src/Makefile），不再依赖独立后端包。
# 不在 LUCI_DEPENDS 里声明 rpcd/ucode/usbutils：luci-base 已依赖 rpcd+ucode；
# usbutils 仅 init.d 可选探测，SDK 内硬依赖会拖 libusb 编译失败。
#
# 同理也不声明 netcat：rpcd/ucode 插件（root/usr/share/rpcd/ucode/mt5700.uc）
# 经 busybox 的 nc 访问回环 RPC，而 nc 属于 busybox 基础命令，各映像几乎都带；
# 把它写成硬依赖，一旦目标源没有同名包就会直接让 opkg 安装失败，得不偿失。
# ucode 侧已对「连不上后端」给出明确报错，缺 nc 时是可诊断的，不是静默失败。
LUCI_DEPENDS:=
# 包内含架构相关二进制，不能是 all；置空让 package.mk 按板级架构打包
LUCI_PKGARCH:=

PKG_NAME:=luci-app-mt5700
# ─────────────────────────────────────────────────────────────
# 版本号是**发布契约**：make / CI / opkg 升级都认它。改动一旦合入 main
# 就必须递增（PKG_RELEASE 用于同版本重新打包）。详见 CHANGELOG.md。
# ─────────────────────────────────────────────────────────────
PKG_VERSION:=2.4.42
PKG_RELEASE:=1

# 许可与维护者：opkg/apk 的元数据与 OpenWrt 包索引都读这两个字段。
# 缺失时部分 SDK 会告警，且使用者无法判断授权条款、也无法联系维护者。
PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=woshinibabao1 <ajmd007@qq.com>

# 兼容旧版：已安装 at-webserver-rust 的系统升级到单包后，声明提供同名能力，
# 避免残留依赖指向不存在的包。
PKG_PROVIDES:=at-webserver-rust

# 打包前强制 init.d / uci-defaults 可执行（防止部分 checkout 丢失 +x 导致
# post-install 报 Permission denied）
define Build/Prepare
	$(call Build/Prepare/Default)
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/init.d/at-webserver 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/uci-defaults/at-webserver 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/hotplug.d/net/99-mt5700-renew 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/hotplug.d/usb/99-mt5700-audio 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/share/mt5700/audio-ko.sh 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/share/mt5700/to 2>/dev/null || true
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
