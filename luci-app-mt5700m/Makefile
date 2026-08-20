# Directory containing *this* Makefile.  $(CURDIR) is unreliable because the
# package may be built straight from its own dir (standalone SDK) or from the
# feeds tree inside the gh-action-sdk container.  Anchoring on the Makefile's
# own path keeps the vendored Rust source and any CI-injected prebuilt binary
# locatable in both cases.
#
# CRITICAL: this MUST be evaluated before `include $(TOPDIR)/rules.mk` below.
# `$(lastword $(MAKEFILE_LIST))` returns the most recently *included* Makefile,
# not the one currently being parsed.  After rules.mk (and its transitive
# includes) runs, the lastword points somewhere under include/ — e.g.
# `/builder/include/verbose.mk` — so `$(dir …)` resolves to the wrong tree and
# PREBUILT_BIN / RUST_SRC_DIR silently point at non-existent paths, which makes
# src/Makefile fall through to "no prebuilt binary and cargo not found" and fail
# the whole package build.  Capturing here (while MAKEFILE_LIST contains only
# this file) is the only reliable anchor.
#
# `$(abspath …)` is required because the result may be a relative path (e.g. `./`
# when the package is built via `make -C <pkgdir>`).  The src/ sub-make runs in
# $(PKG_BUILD_DIR)/src — a different CWD — so a relative PREBUILT_BIN would
# resolve against the wrong directory and the copy would fail.  abspath freezes
# the path to an absolute location at parse time.  Trailing `/` is re-added
# because abspath strips it and downstream vars concatenate as $(PKG_SRC_DIR)prebuilt.
PKG_SRC_DIR:=$(abspath $(dir $(lastword $(MAKEFILE_LIST))))/
include $(TOPDIR)/rules.mk

# The WebUI (htdocs/5700) is a pre-built UMI/Webpack SPA whose bundle already
# ships minified.  LuCI's build-time `jsmin` (Crockford JSMin) cannot parse
# regex literals that follow `=>`/`)`/`]` and rewrites them as division, which
# corrupts umi.*.js / the shared async chunks and makes the whole SPA white-
# screen at /5700/#/network/info (and every other route).  Disable JS
# minification for this package so the already-minified bundle ships untouched.
LUCI_MINIFY_JS:=0

PKG_NAME:=luci-app-mt5700m
PKG_VERSION:=2.3.34
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0

LUCI_TITLE:=MT5700M module management
# The AT WebSocket terminal (at-server) is a Rust binary (`mt5700m`)
# dispatched by argv[0] basename.  Python is no longer required.  `curl` is
# needed by the Rust at-server for the WeChat-Work notification webhook
# (HTTPS POST); ubus-at-daemon owns the PCUI serial port for the default UBUS
# AT channel; sms-tool_q provides the SMS helper used by the WebUI.
LUCI_DEPENDS:=+luci-base +ubus-at-daemon +sms-tool_q +curl
LUCI_EXTRA_DEPENDS:=kmod-usb2 (>=0), kmod-usb3 (>=0), kmod-usb-serial (>=0), kmod-usb-serial-option (>=0), kmod-usb-net (>=0), kmod-usb-net-cdc-ether (>=0), kmod-usb-net-cdc-ncm (>=0)
# NOTE: deliberately do NOT set LUCI_PKGARCH:=all — this package ships an
# architecture-specific Rust binary and must inherit the target PKGARCH.

# --- Rust cross-compilation ------------------------------------------------
# Map the OpenWrt target (ARCH / CPU_TYPE) to a musl target triple for cargo.
# Override explicitly via CONFIG_RUST_TARGET (menuconfig) if a board needs a
# different ABI (e.g. soft-float ARM or a custom libc).
RUST_TARGET:=$(call qstrip,$(CONFIG_RUST_TARGET))
ifeq ($(RUST_TARGET),)
  ifeq ($(ARCH),aarch64)
    RUST_TARGET:=aarch64-unknown-linux-musl
  else ifeq ($(ARCH),arm)
    ifneq ($(filter cortex-a%,$(CPU_TYPE)),)
      RUST_TARGET:=armv7-unknown-linux-musleabihf
    else
      RUST_TARGET:=arm-unknown-linux-musleabi
    endif
  else ifeq ($(ARCH),mipsel)
    RUST_TARGET:=mipsel-unknown-linux-musl
  else ifeq ($(ARCH),mips)
    RUST_TARGET:=mips-unknown-linux-musl
  else ifeq ($(ARCH),x86_64)
    RUST_TARGET:=x86_64-unknown-linux-musl
  else ifeq ($(ARCH),i386)
    RUST_TARGET:=i686-unknown-linux-musl
  else
    RUST_TARGET:=$(ARCH)-unknown-linux-musl
  endif
endif

PREBUILT_DIR:=$(PKG_SRC_DIR)prebuilt

# --- Binary staging ---------------------------------------------------------
# IMPORTANT: luci.mk evaluates BuildPackage at include time, so a custom
# `define Build/Compile` placed AFTER the include is silently ignored — this
# is exactly how v2.3.33 shipped an apk WITHOUT /usr/bin/at-server (the
# backend binary never entered the package and the WebUI lost its WebSocket
# data channel, see CHANGELOG 2.3.34).  luci.mk only honours its own build
# channel: when `src/Makefile` exists it runs
#   $(MAKE_VARS) $(MAKE) -C $(PKG_BUILD_DIR)/src clean compile
# and (with PKG_INSTALL:=1)
#   $(MAKE) -C $(PKG_BUILD_DIR)/src DESTDIR=$(PKG_INSTALL_DIR) install
# so the Rust staging logic lives in src/Makefile.
#
# NOTE on variable passing: `MAKE_VARS +=` does NOT work here — luci.mk
# includes package.mk (line 139) which loads package-defaults.mk defining
# `MAKE_VARS = ...`, overwriting anything appended before the include.
# Environment `export` is immune to that: exported vars reach the src/
# sub-make through the recipe environment and are picked up as env-origin
# variables there.  All values below use deferred `=` so PKG_BUILD_DIR
# (set inside luci.mk) is already defined when they are expanded at
# recipe-run time.
PREBUILT_BIN = $(PREBUILT_DIR)/$(RUST_TARGET)/mt5700m
RUST_SRC_DIR = $(PKG_SRC_DIR)mt5700m-rs
CARGO_TARGET_DIR = $(PKG_BUILD_DIR)/cargo-target
export PREBUILT_BIN RUST_SRC_DIR RUST_TARGET CARGO_TARGET_DIR

define Package/luci-app-mt5700m/conffiles
/etc/mt5700m/traffic-history
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
# (Do NOT remove: include/scan.mk only indexes package dirs whose Makefile text
#  matches `call BuildPackage` — luci.mk-based packages lack the real call, so
#  this comment marker is what keeps this package visible to feeds install.)
