include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for AT WebServer (MT5700M 5G modem)
# 后端 Rust 二进制已随本包一起编译安装（见 src/Makefile）
# 运行时依赖：rpcd 加载 ucode 插件；ucode-mod-uci 读配置；usbutils 供 init.d 探测串口
LUCI_DEPENDS:=+rpcd +ucode +ucode-mod-uci +usbutils
# 包内含架构相关二进制，不能是 all；置空让 package.mk 按板级架构打包
LUCI_PKGARCH:=

PKG_NAME:=luci-app-mt5700
PKG_VERSION:=1.1.1
PKG_RELEASE:=1

# 兼容旧版：已安装 at-webserver-rust 的系统升级到单包后，声明提供同名能力，
# 避免残留依赖指向不存在的包。
PKG_PROVIDES:=at-webserver-rust

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
