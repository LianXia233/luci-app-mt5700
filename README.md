# luci-app-mt5700

移远 MT5700M 5G 模组的 OpenWrt LuCI 管理插件。插件包含 LuCI 前端和 Rust
后端，安装一个软件包即可使用。

## 功能

插件入口：**移动网络 → 5G 模组管理**。

- 网络状态、网络设置和拨号
- 全网扫频、定时锁频
- 模组参数设置和固件升级
- 短信、USSD、来电和通知
- AT 调试终端
- 服务状态和配置管理

后端默认通过 PCUI 串口连接模组（通常为 `/dev/ttyUSB1`），也支持 TCP 连接。

## 安装

从 [Releases](https://github.com/LianXia233/luci-app-mt5700/releases) 下载与设备架构
匹配的 `luci-app-mt5700` 主包和对应的中文语言包。

### OpenWrt 24.10 及更新版本

```sh
apk add --allow-untrusted ./<arch>-luci-app-mt5700-<version>.apk
apk add --allow-untrusted ./<arch>-luci-i18n-mt5700-zh-cn-*.apk
```

### OpenWrt 23.05

```sh
opkg install ./<arch>-luci-app-mt5700_<version>_<arch>.ipk
opkg install ./<arch>-luci-i18n-mt5700-zh-cn_*.ipk
```

安装后在 LuCI 中打开「服务配置」，确认服务已启用并选择正确的连接方式，
然后点击「保存并应用」。

也可以使用命令行：

```sh
uci set at-webserver.config.enabled='1'
uci set at-webserver.config.connection_type='SERIAL'
uci set at-webserver.config.serial_port='auto'
uci commit at-webserver
/etc/init.d/at-webserver restart
```

主包已包含 `/usr/bin/at-webserver-rust`，不需要另行安装后端包。

## 配置

配置文件为 `/etc/config/at-webserver`，默认配置见
[`root/etc/config/at-webserver`](root/etc/config/at-webserver)。

常用选项：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `1` | 是否启用服务 |
| `connection_type` | `SERIAL` | `SERIAL` 使用串口，`NETWORK` 使用 TCP |
| `serial_port` | `auto` | 自动探测 AT 串口，也可填写设备路径 |
| `serial_baudrate` | `115200` | 串口波特率 |
| `network_host` | `192.168.8.1` | TCP 模组地址 |
| `network_port` | `20249` | TCP 模组端口 |
| `autodial_enable` | `1` | 是否启用自动拨号 |
| `autodial_mode` | `1` | `1` 为 USB 网络接口，`2` 为转网口模式 |
| `websocket_port` | `8765` | 本地 RPC 端口 |
| `websocket_auth_key` | 空 | RPC 密钥；留空则不校验 |

修改配置后执行：

```sh
uci commit at-webserver
/etc/init.d/at-webserver restart
```

## 工作方式

```text
LuCI 页面
   │ rpcd / ucode
   ▼
mt5700.uc
   │ 本地 TCP newline-JSON
   ▼
at-webserver-rust
   │
   ├─ PCUI 串口（默认 /dev/ttyUSB1）
   └─ TCP 模组（默认 192.168.8.1:20249）
```

后端仅监听回环地址，LuCI 请求通过 rpcd 和 ACL 转发。服务由
`/etc/init.d/at-webserver` 使用 procd 管理。

## 开发与测试

### Rust 后端

```sh
cd src/rust
cargo test
cargo build --release
```

### 无硬件测试

```sh
cd tests/mock-modem
npm install
sh run-e2e.sh
node parse-extra-test.js
node temp-level-test.js
```

### JavaScript 语法检查

```sh
find htdocs -name '*.js' -exec node --check {} \;
```

完整的 OpenWrt 交叉编译由
[`.github/workflows/build-openwrt.yml`](.github/workflows/build-openwrt.yml) 执行。
工作流会构建 apk 和 ipk，并在构建成功后发布 Release。

## 项目结构

```text
htdocs/                         LuCI 页面、公共 JS 和 CSS
po/                             翻译文件
root/etc/config/                UCI 默认配置
root/etc/init.d/                procd 服务脚本
root/usr/share/rpcd/            rpcd ACL 和 ucode 接口
src/rust/                       Rust 后端
tests/mock-modem/               模拟模组测试
```

## 许可

[MIT License](LICENSE)
