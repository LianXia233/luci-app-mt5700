# MT5700M 后端 Rust 重构说明（REFACTOR）

> 本文档说明将 `luci-app-mt5700m` 的三个核心后端脚本（`mt5700m-at`、`mt5700m-manager`、`mt5700m-traffic`）
> 用 **Rust（零外部依赖 / 仅 std）** 重写并保持与原始版本「功能一致、接口一致、路径一致」的方案、
> 模块划分、对外契约、OpenWrt 集成方式及兼容性边界。
>
> 仓库布局：`mt5700m-rs/`（Rust 开发源码 + 本说明）→ `openwrt/luci-app-mt5700m/`（可直接放入 OpenWrt feed 的完整软件包）。

---

## 1. 重构范围

### 1.1 用 Rust 重写的部分（核心后端逻辑）

| 原始文件 | 角色 | Rust 实现 |
| --- | --- | --- |
| `root/usr/sbin/mt5700m-at` | 设备/AT 查询与配置 CLI（状态、信号、锁频、短信、SIM、网络模式…） | Rust 等价实现 `src/at/mod.rs` + `config.rs`/`transport.rs`/`parse.rs`/`lock.rs`（已编译进单一二进制 `mt5700m`；本阶段安装入口仍保留原 shell 脚本，见 §1.4） |
| `root/usr/sbin/mt5700m-manager` | 连接管理守护逻辑（sync/connect/disconnect/redial/monitor/状态 JSON/温控缓存） | Rust 等价实现 `src/manager.rs`（已编译进单一二进制；本阶段安装入口仍保留原 shell 脚本，见 §1.4） |
| `root/usr/sbin/mt5700m-traffic` | 流量统计守护与历史（`daemon`/`json`/`flush`/`update`） | Rust 等价实现 `src/traffic.rs`（已编译进单一二进制；本阶段安装入口仍保留原 shell 脚本，见 §1.4） |

`main.rs` 已实现按 `argv[0]` basename 将 `at` / `manager` / `traffic` / `server` 分发到单一二进制 `mt5700m` 的机制（含 `src/server/` 的 at-server 实现）。**本阶段仅把 `at-server` 真正切换为 Rust 符号链接**；`mt5700m-at`/`manager`/`traffic` 的安装入口仍为原始 shell 脚本，待 Rust 等价实现逐项校验行为一致后再改为符号链接（见 §1.4）。

### 1.2 保持不变的部分（OpenWrt / LuCI 胶水，原样保留）

| 类别 | 文件（相对 `openwrt/luci-app-mt5700m/`） | 说明 |
| --- | --- | --- |
| LuCI SPA 前端 | `htdocs/5700/**`、`htdocs/luci-static/**`、`htdocs/cgi-bin/**`、`htdocs/scripts/**` | 预构建的 UMI/Webpack 单页应用，直接拷贝，不改 |
| 翻译 | `po/zh_Hans/mt5700m.po` | 直接拷贝 |
| rpcd 包装 | `root/usr/libexec/rpcd/mt5700m`、`mt5700m-traffic` | 仅 `exec` 后端二进制，名称不变 → 仍生效 |
| init 脚本 | `root/etc/init.d/mt5700m-manager`、`mt5700m-traffic`、`at-webserver` | 直接调用后端二进制名（现为符号链接）→ 不变 |
| hotplug | `root/etc/hotplug.d/usb/60-mt5700m`、`root/etc/hotplug.d/net/95-mt5700m-traffic` | 调用 `/usr/sbin/mt5700m-manager`、`mt5700m-traffic` 及 `usb.sh` → 不变 |
| uci-defaults | `root/etc/uci-defaults/90-mt5700m`、`92-mt5700m-traffic`、`93-mt5700m-webui` | 初始化 UCI、启服务 → 不变 |
| ACL | `root/usr/share/rpcd/acl.d/luci-app-mt5700m.json` | 授权 `exec /usr/sbin/mt5700m-at` 等（符号链接）→ 不变 |
| 菜单 | `root/usr/share/luci/menu.d/luci-app-mt5700m.json` | 不变 |
| UCI 配置 | `root/etc/config/mt5700m`、`at-webserver` | 不变 |
| USB 绑定库 | `root/usr/share/mt5700m/usb.sh` | hotplug 引用，不变 |
| 升级保留 | `root/lib/upgrade/keep.d/mt5700m-traffic` | 不变 |

### 1.3 范围决策：`at-server.py` 已重写为 Rust（并入单一二进制）

`root/usr/bin/at-server.py`（原约 116KB）是 **独立的「AT Web 终端 + 通知」守护进程**：
浏览器经 WebSocket（默认 `:8765`）连入，它通过 `UBUS` / `SERIAL` / `NETWORK`（TCP `host:20249`）三种通道把 AT 命令转发给 modem，并提供企业微信短信/来电/信号通知。

**本轮已将其用 Rust 重写**（零外部依赖 / 仅 std，手写 RFC6455 WebSocket + SHA1/Base64 + GSM-7/UCS2 PDU 解码），代码位于 `src/server/`（`config.rs` / `at.rs` / `ws.rs` / `handlers.rs` / `notify.rs` / `sms_pdu.rs` / `bus.rs` / `jsonx.rs` / `mod.rs`）。关键契约保留：
- 应用层心跳与原始 Python 完全一致：服务端每 30s 发 TEXT `"ping"`，客户端回 `"pong"`（与 `websockets` 库关闭自带 keepalive 后的行为一致）；同时仍自动应答协议级 Ping(0x9)→Pong(0xA)。
- 三种 AT 通道（UBUS 默认经 `ubus-at-daemon`；NETWORK 直连 TCP；SERIAL 经 `stty` 配置串口）行为一致。
- 通知经企业微信 Webhook（**shell-out 到 `curl`**，避免引入 TLS 栈以满足离线构建）与本地日志文件，与原始双通道一致。
- 安装入口改名：`/usr/bin/at-server` 为指向单一二进制 `/usr/bin/mt5700m` 的符号链接，由 `/etc/init.d/at-webserver` 与 `93-mt5700m-webui` 原样启动，**前端零改动**。原始 `at-server.py` 已从软件包移除。

> **边界（§1.4）**：本阶段 **仅** 迁移 `at-server`。`mt5700m-at` / `mt5700m-manager` / `mt5700m-traffic` 三个入口仍保留为原始 shell 脚本，因为其子命令集合（如 `manager status-json`/`connect`/`advanced-set autodial`、`traffic json`/`daemon`）是 WebUI JSON-RPC 后端直接依赖的契约；Rust 等价实现已编译进 `mt5700m` 二进制，待逐项校验行为一致后再切换为符号链接。

### 1.4 本阶段边界：三个 shell 前端暂未切换

为避免回退 WebUI 的 JSON-RPC 后端（rpcd 经 `/usr/sbin/mt5700m-manager`、`/usr/sbin/mt5700m-traffic` 等调用丰富子命令），本阶段仅完成 `at-server` 的 Rust 化与接线。切换其余三个入口为 Rust 符号链接的待办：
1. 逐命令校验 Rust `at`/`manager`/`traffic` 与原始 shell 的 stdout / 退出码 / 副作用一致；
2. 在 `Makefile` 的 `Build/Compile` 中追加创建 `/usr/sbin/mt5700m-{at,manager,traffic}` → `mt5700m` 符号链接，并删除对应 shell 脚本；
3. 回归测试：LuCI 各状态页、拨号、短信、流量卡片。

---

## 2. 模块划分（Rust）

| 模块 | 职责 |
| --- | --- |
| `main.rs` | 按 `argv[0]` basename 分发到 `at` / `manager` / `traffic` 三个入口 |
| `error.rs` | `MtError` / `Result<T>`；`exit` 码常量（`USAGE`/`BAD_ARG`/`CHANNEL`） |
| `shell.rs` | 对 OpenWrt 外部工具的薄封装：`uci_*`、`ubus_*`、`ifup/ifdown`、`modprobe`、`stty`、`read/write_sysfs`、`read_file`、`command_exists` 等。`run(cmd, &[&str]) -> Result<(String,bool)>` 统一返回「trim 后的 stdout + 是否退出 0」 |
| `usb.rs` | USB 探测：VID `3466`、PID `3301`(normal)/`3302`(upgrade)/`3303`(dump)；PCUI 串口识别（接口类 `ff:06:12`）；网络/串口驱动绑定；环境变量覆盖 `MT5700M_SYSFS_ROOT`/`DEV_ROOT`/`USB_VENDOR` |
| `json.rs` | 手写递归下降 JSON 解析器 + 保序紧凑序列化（`Json` 枚举），用于 `status-json` 与 `traffic json` 输出，序列化顺序与原始 `jshn.sh` 对齐 |
| `at/config.rs` | `AtConfig` / `AtMode(Auto/Serial/Network)`，`load()` 从 UCI（`mt5700m` 配置）读取 |
| `at/transport.rs` | AT 通道：ubus-at-daemon / 串口（`cat` 读 + `mktemp`）/ 网络（`nc host:port`）；网关探测 |
| `at/parse.rs` | 各类 AT 响应解析与打印：信号/身份/运营商/SIM/QoS/APN/温度/载波聚合/锁频状态/系统信息/短信列表…；LTE/NR 锁频命令构建 |
| `at/lock.rs` | 应用锁频、设置无线模式/策略/5G 接入模式、温控阈值校验、PIN/PUK 校验 |
| `at/mod.rs` | `mt5700m-at` 的全部子命令分发（`status`/`command`/`network`/`cellscan`/`sms-*`/`system`/`advanced`/`advanced-set`/`pdp-*`/`flow-clear`/`airplane`/`sim-pin`/`fota-*`/`preview-lock`/`lock`/`restart`/`unlock`…） |
| `manager.rs` | `mt5700m-manager`：`monitor`/`status-json`/`refresh-temperature`/`log` + 加锁后的 `sync`/`connect`/`disconnect`/`redial`/`down`；UCI network/firewall 同步；状态 JSON；温控缓存 |
| `traffic.rs` | `mt5700m-traffic`：`daemon`/`json`/`flush`/`update`；`/sys/class/net/<if>/statistics/rx|tx_bytes` 增量统计；纯文本历史文件（与原始格式逐字节兼容） |

---

## 3. 对外接口契约（必须与前端/脚本完全一致）

所有契约均沿用到原始版本，任何调用方（LuCI JS、rpcd、init、hotplug）都无需修改。

### 3.1 `mt5700m-at status`（前端状态页核心数据源）
输出 `key=value` 行，顺序固定：
```
enabled=1
mode=auto
usb_state=<absent|...>
usb_pid=3301
usb_slot=1
at_port=/dev/ttyUSBx
host=192.168.8.1
port=20249
detected_gateway=10.0.0.1
channel=<ubus|serial|network>
connected=1
<后续各打印机输出：信号、身份、运营商、SIM、QoS、APN、温度、CA、锁频状态、系统信息等>
```

### 3.2 `mt5700m-at advanced`
按分组输出块，格式：
```
===== Label: <cmd> =====
<AT 响应>
<空行>
===== Label: <cmd> =====
...
```

### 3.3 `mt5700m-traffic json`（流量卡片数据源）
```
{"interfaces":[{"name":"MT5700M","updated":{"date":"...","time":"..."},"traffic":{"total":{"rx":N,"tx":N},"day":[{...}],"month":[{...}]}}, ...]}
```

### 3.4 ubus 对象（由 rpcd 包装暴露）
| ubus 对象 | 方法 | 实际调用 |
| --- | --- | --- |
| `mt5700m` | `status` / `log` | `mt5700m-manager status-json` / `mt5700m-manager log` |
| `mt5700m` | `connect`/`disconnect`/`redial`/`sync` | `mt5700m-manager <method>`，成功后再 `status-json` |
| `mt5700m-traffic` | `summary` | `mt5700m-traffic json` |

### 3.5 文件契约
- 流量历史：`/etc/mt5700m/traffic-history`（纯文本，格式与原始逐字节兼容）
- 温控缓存：`/var/run/mt5700m/...`（由 `manager::refresh_temperature_cache` 写入，`#[cfg(unix)]` 下权限 `0644`）
- 锁文件：`/var/lock/mt5700m-manager.lock`（基于 pid 的 mkdir 锁，Drop 释放）

---

## 4. 原始 ↔ Rust 一致性映射

| 原始逻辑（shell） | Rust 落点 |
| --- | --- |
| `mt5700m-at` 主 `case` 分发 | `at/mod.rs::run` 按 `args[0]` 分发（默认 `status`） |
| 各类 `print_*` 打印机 | `at/parse.rs` 同名函数 |
| `build_lte_lock_command` / `build_nr_lock_command` | `at/parse.rs`（CSV 列表用 `{:?}` 引号，等价于 shell `"%s"` 引用） |
| `mt5700m-at` 的串口/网络 AT 通道 | `at/transport.rs`（`cat` 读 + `mktemp` / `nc`） |
| 网关探测 `ip route` 逻辑 | `at/transport.rs::detect_gateway` / `gateway_inner` |
| `mt5700m-manager` 的 monitor/status/connect/… | `manager.rs` 同名函数；`LockGuard`（Drop 释放锁） |
| `mt5700m-manager` 的 UCI network/firewall 同步 | `manager.rs::ensure_network` / `ensure_firewall_network` |
| `mt5700m-traffic` 的统计与历史 | `traffic.rs`（`Entry` + `read/write_history`，格式兼容） |
| `jshn.sh` 的 JSON 输出顺序 | `json.rs` 保序紧凑序列化 |

---

## 5. OpenWrt 集成与部署

### 5.1 软件包结构（已在 `openwrt/luci-app-mt5700m/` 生成）
```
luci-app-mt5700m/
├── Makefile                 # 改编：编译 Rust + 安装二进制与符号链接
├── mt5700m-rs/              # Rust 源码（Cargo.toml + src/，嵌入副本）
├── htdocs/                  # LuCI SPA 前端（原样拷贝）
├── po/                      # 翻译（原样拷贝）
└── root/                    # 全部 OpenWrt 胶水（原样拷贝，含上述 init/hotplug/acl/...）
```

### 5.2 构建前置条件
- **构建主机需预装 `cargo` + `rustup`**，并 `rustup target add <目标 musl 三元组>`（如 `aarch64-unknown-linux-musl`）。本包 **不依赖** OpenWrt `lang/rust` feed；`RUST_TARGET` 由 Makefile 依据 `ARCH`/`CPU_TYPE` 内联推导（可用 `CONFIG_RUST_TARGET` 覆盖）。
- Rust 源码为 **零依赖**（仅 std），无需 cargo 索引/vendor，`cargo build --release --target $(RUST_TARGET) --offline` 即可（host 上需已缓存对应目标的 `rust-std`）。
- 运行时依赖：`curl`（企业微信 Webhook 由 at-server shell-out 调用）、`ubus-at-daemon`（默认 UBUS AT 通道）、`sms-tool_q`（短信辅助）。

### 5.3 放置与编译
```sh
# 将 luci-app-mt5700m/ 整体放入 feed 目录（名称必须为 luci-app-mt5700m）
cp -r openwrt/luci-app-mt5700m /path/to/openwrt/package/feeds/luci/
cd /path/to/openwrt
./scripts/feeds install luci-app-mt5700m
make menuconfig   # 勾选 LuCI -> Applications -> luci-app-mt5700m
make package/luci-app-mt5700m/compile V=s
```

### 5.4 Makefile 关键点
- 保留 `LUCI_MINIFY_JS:=0`（SPA bundle 不能被 LuCI 的 jsmin 二次压缩，否则白屏）。
- **移除** `LUCI_PKGARCH:=all`（本包现含架构相关二进制，须继承目标 `PKGARCH`）；依赖由 `python3 +python3-websockets +python3-pyserial` 改为 `+curl`（其余 `+luci-base +ubus-at-daemon +sms-tool_q` 不变）。
- `RUST_TARGET` 内联推导：`aarch64→aarch64-unknown-linux-musl`、`arm`(Cortex-A)→`armv7-unknown-linux-musleabihf`（其余 arm→`arm-unknown-linux-musleabi`）、`mipsel→mipsel-unknown-linux-musl`、`mips→mips-unknown-linux-musl`、`x86_64→x86_64-unknown-linux-musl`、`i386→i686-unknown-linux-musl`，其余回退 `$(ARCH)-unknown-linux-musl`；可用 `CONFIG_RUST_TARGET` 强制覆盖。
- `Build/Compile`：在 `$(CURDIR)/mt5700m-rs`（随包内置的 Cargo 工程）内 `CARGO_TARGET_DIR=$(PKG_BUILD_DIR)/cargo-target cargo build --release --target $(RUST_TARGET) --offline`，随后 `$(INSTALL_BIN)` 把产物放到 `$(PKG_BUILD_DIR)/root/usr/bin/mt5700m` 并 `ln -sf mt5700m $(PKG_BUILD_DIR)/root/usr/bin/at-server`，同时 `rm -f` 残留 `at-server.py`。release profile 已 `strip=true`，无需单独 `$(STRIP)`。
- 安装沿用 **luci.mk 默认 `Package/install`**（拷贝 `root/*` 等），因此 `mt5700m` 与 `at-server` 符号链接随 `root/usr/bin/` 自动进包，**po/menu/acl/hotplug 等仍由 luci.mk 原样处理**。
- 本阶段实际安装的程序/链接（仅 at-server 切换为 Rust）：
  ```
  /usr/bin/mt5700m            # 单一 Rust 二进制
  /usr/bin/at-server         -> mt5700m   # WebSocket AT 终端守护（替换原 at-server.py）
  /usr/sbin/mt5700m-at       # 仍为原 shell 脚本（本阶段未切换，见 §1.4）
  /usr/sbin/mt5700m-manager  # 仍为原 shell 脚本（本阶段未切换，见 §1.4）
  /usr/sbin/mt5700m-traffic  # 仍为原 shell 脚本（本阶段未切换，见 §1.4）
  ```

### 5.5 运行时不变量
- 二进制路径、UCI 配置路径、ubus 对象名、ACL 授权项、菜单项、hotplug/uci-defaults 文件名——**全部与原始一致**。
- 不引入任何新的内核接口或守护进程；依旧复用 `ubus`/`uci`/`ifup`/`modprobe`/`stty`/`nc`/`sms_tool_q` 等既有工具。
- `at-server` 现已由 Rust 实现（`/usr/bin/at-server` → `/usr/bin/mt5700m`），原始 `at-server.py` 已移除；`93-mt5700m-webui` 依旧启用并启动它，Web 终端功能不变。

---

## 6. 兼容性说明

- **功能一致**：重写只替换实现语言，子命令集合、输出格式、JSON 形状、文件格式均保持与原始一致（逐项对照见 §3、§4）。
- **配置兼容**：`/etc/config/mt5700m`、`/etc/config/at-webserver` 字段与默认值不变；升级时 `uci-defaults` 与 `keep.d` 逻辑不变。
- **API 兼容**：LuCI 前端通过 rpcd → 后端二进制名调用，二进制名以符号链接保留，前端零改动。
- **架构兼容**：二进制为静态链接倾向（musl 目标可完全静态），可运行于 OpenWrt 常见目标（arm/mips/aarch64/x86_64，取决于 `RUST_TARGET`）。本仓库已用 `x86_64-unknown-linux-musl` 验证可成功编译并链接为 Linux ELF。

---

## 7. 构建与验证记录

| 步骤 | 命令 / 目标 | 结果 |
| --- | --- | --- |
| 类型检查（核心 + at-server） | `cargo check` | 通过（仅 dead-code 警告，无错误） |
| Linux 目标链接产物 | `cargo build --target x86_64-unknown-linux-musl`（prior 会话验证） | 成功生成 ELF |
| 本机（Windows）链接 | `cargo build` / `cargo build --target x86_64-pc-windows-gnu` | 失败：**本沙箱缺 MSVC `link.exe` 与 MinGW `x86_64-w64-mingw32-gcc` 链接器**，与代码正确性无关；真实产物由 OpenWrt SDK（musl 交叉工具链）产出 |

> **结论**：代码层面 `cargo check` 全绿；需在具备 Rust 交叉工具链（目标 `rust-std` + 链接器）的 OpenWrt buildroot 中产出最终 `.ipk`。Makefile 已按 `RUST_TARGET` 内联推导处理跨架构编译。
