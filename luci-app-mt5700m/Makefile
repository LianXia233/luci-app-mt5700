include $(TOPDIR)/rules.mk

# The WebUI (htdocs/5700) is a pre-built UMI/Webpack SPA whose bundle already
# ships minified.  LuCI's build-time `jsmin` (Crockford JSMin) cannot parse
# regex literals that follow `=>`/`)`/`]` and rewrites them as division, which
# corrupts umi.*.js / the shared async chunks and makes the whole SPA white-
# screen at /5700/#/network/info (and every other route).  Disable JS
# minification for this package so the already-minified bundle ships untouched.
LUCI_MINIFY_JS:=0

PKG_NAME:=luci-app-mt5700m
PKG_VERSION:=2.3.32
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0

LUCI_TITLE:=MT5700M module management
LUCI_DEPENDS:=+luci-base +ubus-at-daemon +sms-tool_q +python3 +python3-websockets +python3-pyserial
LUCI_EXTRA_DEPENDS:=kmod-usb2 (>=0), kmod-usb3 (>=0), kmod-usb-serial (>=0), kmod-usb-serial-option (>=0), kmod-usb-net (>=0), kmod-usb-net-cdc-ether (>=0), kmod-usb-net-cdc-ncm (>=0)
LUCI_PKGARCH:=all

define Package/luci-app-mt5700m/conffiles
/etc/mt5700m/traffic-history
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
