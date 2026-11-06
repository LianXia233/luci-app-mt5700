# luci-app-mt5700 双 UI 模式重构：真实源码清单

> 本文是 `feature/dual-ui-mode` 分支开发前对 **main@ebba6e0** 的完整源码审查结果，
> 作为改造范围与最终验收的依据。所有文件、函数、接口、配置项均来自实际源码，
> 未做任何假设。

## 1. 仓库基本事实

| 项 | 实际值 |
| --- | --- |
| 默认分支 | `main`（GitHub API + `ls-remote --symref` 双重确认） |
| 基线 HEAD | `ebba6e04c71ab8e1db2af0ff7dc5101d303f3f15` |
| 远程分支 | `main` / `Debian` / `fix/traffic-stats-interface-selection`（目标分支原本不存在，API 404） |
| 受版本控制文件 | 199 个 |
| 行尾 | `.gitattributes` 声明 `* text=auto eol=lf`，全部文本文件强制 LF |
| 版本 | `Makefile PKG_VERSION=1.30.12`、`compat.js MT5700_UI_VERSION=1.30.12` |
| 测试 | `node tests/<name>-test.js`，纯 Node 零依赖脚本，不接入 CI |

## 2. 目录组织（真实）

```
Makefile / src/Makefile / src/rust/*         Rust 后端（AT 队列、SMS、PDU、拨号…）
root/etc/config/at-webserver                 UCI 配置（单节 config at-webserver 'config'）
root/etc/init.d/at-webserver                 服务/拨号/USB 接口管理
root/etc/uci-defaults/at-webserver           首次安装初始化
root/etc/hotplug.d/{iface,usb}/99-*         热插拔
root/usr/share/rpcd/ucode/mt5700.uc         Ucode RPC 插件（11 个方法）
root/usr/share/rpcd/acl.d/luci-app-mt5700.json  ACL
root/usr/share/luci/menu.d/luci-app-mt5700.json 菜单/路由
htdocs/luci-static/resources/at-webserver/   公共 JS + 3 张 CSS + 图片/webp 资源
htdocs/luci-static/resources/view/at-webserver/ 12 个视图
tests/                                      零依赖 Node 单测与 mock-modem
scripts/sdk-build.sh / qq-capture-openid.py 构建与工具
docs/                                       文档、发布说明、布局测试
po/                                         i18n
```

## 3. 视图与路由（menu.d，`admin/modem/5g/*`）

| 路由 | 标题 | view 文件 | order |
| --- | --- | --- | --- |
| status | 网络状态 | `network_status.js` | 10 |
| settings | 网络设置 | `network_settings.js` | 20 |
| dial | 拨号设置 | `dial.js` | 30 |
| scan | 全网扫频 | `scan.js` | 40 |
| schedule | 定时锁频 | `schedule.js` | 50 |
| modem-settings | 模组设置 | `modem_settings.js` | 60 |
| upgrade | 模组升级 | `upgrade.js` | 70 |
| sms | 短信中心 | `sms_center.js` | 80 |
| sms-settings | 短信设置 | `sms_settings.js` | 90 |
| terminal | AT 调试终端 | `terminal.js` | 100 |
| logs | 运行日志 | `logs.js` | 110 |
| config | 服务配置 | `service.js` | 120 |

**12 个视图全部 `require at-webserver/mt5700`**（`tests/global-css-test.js` 强制校验）；
11 个还 `require at-webserver/ui`，`service.js` 亦已引入 `ui`（`Ui.startup`）。
`mt5700.js` 是唯一的全局样式注入点，因此「全局」能力必须挂在这里。

## 4. 公共模块（真实职责）

| 文件 | 职责 | 注入/导出 |
| --- | --- | --- |
| `compat.js` | `String.prototype.format` 垫片；把 `mt5700-<版本>` 并入 `L.env.resource_version` | `window.AtCompat` |
| `theme.js` | LuCI 明暗主题判定（Aurora/Argon/官方），写 `<html class="at-dark|at-light" data-at-theme>`；`injectCss()` 幂等 | `window.AtTheme` |
| `tabmenu.js` | 12 页签图标增强（`TAB_ICONS`，24×24 线性 SVG，stroke 1.8）+ 滚动位置保持 + Tab 对比度兜底 | `window.AtTabmenu` |
| `rpc.js` | ATClient 单例、连接状态机、事件轮询、SMS/AT/usage/logs 等 RPC 封装、`AtUci`（uciSave/uciHasChanges） | `window.AtWs` |
| `parse.js` | AT 响应解析（SMS PDU、信号、FOTA、邻区、PDP 等） | `window.Parse` |
| `ui.js` | `promptModal`、`switch`、`autoRefresh`、`startup`、`degradedNotice`、`interval`/`onLeave`（hashchange 生命周期清理）、`sendCmd` | `window.Ui`；注入 `at.css?v=1.15.1` |
| `mt5700.js` | 页面骨架 `page()`、卡片/指标/按钮/表格/表单/暂存条、`confirm`/toast/loading/empty、信号/星座图/MIMO SVG、全局背景 | `window.Mt5700`；注入 `mt5700.css?v=2.46.4` 与 `global.css?v=1.0.0` |

**CSS 三层（AGENTS.md 明确归属）**：

| 文件 | 注入方 | 定位 |
| --- | --- | --- |
| `mt5700.css`（5975 行） | `mt5700.js` | 插件主样式；含 `!important` 的全局弹窗/输入框覆盖段 |
| `at.css`（152 行） | `ui.js` | 公共组件库（按钮/字段/卡片）+ `.at-modal` 弹窗 |
| `global.css`（191 行） | `mt5700.js` | 全局弹窗文字可读性 + `.mt5700-float-notice` 后端未就绪提示条 |

## 5. Ucode 后端与 ACL

`root/usr/share/rpcd/ucode/mt5700.uc` 注册 **11 个 RPC 方法**：
`at`、`sms`、`events`、`notify_test`、`qq_bind_status`、`qq_menu`、`netrate`、`usage`、`usage_ctl`、`usb`、`logs`。
经 `nc 127.0.0.1 <port>` 与 Rust 后端通信，方法名/参数属于**严格禁止修改**范围。

`root/usr/share/rpcd/acl.d/luci-app-mt5700.json`：
- read：`uci: ["at-webserver","network"]`、`ubus` 各对象、`file` 若干路径；
- write：`uci: ["at-webserver"]`、`ubus.uci: add/set/delete/commit/apply/changes/revert/order`。

> **`ui_mode` 落在 `at-webserver` 包内，read/write 权限已具备，因此不需要改 ACL、
> 不需要新增 ubus 方法、不需要新增后端服务。**

## 6. UCI 配置定义与读写机制

- 配置节：`config at-webserver 'config'`，约 90+ 个 `option`（`wallpaper_enabled`、`enabled`、`autodial_*`、`notify_*`、`schedule_*`、`qq_*` 等）。
- 读取：`L.uci.load('at-webserver')` → `L.uci.get('at-webserver','config',<key>)`；
  见 `service.js:158/225/1141`、`logs.js:207`、`dial.js:655`、`mt5700.js:85`。
- 写入：暂存式 `staged.set()`（`mt5700.js:923`）→ `L.uci.set(...)` → `AtWs.uci.uciSave('at-webserver')`；
  `uciSave` = `L.uci.save(section)` + `L.uci.apply(false, true)`（`rpc.js:778`）。
- **本次 `ui_mode` 只用 `L.uci.set` + `L.uci.save`（commit），不调用 `apply()`**：
  避免触发网络配置重新应用/服务重启。

## 7. 前端初始化与轮询（真实）

| 位置 | 机制 |
| --- | --- |
| `compat.js` | 模块求值即安装 format 垫片与资源版本戳 |
| `theme.js` | 模块求值即 `apply()` 写 `<html>` 明暗类；DOMContentLoaded 后 MutationObserver + matchMedia 跟随 |
| `mt5700.js` | 注入 3 张 CSS；`startGlobalBg()` 读 `wallpaper_enabled` 后挂载角色立绘层 |
| `tabmenu.js` | `api.init()` 轮询/MutationObserver 等待 `#tabmenu` 渲染后增强 |
| `ui.js` | `Ui.startup(body, onReady)`：先注册连接状态监听，再 `AtWs.client.connect()`；`Ui.interval` 在 hashchange 时自动 clear |
| `rpc.js:364` | ATClient 事件轮询 `setInterval(pollEvents, pollInterval)` |
| `network_status.js` | `Ui.interval(1000, sampleRate)` / `(1000, sampleUsage)` / `(5000, 刷新)` |
| `scan.js / schedule.js / logs.js / sms_center.js / upgrade.js` | 各自 `Ui.interval` 或 `setInterval`（2s / 15s / 自动刷新 / 1s ticker / 1s 计时） |

> **模式切换不得重建上述任何定时器**；本次实现只改 `<html>` 属性 + 重绘图标 + CSS 命中。

## 8. 全部弹窗类型清单（真实定义与调用）

| # | 类型 | 定义 | DOM 结构 | 调用点（示例） |
| --- | --- | --- | --- | --- |
| 1 | 确认/警告/错误/结果确认弹窗 | `mt5700.js:622 api.confirm(message,onOk,okText)` | `.mt5700-modal-mask > .mt5700-modal`，取消/确定 + 掩码点击关闭 + 异步 `onOk` | `upgrade.js:129/462`（免责声明、确认升级，内嵌 DOM 标题）、`terminal.js:179`、`sms_settings.js:159/209`、`scan.js:172/224`、`logs.js:860`、`dial.js:567/592`、`modem_settings.js:235/261/264/283/381/596/1040/1066`（IMEI 5 步确认、PIN、SIM 切换、重启）、`service.js:1475`、`mt5700.js:970`（staged 放弃更改） |
| 2 | 输入弹窗（含 select/password/hint） | `ui.js:81 api.promptModal(title,fields,onOk)` | `.at-modal-mask > .at-modal.at-modal-wide`，`at-modal-title/body/actions` | `terminal.js:187`（保存 AT 命令）、`sms_center.js:186`（新短信，追加 `.mt5700-sms-prompt`）、`dial.js:850`（新增/编辑 PDP 上下文）、`modem_settings.js:361`（PIN 操作） |
| 3 | 短信中心自绘弹窗 | `sms_center.js:1158 smsModal(title)` | `.mt5700-modal-mask.mt5700-sms-modal-mask > .mt5700-modal.mt5700-sms-modal`，返回 `{box,close}` | 归档详情 `1180/1225`、本地归档列表 `1225`、确认删除 `1301 confirmDeleteModal`、批量删除 `1388`；内含 `Mt5700.confirm` 二次确认 `1264/1280` |
| 4 | 成功/警告/错误/信息 Snackbar | `mt5700.js:648 api.toast` + `success/error/warning/info` | `.mt5700-toast .mt5700-toast-<type>`，3s 隐藏 3.5s 移除 | 12 个视图共约 150+ 处 |
| 5 | 加载态 | `mt5700.js:663 api.loading(text)` | `.mt5700-loading` + 旋转 SVG spinner | `upgrade.js:65`、`schedule.js:586` |
| 6 | 空态 | `mt5700.js:692 api.empty(text)` | `.mt5700-empty` | `api.table` 无数据、各列表 |
| 7 | 后端未就绪提示条 | `ui.js:197 api.degradedNotice(body,onReady)` | `.alert-message.warning.mt5700-float-notice` + 关闭按钮 | `Ui.startup` `296/307` |
| 8 | LuCI 原生/主题弹窗 | LuCI 框架 | `.cbi-modal` / `.modal` / `.modal-dialog` | `global.css:32-35` 明确覆盖四套结构 |

> 弹窗业务逻辑（确认/取消、异步回调、错误处理、生命周期、参数）**全部保留**；
> 本次仅在 `Mt5700.confirm` / `toast` / `loading` / `empty` 创建后调用
> `AtUimode.decorate()` 打模式标记，其余零改动。

## 9. SVG / 图标 / 动画 / 主题资源清单（真实）

**改造前仓库没有任何独立 `.svg` 文件**，图标全部是内联 SVG 片段：

| 来源 | 数量 | 规格 | 用途 |
| --- | --- | --- | --- |
| `tabmenu.js TAB_ICONS` | 12 页签 + `_fallback` = 13 | 24×24，`stroke=currentColor`，`stroke-width=1.8` | 导航 Tab |
| `network_status.js svgIcon()` | 12（`signal/globe/activity/trend/bars/sim/band/layers/internet/ip/ipv6/beam`） | 24×24，stroke 2 | 卡片标题/信息格 |
| `network_status.js createCellularTowerSvg` | 1 | 1024×1024 `BROADCAST_TOWER_PATHS` 复杂路径 | 信号塔装饰 |
| `network_status.js renderMiniSparkline` / 趋势图 | 2 | 含 `linearGradient` defs、`mt-beacon-dot` 脉冲 | 数据可视化 |
| `mt5700.js api.cellularSignal` | 1 | 32×32 四格信号柱 + slash/dot/error 角标 | 状态指示 |
| `mt5700.js api.constellationSvg` / `mimoSvg` | 2 | 320×190，渐变 + 光晕 + SMIL `animateMotion` | QAM/MIMO 可视化 |
| `mt5700.js api.loading` | 1 | 50×50 spinner | 加载 |
| `mt5700.js api.mascot` | 图片非 SVG | `mascot.png` | 看板娘 |
| `mt5700.js startGlobalBg` | 图片非 SVG | 4 张 `character-{pc,mobile}-{light,dark}.webp` + 三角网格 | 全局壁纸 |
| `mt5700.css` / `logs.js` | 4 处 `data:image/svg+xml` | 下拉箭头、搜索图标等 | CSS 背景 |
| `logs.js` / `upgrade.js` / `dial.js` | Emoji | `📋🔔📡💬…` / `↑⭳✓⚡!` / `💡` | 文字图标（普通模式原样保留） |

**动画**：`mt-anim-*`、`mt-beacon-pulse`、`signal-search`、`connect-pulse`、`mt-modal-pop`、`mt-sms-modal-in`、`mt-mascot-float` 等，集中在 `mt5700.css`。
**主题**：`theme.js` 写 `html.at-dark/at-light` + `data-at-theme`，`mt5700.css` / `at.css` / `global.css` 各自有暗色变量覆盖；无独立夜间模式按钮。

### 9.1 交付的图标体系（71 语义 × 2 套 = 142 个 SVG 文件）

| 前缀 | 数量 | 语义 |
| --- | --- | --- |
| `nav-*` | 13 | 12 个导航页签 + fallback（normal 逐字搬运 `TAB_ICONS`） |
| `st-*` | 12 | 12 个状态页卡片图标（normal 逐字搬运 `svgIcon`） |
| `op-*` | 46 | 任务要求全覆盖：仪表盘、网络状态、信号强度、SIM 卡、5G 网络、频段、小区信息、短信、AT 命令、设备信息、设置、刷新、搜索、添加、删除、编辑、保存、确认、取消、警告、错误、返回、导航，以及拨号/扫频/定时/模组/升级/终端/日志/服务配置/USB/电源/上传/下载/安全/连接/关闭/筛选/时钟/文件/主题/帮助/信息/成功/加载等业务操作图标 |

`icons/normal/<key>.svg` 与 `icons/minimal/<key>.svg` 目录隔离，均为规范 SVG
（24×24 viewBox、`currentColor`、`role="img"` + `aria-label`、`focusable="false"`）。
`minimal` 全部重新绘制为 MD3 几何造型，生成脚本强制校验两套图元**字符串不得相同**。

## 10. 状态管理（真实）

- 全局单例：`window.AtWs.client`（rpc.js ATClient）、`window.AtTheme`、`window.Mt5700`、`window.Ui`、`window.AtTabmenu`。
- 页面级：各视图 `render()` 内的局部 `state` 对象 + `Ui.interval`/`onLeave` 生命周期。
- 未保存配置：`Mt5700.staged()`（`mt5700.js:923`）暂存 + `applybar`。
- 无独立前端状态库 / 无 localStorage 持久化（仅 `tabmenu.js` 用 `sessionStorage` 记 Tab 滚动位置）。

## 11. 改造方案与范围对照

| 需求 | 落地方式 | 是否触碰业务 |
| --- | --- | --- |
| 全局统一状态 | `uimode.js` 单例 → `<html data-ui-mode>`；CSS 一次命中全页；弹窗挂在 body 下自动继承 | 否 |
| 模式切换免刷新/跨页/刷新/重新登录保持 | UCI 权威 + sessionStorage 首屏 hint；`AtUimode.set()` 乐观切换 → 持久化 → 失败回滚 | 否 |
| 普通模式完整保留 | 所有新增 CSS 规则带 `html[data-ui-mode="minimal"]` 前缀；3 张原 CSS、10 个视图、原内联 SVG 逐字保留 | 否 |
| MD3 极简模式 | 新增 `md3.css`：tokens + 组件 + 弹窗 + 响应式 + 明暗；重映射 `--mt5700-*`/`--at-*` 变量 | 否 |
| 独立重绘 SVG + Icon Manager | `icons.js` 两张表 + `icons/{normal,minimal}/*.svg`；`data-mt-icon` + `refresh()` | 否 |
| 弹窗完整复用 | 仅 `AtUimode.decorate()` 打标记；四套结构由 `md3.css` 覆盖视觉 | 否 |
| 性能优化 | JS 层不创建壁纸/看板娘 DOM；图表跳过光晕/渐变/SMIL；装饰动画停用；切换不重建轮询 | 否 |
| 业务安全 | 未改 `mt5700.uc`、Rust 源码、RPC/ubus、业务 UCI、init.d、hotplug、AT/SMS/拨号/USB 逻辑 | 否 |

## 12. 验收矩阵（对应任务第十一节）

| 类别 | 检查项 | 自动化手段 |
| --- | --- | --- |
| 双模式 | 默认 normal、互切、跨页/刷新/重新登录保持、非法回退、保存失败回滚 | `tests/dual-ui-mode-test.js` + 浏览器 harness |
| MD3 | tokens 齐全、组件选择器、明暗适配、手机/PC 响应式、reduced-motion | CSS 静态断言 + Chromium 渲染 |
| SVG | 142 文件合法 XML、两套隔离、语义一致、normal 逐字保留、minimal 全重绘 | 生成脚本 `--check` + XML 解析 + 字符串比对 |
| 弹窗 | 四套结构选择器齐全、业务代码零改动、确认/取消/异步回调保留 | 源码 diff 断言 + 浏览器弹窗渲染 |
| 业务安全 | Ucode/Rust/ACL/menu.d/RPC 未改、无新增轮询、无 JS 异常 | `git diff` 白名单 + `node --check` + 全量单测 |
