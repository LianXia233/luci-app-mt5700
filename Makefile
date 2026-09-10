include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for AT WebServer (MT5700M 5G modem)
LUCI_DEPENDS:=+at-webserver-rust
LUCI_PKGARCH:=all

PKG_NAME:=luci-app-mt5700
PKG_VERSION:=3.0.2
PKG_RELEASE:=1

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
