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
# The AT WebSocket terminal (at-server) is now a Rust binary (`mt5700m`)
# dispatched by argv[0] basename.  Python is no longer required.  `curl` is
# needed by the Rust at-server for the WeChat-Work notification webhook
# (HTTPS POST); ubus-at-daemon owns the PCUI serial port for the default UBUS
# AT channel; sms-tool_q provides the SMS helper used by the WebUI.
LUCI_DEPENDS:=+luci-base +ubus-at-daemon +sms-tool_q +curl
LUCI_EXTRA_DEPENDS:=kmod-usb2 (>=0), kmod-usb3 (>=0), kmod-usb-serial (>=0), kmod-usb-serial-option (>=0), kmod-usb-net (>=0), kmod-usb-net-cdc-ether (>=0), kmod-usb-net-cdc-ncm (>=0)
# NOTE: deliberately do NOT set LUCI_PKGARCH:=all — this package now ships an
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

# Directory containing *this* Makefile.  $(CURDIR) is unreliable because the
# package may be built straight from its own dir (standalone SDK) or from the
# feeds tree inside the gh-action-sdk container.  Anchoring on the Makefile's
# own path keeps the vendored Rust source and any CI-injected prebuilt binary
# locatable in both cases.
PKG_SRC_DIR:=$(dir $(lastword $(MAKEFILE_LIST)))
RUST_SRC_DIR:=$(PKG_SRC_DIR)mt5700m-rs
PREBUILT_DIR:=$(PKG_SRC_DIR)prebuilt
# Keep all Rust build artifacts inside the OpenWrt build dir so the package
# source tree stays clean.
CARGO_TARGET_DIR:=$(PKG_BUILD_DIR)/cargo-target

define Package/luci-app-mt5700m/conffiles
/etc/mt5700m/traffic-history
endef

include $(TOPDIR)/feeds/luci/luci.mk

# Build the Rust backend.  Two paths:
#   1. CI injects a prebuilt, stripped musl binary at
#      $(PREBUILT_DIR)/$(RUST_TARGET)/mt5700m (built off-tree by the GitHub
#      Actions rust job, then dropped next to this Makefile).  When present we
#      just copy it — this lets the OpenWrt SDK container (which has no Rust
#      toolchain) package the binary without compiling.
#   2. Otherwise compile in place with cargo (the normal local / SDK build).
#      Requires `cargo` + the `$(RUST_TARGET)` rust-std on the host
#      (`rustup target add $(RUST_TARGET)`).  The release profile sets
#      `strip = true`, so no separate $(STRIP) pass is needed.
# In both cases the binary is staged into $(PKG_BUILD_DIR)/root/usr/bin so
# luci.mk's default Package/install (copies root/*) ships it, and the
# `at-server` symlink lets /etc/init.d/at-webserver launch the WebSocket
# terminal exactly as before (argv[0] basename dispatch inside the binary).
define Build/Compile
	( \
		PREBUILT="$(PREBUILT_DIR)/$(RUST_TARGET)/mt5700m"; \
		$(INSTALL_DIR) "$(PKG_BUILD_DIR)/root/usr/bin"; \
		if [ -x "$$PREBUILT" ]; then \
			echo "mt5700m: using prebuilt binary $$PREBUILT"; \
			$(INSTALL_BIN) "$$PREBUILT" "$(PKG_BUILD_DIR)/root/usr/bin/mt5700m"; \
		else \
			if ! command -v cargo >/dev/null 2>&1; then \
				echo "ERROR: cargo (Rust toolchain) not found in PATH."; \
				echo "  luci-app-mt5700m requires EITHER:"; \
				echo "    1) a prebuilt musl binary at $(PREBUILT_DIR)/$(RUST_TARGET)/mt5700m"; \
				echo "       (the CI rust job builds it off-tree and drops it next to this Makefile)"; \
				echo "    2) cargo + the $(RUST_TARGET) rust-std installed on the build host"; \
				echo "  See README.md section 4.2 / 6. Aborting Build/Compile."; \
				exit 1; \
			fi; \
			cd "$(RUST_SRC_DIR)" && \
			CARGO_TARGET_DIR="$(CARGO_TARGET_DIR)" \
			cargo build --release --target "$(RUST_TARGET)" --offline && \
			$(INSTALL_BIN) "$(CARGO_TARGET_DIR)/$(RUST_TARGET)/release/mt5700m" \
				"$(PKG_BUILD_DIR)/root/usr/bin/mt5700m"; \
		fi; \
		ln -sf mt5700m "$(PKG_BUILD_DIR)/root/usr/bin/at-server"; \
		rm -f "$(PKG_BUILD_DIR)/root/usr/bin/at-server.py" ; \
	)
endef

# call BuildPackage - OpenWrt buildroot signature
