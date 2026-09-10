# OpenWrt SDK 交叉编译与安装（Rust 后端 + LuCI 插件）

> 本机（宿主 Linux）无 OpenWrt SDK / 交叉编译工具链，以下为在 OpenWrt 构建机上
> 的标准操作步骤。任何「已在目标设备验证」的结论都不得据此文档声称——需在真实 SDK 环境执行后方可确认。

## 1. 前置

- OpenWrt 构建机（x86_64 Linux，建议 22.04/24.04），磁盘 ≥ 20GB。
- SDK 或完整 buildroot（`git clone https://github.com/openwrt/openwrt.git`）。
- Rust 目标工具链：SDK 通常自带 `rust` feed（`feeds/packages/lang/rust`），
  或在构建机装 `rustup` 并添加目标 triple。

目标 triple 由 OpenWrt 架构决定，常见：
| 目标架构 | Rust target |
|---|---|
| aarch64_cortex-a53 | aarch64-unknown-linux-musl |
| mips_24kc (mt7621) | mipsel-unknown-linux-musl |
| arm_cortex-a7 | armv7-unknown-linux-musleabihf |
| x86_64 | x86_64-unknown-linux-musl |

## 2. 把源码放进 buildroot

```sh
cd openwrt
# 方式 A：作为 feed
mkdir -p feeds/luci/applications
cp -r <本项目根目录 luci-app-mt5700> feeds/luci/applications/luci-app-mt5700/
mkdir -p package/at-webserver-rust
cp -r <本项目根目录>/src/rust/* package/at-webserver-rust/
# 方式 B：自定义 feed（推荐）
# feeds.conf.default 追加：
# src-link custom /path/to/your-feed
```

## 3. Rust 后端包 Makefile（已实现：src/rust/Makefile）

本仓库 `src/rust/Makefile` 即为 `at-webserver-rust` 包的 OpenWrt Makefile（随包源码一起复制即可使用），
关键点：

- 用 `RUST_TARGET_$(ARCH)` 表把 OpenWrt `$(ARCH)`（x86_64/aarch64/mipsel/arm）映射为 Rust musl 目标三元组；
- `Build/Compile` 直接调用 `cargo build --release --target $(RUST_TARGET)`，链接器由 cargo 全局配置
  （`${CARGO_HOME}/config.toml`）指向 **zig wrapper**（`zig cc -target <zig-target>`，musl 静态链接、
  无 glibc 依赖）；`scripts/sdk-build.sh` 会在容器内按目标三元组自动生成 wrapper 与配置；
- `Build/Install` 安装 `target/<triple>/release/at-webserver` 到 `/usr/bin/at-webserver-rust`。

> 构建环境要求（GitHub Actions 的 `scripts/sdk-build.sh` 已自动准备）：`rustup` 可用、
> `zig` 在 PATH、`rustup target add <triple>` 已执行、cargo 全局 config 已写入 zig 链接器。
> 本地交叉编译可参照：`rustup target add <triple>` 后把 `linker` 指向 `zig cc -target <zig-target>` 的
> wrapper 脚本（Rust triple → zig target：`armv7-unknown-linux-musleabihf` → `arm-linux-musleabihf`）。
> Cargo.toml 已用 `opt-level="s"`、LTO、panic=abort、strip 控制体积（release 约 1-2MB）。

## 4. LuCI 插件打包

`luci-app-mt5700/Makefile` 已提供（PKG_NAME=luci-app-mt5700，LUCI_DEPENDS:=+at-webserver-rust），
在 buildroot 中直接 `make package/luci-app-mt5700/compile V=s`。

## 5. 构建

```sh
./scripts/feeds update -a
./scripts/feeds install -a
make defconfig
# 选中:
#   Network -> at-webserver-rust
#   LuCI -> Applications -> luci-app-mt5700
make package/at-webserver-rust/compile V=s
make package/luci-app-mt5700/compile V=s
# 产物（OpenWrt ≤23.05，opkg → .ipk）
# bin/targets/<arch>/packages/at-webserver-rust_1.0.0-1_<arch>.ipk
# bin/packages/<arch>/luci/luci-app-mt5700_1.0.0-1_all.ipk
# 产物（OpenWrt 24.10+/主线，apk 包管理器 → .apk，路径相同、扩展名为 .apk）
# bin/targets/<arch>/packages/at-webserver-rust_1.0.0-1_<arch>.apk
# bin/packages/<arch>/luci/luci-app-mt5700_1.0.0-1_all.apk
```

> **apk / ipk 说明**：OpenWrt 24.10 起默认包管理器由 opkg 切换为 apk，构建产物为 `.apk`；
> 23.05 及更早仍是 `.ipk`（opkg）。两者安装命令分别为 `apk add` / `opkg install`。
> 无需修改任何源码或 Makefile——同一套包定义在对应版本的 buildroot 中直接产出对应格式。

## 6. 安装 / 卸载 / 服务管理

```sh
# 安装（先装后端再装 LuCI）
opkg install at-webserver-rust_*.ipk
opkg install luci-app-mt5700_*.ipk

# 服务
/etc/init.d/at-webserver start     # 启动
/etc/init.d/at-webserver stop      # 停止
/etc/init.d/at-webserver restart   # 重启
/etc/init.d/at-webserver reload    # 重载配置
/etc/init.d/at-webserver enable    # 开机自启
/etc/init.d/at-webserver disable   # 取消自启

# 状态与日志
/etc/init.d/at-webserver status
logread -e at-webserver            # procd 日志（stdout/stderr 由 logd 接管）

# 卸载
opkg remove luci-app-mt5700
opkg remove at-webserver-rust      # 会保留 /etc/config/at-webserver（opkg 默认保留配置）
```

## 7. 串口模式说明

- 默认 `connection_type=NETWORK`（连模组 TCP 20249，MT5700M 出厂 IP 192.168.8.1）。
- 改 `SERIAL` 时：`uci set at-webserver.config.serial_port=/dev/ttyUSB1`，
  服务启动时 init.d 会尝试把 VID/PID 3466:3301 绑定到 usbserial/option 驱动（仅缺 ttyUSB 时）。
- `serial_port=auto` 时 Rust 后端逐个探测 `/dev/ttyUSB*` 找能应答 AT 的端口。

## 8. 防火墙

init.d 启动时按 UCI 配置生成防火墙规则（幂等）：
- LuCI RPC（`websocket_port`，UCI 键名保留）仅监听 `127.0.0.1`，经 rpcd ucode 代理本机转发，
  不对外暴露，**无需也不生成** RPC 端口的外网规则（`websocket_allow_wan` 键保留兼容但不再生效）；
- `network_allow_wan=1/0` → 允许/拒绝外网访问模组 AT 端口；
- `network_restrict_access=1` → 仅路由器本身可访问模组端口。
停止服务时规则自动清理。

## 9. 常见问题

- **页面提示"RPC 调用失败/未运行"**：确认 Rust 服务已启动（`/etc/init.d/at-webserver status`）
  且 rpcd ucode 插件已生效（重启 `rpcd` 或安装后重登 LuCI）；`websocket_port` 与 LuCI 页面「服务配置」一致。
- **认证失败**：服务配置页的认证密钥与 UCI `websocket_auth_key` 一致；错误密钥会被后端拒绝（RPC 错误码 -32001）。
- **无法枚举 ttyUSB**：确认内核含 usbserial/option；或手动 `echo "3466 3301" > /sys/bus/usb-serial/drivers/option/new_id`。
- **IPK/APK 体积**：Rust 后端 release + strip 约 1-2MB；LuCI 插件全 JS 极小。

## 10. GitHub Actions 云编译（推荐）

仓库已内置 `.github/workflows/build-openwrt.yml`，无需本机 SDK 即可产出正式安装包：

- **矩阵**：最新主线（`openwrt/sdk:*-main`）→ `.apk`；老版本 23.05（`openwrt/sdk:*-23.05.5`）→ `.ipk`；
  架构 x86_64 / aarch64_cortex-a53 / mips_24kc。
- **流程**（`scripts/sdk-build.sh`）：容器内装 rustup + zig → 仓库包复制进 `package/`
  → `make package/at-webserver-rust/compile` → `make package/luci-app-mt5700/compile`
  → 收集 `bin/` 下全部 `.apk`/`.ipk`。
- **触发**：手动（Actions → Run workflow）、push main、打 `v*` 标签（自动发布 GitHub Release）。
- **Rust 交叉编译**：`rustup target add <triple>` + zig 链接器（容器内动态配置 wrapper），
  产物 musl 静态链接，与 OpenWrt 目标架构一一对应。
- **扩架构**：改 workflow `matrix`；若目标三元组未覆盖，在 `src/rust/Makefile` `RUST_TARGET_*` 与
  `scripts/sdk-build.sh` 的 zig target 映射中补充后提交即可。
