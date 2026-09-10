# 本 Makefile 由 luci.mk 在包构建阶段调用（`make clean compile` / `make install`），
# 运行在 $(PKG_BUILD_DIR)/src/ 下。Rust 源码位于 src/rust/。
#
# 作用：把 Rust 后端 at-webserver 编进 luci-app-mt5700 同一个包，
#      使前端 LuCI 页面 + 后端二进制合为单个 apk/ipk，安装时不再依赖独立的
#      at-webserver-rust 包（v1.0.0 正因为该包未产出导致 apk 报依赖缺失）。
#
# 链路：luci.mk Build/Compile → 本文件 compile → cargo build
#      luci.mk Package/install（$(wildcard ${CURDIR}/src) 分支）→ Build/Install/Default
#      → 本文件 install → $(DESTDIR)/usr/bin/at-webserver-rust

RUST_DIR := rust

# ---- OpenWrt ARCH → Rust musl target 映射（RUST_TRIPLE 由构建脚本传入时优先）----
# 注意大小端：mips*_24kc 是 big-endian（mips），mipsel* 是 little-endian。
RUST_TARGET_x86_64         := x86_64-unknown-linux-musl
RUST_TARGET_aarch64        := aarch64-unknown-linux-musl
RUST_TARGET_mipsel         := mipsel-unknown-linux-musl
RUST_TARGET_mips           := mips-unknown-linux-musl
RUST_TARGET_mips_24kc      := mips-unknown-linux-musl
RUST_TARGET_mipsel_24kc    := mipsel-unknown-linux-musl
RUST_TARGET_arm            := armv7-unknown-linux-musleabihf

RUST_TARGET := $(if $(RUST_TRIPLE),$(RUST_TRIPLE),$(RUST_TARGET_$(ARCH)))
ifeq ($(strip $(RUST_TARGET)),)
# 兜底：按宿主架构推断，仅用于本地验证
UNAME_M := $(shell uname -m)
RUST_TARGET := $(if $(filter x86_64,$(UNAME_M)),x86_64-unknown-linux-musl,$(if $(filter aarch64 arm64,$(UNAME_M)),aarch64-unknown-linux-musl,))
endif
ifeq ($(strip $(RUST_TARGET)),)
$(error 无法推断 Rust 目标三元组，请通过 RUST_TRIPLE= 环境变量指定)
endif

CARGO_TARGET_DIR := $(CURDIR)/target
BIN := $(CARGO_TARGET_DIR)/$(RUST_TARGET)/release/at-webserver

.PHONY: all compile clean install

all: compile

compile:
	@echo "==> [mt5700] cargo build: ARCH=$(ARCH) RUST_TARGET=$(RUST_TARGET)"
	cd $(RUST_DIR) && \
		CARGO_TARGET_DIR="$(CARGO_TARGET_DIR)" \
		cargo build $(CARGO_BUILD_STD_FLAGS) --release --target $(RUST_TARGET)
	test -x "$(BIN)" || { echo "ERROR: cargo 未产出 $(BIN)"; exit 1; }
	@echo "==> [mt5700] 后端二进制就绪: $(BIN)"

install: compile
	$(INSTALL_DIR) $(DESTDIR)/usr/bin
	$(INSTALL_BIN) "$(BIN)" $(DESTDIR)/usr/bin/at-webserver-rust

clean:
	cd $(RUST_DIR) && cargo clean 2>/dev/null || true
	rm -rf "$(CARGO_TARGET_DIR)"
