# debian-v1.32.13 — Debian 独立版全量同步 main 1.32.13

**发布日期**：2026-11-24
**类型**：同步 + 重新移植
**基线**：main v1.32.13

## 变更

- Debian 分支代码树先直接同步到 main 1.32.13（含看板娘修复、i18n、CI、供应链、素材声明）。
- 重新移植 Debian 运行层：
  - `configstore.rs`：`/etc/mt5700/config.json` 扁平 JSON 配置。
  - `httpserver.rs`：`0.0.0.0:9000` HTTP API + `/ws` + 静态 WebUI。
  - `main.rs`：HTTP 服务与 RPC 兼容通道并行，systemd 优雅退出。
  - 无 uci 适配：时区、usage 网卡、QQ 绑定、短信存储区、上行钩子。
- 前端整包同步：`htdocs` → `webui`，loader 预加载 15 个模块，shim 支持 i18n/HTTP 配置映射。
- 打包：`debian/sync-webui.sh`、`tests/debian-webui-test.js`、CI 门禁、`SHA256SUMS`、
  `/usr/bin/at-webserver-rust` 兼容链接。

## 验证

- `cargo test --locked`：393 passed，2 ignored
- `cargo clippy --all-targets -- -D warnings`：通过
- `tests/debian-webui-test.js`：通过
- WSL + mock 模组 + 无头 Chrome：12 个视图全部加载，英雄栏看板娘渲染 320×320（显示 54×54），
  `/api/at`、`/api/events`、`/api/config`、`/api/logs` 正常。
- `debian/build-deb.sh` 生成 amd64/arm64 deb，包内含 WebUI、systemd unit 与配置样例。

## 安装

```bash
sudo apt install ./at-webserver_1.32.13-1_<arch>.deb
systemctl status at-webserver
# 浏览器访问 http://<设备IP>:9000
```
