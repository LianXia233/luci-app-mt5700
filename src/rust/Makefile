# OpenWrt 包 Makefile —— Rust 后端 at-webserver-rust
# 源码: 本目录（src/rust），构建方式: cargo（宿主编译）+ zig 交叉链接（musl 静态）
# 依赖: 构建环境需 rustup + zig（GitHub Actions 工作流 scripts/sdk-build.sh 已自动安装）
include $(TOPDIR)/rules.mk

PKG_NAME:=at-webserver-rust
PKG_VERSION:=3.0.2
PKG_RELEASE:=1

PKG_BUILD_DIR := $(BUILD_DIR)/$(PKG_NAME)
PKG_USE_MIPS16:=0
PKG_BUILD_FLAGS:=no-mips16

include $(INCLUDE_DIR)/package.mk

define Package/at-webserver-rust
  SECTION:=net
  CATEGORY:=Network
  TITLE:=MT5700M 5G modem AT WebServer (Rust backend)
  URL:=https://github.com/LianXia233/luci-app-mt5700
  DEPENDS:=
endef

# ---- OpenWrt ARCH → Rust musl target 映射 ----
RUST_TARGET_x86_64  := x86_64-unknown-linux-musl
RUST_TARGET_aarch64 := aarch64-unknown-linux-musl
RUST_TARGET_mipsel  := mipsel-unknown-linux-musl
RUST_TARGET_arm     := armv7-unknown-linux-musleabihf

RUST_TARGET := $(RUST_TARGET_$(ARCH))
ifeq ($(strip $(RUST_TARGET)),)
$(error 不支持的架构 $(ARCH)，请在 Makefile RUST_TARGET_* 中添加映射)
endif

define Build/Compile
	cd $(PKG_BUILD_DIR) && \
		CARGO_TARGET_DIR="$(PKG_BUILD_DIR)/target" \
		cargo build --release --target $(RUST_TARGET)
endef

define Package/at-webserver-rust/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/target/$(RUST_TARGET)/release/at-webserver $(1)/usr/bin/at-webserver-rust
endef

$(eval $(call BuildPackage,at-webserver-rust))
