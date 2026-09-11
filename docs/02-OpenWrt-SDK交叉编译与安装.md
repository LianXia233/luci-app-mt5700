# OpenWrt SDK 交叉编译与安装

> 适用于 **v1.1.0+ 单包** `luci-app-mt5700`（前端页面 + Rust 后端同一 apk/ipk）。  
> 推荐直接用仓库内置的 **GitHub Actions 云编译**，无需本机 SDK。  
> 本文档描述在真实 OpenWrt buildroot/SDK 上的等价操作；「已在目标设备验证」须以实机结果为准。

---

## 1. 前置

| 项 | 要求 |
|:--|:--|
| 构建机 | x86_64 Linux，磁盘 ≥ 20GB |
| 源码 | OpenWrt buildroot 或对应版本 SDK |
| Rust | `rustup` + 目标 musl triple |
| 链接器 | **zig**（musl 静态链接，避免 glibc） |

常见 OpenWrt 架构 → Rust target：

| OpenWrt ARCH | Rust target | zig target |
|:--|:--|:--|
| x86_64 | `x86_64-unknown-linux-musl` | `x86_64-linux-musl` |
| aarch64_cortex-a53 | `aarch64-unknown-linux-musl` | `aarch64-linux-musl` |
| arm_cortex-a7 | `armv7-unknown-linux-musleabihf` | `arm-linux-musleabihf` |
| mips_24kc | `mips-unknown-linux-musl` | `mips-linux-musl` |
| mipsel_24kc | `mipsel-unknown-linux-musl` | `mipsel-linux-musl` |

> aarch64_cortex-a53 会向链接器注入 `--fix-cortex-a53-843419`；zig 不认识该旗标，  
> 需在 wrapper 中过滤（云编译脚本 `scripts/sdk-build.sh` 已处理）。

---

## 2. 放入 buildroot（只需一个包）

```sh
cd openwrt

# 方式 A：放进 luci applications
mkdir -p feeds/luci/applications
cp -r /path/to/luci-app-mt5700 feeds/luci/applications/luci-app-mt5700/

# 方式 B：自定义 feed（推荐）
# feeds.conf.default 增加：
#   src-link custom /path/to/feed-parent
```

**不需要**再单独拷贝 `src/rust` 到 `package/at-webserver-rust`。  
后端源码在包内 `src/rust/`，由 `src/Makefile` 在编译 `luci-app-mt5700` 时一并构建。

---

## 3. 包如何把 Rust 打进去

1. 根 `Makefile`：`luci.mk` 打包 LuCI 面（htdocs / root / po）。
2. `src/Makefile`（luci.mk 在 `src/` 存在时调用）：
   - `ARCH` / `RUST_TRIPLE` → musl 目标
   - `cargo build --release --target <triple>`
   - 安装 `at-webserver` → `$(DESTDIR)/usr/bin/at-webserver-rust`
3. `PKG_PROVIDES:=at-webserver-rust`：兼容旧系统上残留的独立包依赖。

产物形态：

- OpenWrt **23.05** → `luci-app-mt5700_1.2.0_<arch>.ipk`
- OpenWrt **24.10+** → `luci-app-mt5700-1.2.0-r1.apk`

体积约 **1.2MB**（含静态 musl 后端）。

---

## 4. 本地 SDK 构建示例

```sh
./scripts/feeds update luci
./scripts/feeds install luci
make defconfig

# 只选中本包（后端已并入）
echo "CONFIG_PACKAGE_luci-app-mt5700=m" >> .config
echo "CONFIG_PACKAGE_luci-i18n-mt5700-zh-cn=m" >> .config
make defconfig

export RUST_TRIPLE=x86_64-unknown-linux-musl   # 按目标改
# 可选：将 cargo 全局 linker 指向 zig wrapper（与 CI 相同思路）

make package/luci-app-mt5700/compile V=s
```

校验二进制是否进包：

```sh
# ipk
tar -xzOf bin/packages/*/luci/luci-app-mt5700_*.ipk ./data.tar.gz | tar -tzf - | grep at-webserver-rust

# 或看安装树
ls build_dir/target-*/luci-app-mt5700/ipkg-*/luci-app-mt5700/usr/bin/at-webserver-rust
```

---

## 5. 安装 / 卸载 / 服务

```sh
# apk（24.10+）
apk add --allow-untrusted ./<arch>-luci-app-mt5700-1.2.0-r1.apk

# opkg（23.05）
opkg install ./luci-app-mt5700_1.2.0_<arch>.ipk

# 启用
uci set at-webserver.config.enabled=1
uci set at-webserver.config.connection_type=SERIAL
uci commit at-webserver
/etc/init.d/at-webserver enable
/etc/init.d/at-webserver restart

# 日志
logread -e at-webserver

# 卸载（配置默认保留）
opkg remove luci-app-mt5700
# apk del luci-app-mt5700
```

---

## 6. 默认连接（PCUI）

| 键 | 默认 | 说明 |
|:--|:--|:--|
| `connection_type` | `SERIAL` | PCUI 串口优先 |
| `serial_port` | `auto` | 自动探测，优先 `/dev/ttyUSB1` |
| `serial_baudrate` | `115200` | |
| `network_host` / `network_port` | `192.168.8.1` / `20249` | TCP 备用 |
| `websocket_port` | `8765` | 后端 RPC，**仅 127.0.0.1** |

MT5700M-CN 常见串口角色：`ttyUSB0` Application，**`ttyUSB1` PCUI**，`ttyUSB2+` 其它。

---

## 7. 云编译（与本文档等价的自动化路径）

```text
push main / tag v* / 手动
        │
        ▼
openwrt/sdk 容器 × 4 矩阵
  (x86_64|aarch64) × (main apk | 23.05.5 ipk)
        │
        ▼
scripts/sdk-build.sh
  下载 SDK → rustup + zig → make package/luci-app-mt5700
  校验安装树 / 包体积 >500KB
        │
        ▼
Artifacts + 自动 GitHub Release（tag = v* 或 Makefile PKG_VERSION）
```

手动下载：Actions 运行页 → Artifacts，或 [Releases](https://github.com/LianXia233/luci-app-mt5700/releases)。

---

## 8. 常见问题

| 现象 | 处理 |
|:--|:--|
| `apk add` 提示依赖 `at-webserver-rust` | 使用 v1.1.0+ 单包；或 `PKG_PROVIDES` 已覆盖 |
| 包只有几十 KB、无后端 | 确认 `src/` 被拷入包目录且 `make package/luci-app-mt5700/compile` 成功 |
| aarch64 链接报 `unsupported linker arg: --fix-cortex-a53` | 在 zig wrapper 中丢弃该旗标（见 §1 注） |
| 串口打不开 | 确认设备节点权限、`kmod-usb-serial`、PCUI 口是否为 ttyUSB1 |
| LuCI 无菜单 | 安装 `luci-i18n-mt5700-zh-cn`；刷新浏览器缓存；检查 `menu.d` |
| rpcd 无 `mt5700` 对象 | 重启 rpcd：`/etc/init.d/rpcd restart` |

---

相关文档：[功能映射](01-原WebUI功能清单与LuCI映射表.md) · [验收报告](03-最终验收报告.md) · [CHANGELOG](../CHANGELOG.md)
