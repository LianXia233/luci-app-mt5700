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

# ---- OpenWrt 架构 → Rust musl 目标三元组映射 ----
#
# 三种取值的优先级：调用方传入的 RUST_TRIPLE > ARCH_PACKAGES 精确匹配 > ARCH 基础名匹配。
# 全部落空时**直接报错**，不做任何兜底推断。
#
# 为什么不允许兜底：本文件在 SDK/交叉编译环境里执行，宿主架构（容器恒为 x86_64）
# 与目标架构无关。此前按 `uname -m` 兜底，在 ARCH 未命中映射表时会静默编出 x86_64
# 二进制并打进 mipsel/aarch64 的包里——包能装、运行报 Exec format error，
# 而构建阶段零告警（体积闸门反而更容易通过）。宁可让构建失败。
#
# ARCH 与 ARCH_PACKAGES 的区别：
#   ARCH           = 基础 CPU 架构名（arm / mipsel / mips / aarch64 / x86_64）
#   ARCH_PACKAGES  = ARCH + CPU_TYPE 细分（aarch64_cortex-a53 / arm_cortex-a7_neon-vfpv4）
# 大端小端：mips* 是 big-endian，mipsel* 是 little-endian，两者不可混用。
#
# aarch64_cortex-a53 与 aarch64_generic 都是 ARMv8-A 指令集，Rust 侧统一用
# aarch64-unknown-linux-musl（默认 target-cpu=generic）即可，无需区分。
RUST_TARGET_x86_64         := x86_64-unknown-linux-musl
RUST_TARGET_aarch64        := aarch64-unknown-linux-musl
RUST_TARGET_mipsel         := mipsel-unknown-linux-musl
RUST_TARGET_mips           := mips-unknown-linux-musl
RUST_TARGET_riscv64        := riscv64-unknown-linux-musl
RUST_TARGET_arm            := armv7-unknown-linux-musleabihf

# ARCH 可能带 CPU 优化后缀（部分构建系统把 ARCH_PACKAGES 当 ARCH 用），补齐常见组合
RUST_TARGET_mipsel_24kc    := mipsel-unknown-linux-musl
RUST_TARGET_mips_24kc      := mips-unknown-linux-musl
RUST_TARGET_mips_74kc      := mips-unknown-linux-musl
RUST_TARGET_mips_24kec     := mips-unknown-linux-musl
RUST_TARGET_aarch64_cortex-a53  := aarch64-unknown-linux-musl
RUST_TARGET_aarch64_cortex-a72  := aarch64-unknown-linux-musl
RUST_TARGET_aarch64_cortex-a76  := aarch64-unknown-linux-musl
RUST_TARGET_aarch64_generic     := aarch64-unknown-linux-musl

# arm 细分类：OpenWrt 里 ARCH=arm 覆盖 armv5/v6/v7 三档 ABI。
# 一律映射 armv7 会让 armv5（AR7/IXP 等）与 armv6（BCM2835 等）目标板
# 装上就打 Illegal instruction，因此按 ARCH_PACKAGES 细分。
RUST_TARGET_arm_arm926ej-s       := armv5-unknown-linux-musleabi
RUST_TARGET_arm_xscale           := armv5-unknown-linux-musleabi
RUST_TARGET_arm_fa526            := armv5-unknown-linux-musleabi
RUST_TARGET_arm_arm1176jzf-s_vfp := armv6-unknown-linux-musleabihf
RUST_TARGET_arm_arm1176jzf-s     := armv6-unknown-linux-musleabihf

# 先试 ARCH_PACKAGES 精确匹配，再退回 ARCH 基础名
RUST_LOOKUP_KEY := $(if $(RUST_TARGET_$(ARCH_PACKAGES)),$(ARCH_PACKAGES),$(ARCH))
RUST_TARGET := $(if $(RUST_TRIPLE),$(RUST_TRIPLE),$(RUST_TARGET_$(RUST_LOOKUP_KEY)))

ifeq ($(strip $(RUST_TARGET)),)
$(error 无法推断 Rust 目标三元组（ARCH=$(ARCH) ARCH_PACKAGES=$(ARCH_PACKAGES) RUST_TRIPLE=$(RUST_TRIPLE)）。请显式传入 RUST_TRIPLE=<triple>；本构建禁止按宿主架构兜底，否则会产出错误架构的二进制)
endif

CARGO_TARGET_DIR := $(CURDIR)/target
BIN := $(CARGO_TARGET_DIR)/$(RUST_TARGET)/release/at-webserver

.PHONY: all compile clean install

all: compile

compile:
	@echo "==> [mt5700] cargo build: ARCH=$(ARCH) ARCH_PACKAGES=$(ARCH_PACKAGES) RUST_TARGET=$(RUST_TARGET)"
	cd $(RUST_DIR) && \
		CARGO_TARGET_DIR="$(CARGO_TARGET_DIR)" \
		cargo build $(CARGO_BUILD_STD_FLAGS) --release --target $(RUST_TARGET)
	test -x "$(BIN)" || { echo "ERROR: cargo 未产出 $(BIN)"; exit 1; }
	@echo "==> [mt5700] 后端二进制就绪: $(BIN)"

install: compile
	# 注意：luci.mk 调用本子 Makefile 时只传 DESTDIR，不传 INSTALL_DIR/INSTALL_BIN，
	# 直接用 mkdir/cp/chmod（SDK 容器内必有），避免 Error 127。
	mkdir -p "$(DESTDIR)/usr/bin"
	cp "$(BIN)" "$(DESTDIR)/usr/bin/at-webserver-rust"
	chmod 0755 "$(DESTDIR)/usr/bin/at-webserver-rust"

clean:
	cd $(RUST_DIR) && cargo clean 2>/dev/null || true
	rm -rf "$(CARGO_TARGET_DIR)"
