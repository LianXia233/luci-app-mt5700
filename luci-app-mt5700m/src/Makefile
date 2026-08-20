# Rust backend staging for luci-app-mt5700m.
#
# luci.mk invokes this Makefile from $(PKG_BUILD_DIR)/src (Build/Prepare copies
# ./src there first) as:
#   compile: $(MAKE_VARS) $(MAKE) -C $(PKG_BUILD_DIR)/src clean compile
#   install: $(MAKE) -C $(PKG_BUILD_DIR)/src DESTDIR=$(PKG_INSTALL_DIR) install
#
# Two binary paths (mirrors the pre-2.3.34 intent that never actually ran):
#   1. CI injects a prebuilt, stripped musl binary at
#      $(PREBUILT_BIN) (built off-tree by the GitHub Actions rust job and
#      dropped next to the package Makefile as prebuilt/<target>/mt5700m).
#      When present we just copy it — the OpenWrt SDK container has no Rust
#      toolchain, so this is the only path used in CI.
#   2. Otherwise compile in place with cargo (normal local / full buildroot
#      build).  Requires `cargo` + the $(RUST_TARGET) rust-std on the host
#      (`rustup target add $(RUST_TARGET)`).  The release profile sets
#      `strip = true`, so no separate strip pass is needed.
#
# The staged binary is installed as /usr/bin/mt5700m plus the `at-server`
# symlink so /etc/init.d/at-webserver can launch the WebSocket terminal via
# argv[0] basename dispatch.
#
# All variables below (except DESTDIR, provided by MAKE_INSTALL_FLAGS) come
# from the package Makefile via MAKE_VARS command-line assignments.

BIN := mt5700m

all: compile

compile:
	@if [ -n "$(PREBUILT_BIN)" ] && [ -x "$(PREBUILT_BIN)" ]; then \
		echo "mt5700m: staging prebuilt binary $(PREBUILT_BIN)"; \
		cp -f "$(PREBUILT_BIN)" "$(BIN)"; \
	elif command -v cargo >/dev/null 2>&1; then \
		echo "mt5700m: cargo build --release --target $(RUST_TARGET)"; \
		cd "$(RUST_SRC_DIR)" && \
		CARGO_TARGET_DIR="$(CARGO_TARGET_DIR)" \
		cargo build --release --target "$(RUST_TARGET)" --offline && \
		cp -f "$(CARGO_TARGET_DIR)/$(RUST_TARGET)/release/mt5700m" "$(BIN)"; \
	else \
		echo "ERROR: no prebuilt binary at $(PREBUILT_BIN) and cargo not found." >&2; \
		echo "  luci-app-mt5700m requires EITHER:" >&2; \
		echo "    1) a prebuilt musl binary at prebuilt/$(RUST_TARGET)/mt5700m" >&2; \
		echo "       (the CI rust job builds it off-tree and drops it next to this package)" >&2; \
		echo "    2) cargo + the $(RUST_TARGET) rust-std installed on the build host" >&2; \
		echo "  See README.md section 4.2 / 6. Aborting." >&2; \
		exit 1; \
	fi
	chmod 0755 "$(BIN)"

install: compile
	mkdir -p $(DESTDIR)/usr/bin
	install -m 0755 "$(BIN)" $(DESTDIR)/usr/bin/mt5700m
	ln -sf mt5700m $(DESTDIR)/usr/bin/at-server

clean:
	rm -f "$(BIN)"
