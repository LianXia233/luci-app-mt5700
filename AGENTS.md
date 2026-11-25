# 🤖 AGENTS.md — 项目维护规则（AI 编程代理必读）

<div align="center">

**luci-app-mt5700** 项目级维护约定 · 供人工维护者与 AI 编程代理共同遵守  
*任何维护与自动化改动均需以本规范为准绳；与其他文档冲突时，以「作者署名保护规则」为最高准则。*

<p align="center">
  <img src="https://img.shields.io/badge/Rules-AGENTS.md-2563eb?style=flat-square&logo=github" alt="Rules" />
  <img src="https://img.shields.io/badge/License-GPL--3.0--only-16a34a?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/Code-OpenWrt%20%7C%20Rust-ea580c?style=flat-square" alt="Stack" />
</p>

</div>

---

### 🧭 规范章节速览

<div align="center">

[一、 📜 仓库基本约定](#一仓库基本约定) &nbsp;•&nbsp;
[二、 🛡️ 作者署名保护规则](#二作者署名保护规则) &nbsp;•&nbsp;
[三、 🔒 推送前脱敏检查规则](#三推送前脱敏检查规则)

[四、 ⚖️ 保护机制的边界](#四保护机制的边界) &nbsp;•&nbsp;
[五、 🦀 Rust/Tokio 后端健康规则](#五rusttokio-后端健康规则) &nbsp;•&nbsp;
[六、 📦 第三方依赖许可证与来源规则](#六第三方依赖许可证与来源规则)

</div>

---

## 一、仓库基本约定

- **主仓库**：<https://github.com/LianXia233/luci-app-mt5700>（CNB 为镜像）。
- **许可证**：SPDX `GPL-3.0-only`（与 `README.md` 的声明一致），完整条款见根目录 `LICENSE`；页脚以纯文本标识展示，不得改成 `GPL-3.0-or-later` 或其他表达式。
- **前端视图**：`htdocs/luci-static/resources/view/mt5700d/*.js`；公共 UI 与样式：`htdocs/luci-static/resources/mt5700d/mt5700.js`、`mt5700.css`。
- **菜单与路由映射**：`root/usr/share/luci/menu.d/luci-app-mt5700.json`。
- **单元测试**：`node tests/<name>-test.js`（纯 Node 脚本，无外部依赖；`tests/*-test.js` 会由 `.github/workflows/checks.yml` 自动纳入 CI）。
- **行尾强制 LF**：`.gitattributes` 已声明 `* text=auto eol=lf`，禁止提交 CRLF。
- **更新日志同步**：任何进入 `main` 的功能 / 修复 / 样式 / 行为改动，必须同步更新 `CHANGELOG.md`（随改动提交，或在同版本定版提交前补齐），不得只改代码不写日志。
  - **更新日志豁免**（需维护者明确要求）：纯文案微调、署名文案变更、门禁脚本与规则文档（`checks.yml`、`tests/*-test.js`、本文件）自身的维护，若不发版、不提升包版本、不改变渲染结果与运行时行为，可不写 `CHANGELOG.md`；提交说明仍须写清改动与原因。此例外不适用于功能、修复、行为或视觉样式改动，也不免除发版时的版本一致性要求。
- **角色素材归属**：`htdocs/luci-static/resources/mt5700d/bg/character-*.webp` 是《蔚蓝档案》（Blue Archive）角色「阿罗娜 / 彩奈」（浅色）与「普拉娜」（深色）的二次创作插画，与英雄区头像 `mascot.png`（《异环》薄荷）**不是同一作品、不是同一权利人**。逐文件指纹、识别依据与授权状态以 `THIRD-PARTY-NOTICES.md` 第 2 节为唯一事实源；改动素材或声明时须同步该文件、README 与文档站，不得再把背景图归到《异环》/ Hotta Studio 名下。
  按维护者决定，素材保留在安装包内；包内必须同时安装 `root/usr/share/licenses/luci-app-mt5700/ARTWORK-NOTICE.txt`，不得只留图片不留声明。
- **i18n 约定**：源语言为简体中文。共享组件文案由 `mt5700.js` 的 `trText()` 统一调用 LuCI `_()`（不要缩成 `tr`：`api.table` 的局部 `var tr` 会遮蔽同名函数）。`po/templates/luci-app-mt5700.pot` 与 `po/zh_Hans/luci-app-mt5700.po` 的 msgid 集合必须一致、无重复、zh_Hans 的 msgstr 非空，且 `menu.d` 的每个标题都已收录。新增语言在 `po/<lang>/` 下建同名文件，不改视图；改动 po、菜单标题或共享组件后执行 `node tests/i18n-test.js`。
- **发版版本一致性 + 文档徽标同步**：提升版本号（打 `v*` 标签出正式版）时，以下引用必须与新 `PKG_VERSION` 一致，缺一不可：  
  `Makefile` 的 `PKG_VERSION` ＝ `compat.js` 的 `MT5700_UI_VERSION` ＝ `src/rust/Cargo.toml` 的 `version` ＝ `CHANGELOG.md` 新增版本小节 ＝ `docs/release-notes/v<版本>.md`；  
  同时同步文档徽标与下载入口 —— `README.md` 头部 Version 徽标、`docs/index.html` 的 `#navVersionBadge` / `#latestReleaseTag` 与四处 `releases/download/v<版本>/…` 下载链接。下载链接的资产命名以最近一次 Release 的实际产物为准（形如 `luci-app-mt5700_<版本>-r<PKG_RELEASE>_<架构>.ipk` / `luci-app-mt5700-<版本>-r<PKG_RELEASE>.apk`），不得沿用旧后缀。

### 全局组件的样式归属

插件有三个样式文件，性质不同，**选错文件 = 只改到一部分页面**：

| 样式文件 | 注入载体 | 核心定位与职责 |
| :--- | :--- | :--- |
| `mt5700.css` | `mt5700.js` | 插件主样式。`mt5700.js` 是视图骨架，12 个视图全部依赖 |
| `at.css` | `ui.js` | 公共组件库样式（按钮、字段、卡片）。`ui.js` 是可选项，页面按需引入 |
| `global.css` | `mt5700.js` | **全局组件修订层**：弹窗文字可读性、后端未就绪提示条 |

> [!IMPORTANT]
> 1. 弹窗、提示条、toast 这类**跨页面组件**的样式一律写在 `global.css`，严禁写进只服务单页的文件。
> 2. 不要把「全局生效」建立在「某个页面碰巧 require 了 `ui.js`」之上 —— 那只是可选依赖，一旦某页为减体积不引入就会退化。
> 3. 新增视图必须 `require mt5700d/mt5700`（否则拿不到全局样式），建议同时 `require mt5700d/ui` 以复用公共组件。
> 4. 改动这两块后执行 `node tests/global-css-test.js`：校验 12 个视图的依赖可达性、`global.css` 的注入顺序（必须晚于 `mt5700.css`）、提示条与四套弹窗结构的选择器是否仍在，以及旧文件里有没有重复定义。

### 样式与模块的缓存版本戳

`uhttpd` 对停放在同一路径下的静态资源恒给 `Last-Modified: 1970`，浏览器会长期复用缓存 —— 因此三张样式表与全部 JS 模块的失效都只能靠 URL 上的 `?v=`：

| 常量名称 | 声明所在位置 | 何时必须递增 |
| :--- | :--- | :--- |
| `MT5700_CSS_VERSION` | `mt5700.js` 文件头 | 改动 `mt5700.css` 时 |
| `AT_CSS_VERSION` | `ui.js` 文件头 | 改动 `at.css` 时 |
| `GLOBAL_CSS_VERSION` | `mt5700.js` 文件头 | 改动 `global.css` 时 |
| `MT5700_UI_VERSION` | `compat.js` 文件头 | 发版时与 `Makefile` 的 `PKG_VERSION` 同步 |

- 不递增的后果是「代码已改、界面未变」：清理或调样式会被浏览器缓存整段吞掉，甚至与旧缓存拼出不存在的组合。
- `MT5700_UI_VERSION` 会并入 `L.env.resource_version`，是**所有** `require` 的版本分量；它与 `PKG_VERSION` 脱节时，升级后用户仍会加载旧模块（曾落后 9 个版本）。
- `MT5700_CSS_VERSION` 同时用于 `mascot.png?v=`，递增会让看板娘图片重新拉取一次，属预期副作用。
- `.mt5700-author-label` 目前是占位选择器（视图已不再渲染该节点）；清理它属于样式改动，须递增 `MT5700_CSS_VERSION` 并同步 `tests/usage-source-test.js` 的基线断言。

### 响应式配置弹窗交互规范（Right Drawer / Modal Bottom Sheet）

配置修改与子模块表单统一实现响应式配置弹窗（由 `mt5700d/config-drawer.js` 驱动）：

| 运行环境 | 呈现形态 | 布局与尺寸规范 |
| :--- | :--- | :--- |
| **PC 桌面端** (≥641px) | **右侧抽屉（Right Drawer）** | 停靠视口右侧，限宽 `min(520px, 92vw)`，100% 视口高度，头部与底部操作栏固定，内容区独立垂直滚动 |
| **移动端** (≤640px) | **底部弹出面板（Modal Bottom Sheet）** | 停靠视口底部，顶部圆角（16px），适配安全区（`safe-area-inset-bottom`），高度动态适应软键盘（`visualViewport`） |

> [!IMPORTANT]
> **弹窗防误触与交互一致性规范**：
> 1. **实现响应式配置弹窗**：PC 端采用右侧抽屉（Right Drawer），移动端采用底部弹出面板（Modal Bottom Sheet）。
> 2. **禁止点击遮罩层或弹窗外部关闭**：防止误触导致配置丢失；点击遮罩层时仅做轻微抖动动画（Shake）提示操作边界，绝不静默退出。
> 3. **明确的关闭按钮触发**：关闭操作必须通过明确的关闭按钮（弹窗头部「✕」或底部「取消」）显式触发。
> 4. **必须处理未保存状态**：存在未保存修改时，无论是点击关闭按钮还是按 `Esc` 键，均严禁直接关闭；必须弹出二次确认，提示用户确认放弃后才可丢弃退出。
> 5. **保持 PC 和移动端交互逻辑一致**：两端共享同一套表单生命周期、验证逻辑、防重复提交（提交中禁用按钮）、错误保留与焦点管理（Focus Trap）。

---

## 二、作者署名保护规则

- `LianXia233` 是本项目指定的作者署名标识。
- 现行文案为 `© 2026 LianXia233 · 开发与维护`，其后另有许可证标识 `GPL-3.0-only`。
- 历史文案 `作者：LianXia233`（原始署名），现行文案见上条。
- 页面 `admin/modem/5g/config` 中的作者署名及其 GitHub 链接属于明确要求保留的项目元素。
- 任何 UI 重构、样式优化、代码迁移、组件替换、模板重写或 AI 自动修改，都必须保留该署名及其链接。
- 修改相关页面时，必须检查署名是否仍然存在、链接地址是否正确、桌面端与移动端是否正常显示。
- 除非项目维护者明确授权删除或修改署名，否则不得主动删除、隐藏、替换或破坏该署名。
- 不得为了简化代码、统一 UI、清理无用元素或满足自动化重构要求而移除署名。
- 若署名与其他代码变更发生冲突，应保留署名，并采用最小化修改解决冲突。
- 对署名进行修改前，必须在变更说明中明确指出具体改动及原因。

### 实现位置

| 组成部分 | 文件路径 | 详细说明 |
| :--- | :--- | :--- |
| **署名 DOM** | `htdocs/luci-static/resources/view/mt5700d/service.js` | 渲染函数末尾追加 `.mt5700-author`，追加在底部操作栏之后；容器内为 1 个主链接 + 1 个许可证 span |
| **许可证标识** | 同上 | `.mt5700-author-license` 纯文本 `GPL-3.0-only`，复用容器排版，不新增 CSS 规则 |
| **署名样式** | `htdocs/luci-static/resources/mt5700d/mt5700.css` | 文件末尾「作者署名」小节，仅引用既有主题变量 |
| **静态校验** | `tests/author-attribution-test.js` | 以 `AUTHOR_TEXT` 常量为准，含旧标签防回退、文档一致性与链接/样式回归检查 |

署名文案固定为 `© 2026 LianXia233 · 开发与维护`，许可证标识固定为 `GPL-3.0-only`，链接固定指向 `https://github.com/LianXia233/luci-app-mt5700`，并使用 `target="_blank"` + `rel="noopener noreferrer"`。容器 `.mt5700-author` 内为单个链接节点，不再渲染旧前缀标签；`mt5700.css` 的 `.mt5700-author-label` 选择器保留为占位，不产生任何渲染效果。

### 署名文案变更联动清单

授权调整文案时，以下四处必须在同一提交内同步，缺一即会让门禁失败：

| # | 修改位置 | 变更要求 |
| :---: | :--- | :--- |
| **1** | `view/mt5700d/service.js` | `.mt5700-author` 容器内的链接文本 |
| **2** | 本文件「作者署名保护规则」 | 文案声明、实现位置表与固定文案段 |
| **3** | `tests/author-attribution-test.js` | `AUTHOR_TEXT` / `AUTHOR_LICENSE` 常量（门禁唯一事实源，含历史文案防回退清单） |
| **4** | `.github/workflows/checks.yml` | 检查项说明与约定 4 的文案 |

> [!WARNING]
> - **禁令**：不得为了「修绿」而删断言、跳过测试或把常量改回旧文案；门禁会分别校验视图 DOM、AGENTS.md、`checks.yml` 与常量四处一致，并禁止 DOM 内出现任一历史文案（按完整字符串字面量比对，避免 "© 2026 …" 与 "… · 开发与维护" 的子串误判）。
> - **覆盖性**：调整后必须保留同等或更强的覆盖范围（`checks.yml` 约定 2）。
> - **Copyright 写法**：`Copyright (C)` 写法仅为未推送的中间态，不得出现在页脚 DOM 中。
> - **样式边界**：`.mt5700-author-license` 目前**没有专门 CSS 规则**，继承容器的 `gap: 0 0.2em`、`flex-wrap: wrap`、居中与 xs 字号；这三项不得移除，否则窄屏下长文案会溢出。若以后要为许可证标识单独排版，改 `mt5700.css` 即须递增 `MT5700_CSS_VERSION` 并同步 `tests/usage-source-test.js` 的基线断言。

改动署名相关文件后执行测试验证：

```sh
node tests/author-attribution-test.js
node tests/dual-ui-mode-test.js
```

---

## 三、推送前脱敏检查规则

每次执行 `git push` 前（包括推送功能分支、更新已有分支、推送标签或 force-push），必须先完成脱敏检查。此规则适用于人工维护者与所有 AI 编程代理，不得因改动规模小、仅修改文档、使用自动化工具或紧急修复而跳过。

### 检查范围

- 检查本次准备推送的全部提交差异，而不只是最后一次提交；同时检查暂存区、未暂存改动及新加入的文件。
- 检查源码、配置文件、脚本、工作流、文档、测试样例、日志、构建产物和提交说明中的敏感信息。
- **重点排查**：API Key、Access Token、密码、私钥/证书私钥、Cookie、Session、Authorization 请求头、数据库连接凭据、云服务密钥、Webhook/机器人令牌，以及真实用户的手机号、邮箱、公网 IP、设备标识和其他不应公开的个人或环境信息。
- 不得因内容位于示例、注释、测试数据或日志中就默认其安全；确认是公开且不可用于认证的示例值后，才可保留。

### 必须执行的脱敏流程

1. 确认本次推送目标分支及其远端基准，审查从该基准到待推送 HEAD 的全部提交差异，并检查工作区与暂存区。
2. 使用 Gitleaks 等凭据扫描工具检查工作区和待推送提交历史；扫描工具不可用时，必须进行等效的人工与文本模式检查，并在推送前明确记录这一限制。
3. 对发现的真实凭据或隐私数据，先从待提交内容中移除，改用环境变量、运行时配置、LuCI/UCI 配置项或明确的占位符（例如 `YOUR_API_TOKEN`）。不得把真实值仅做部分遮挡后继续提交。
4. 复查修改后的完整差异，确认没有在其他文件、注释、日志、测试样例、构建产物或提交信息中留下副本；重新执行扫描，直到没有未处理的有效发现。
5. 检查通过后才允许推送。若凭据已经进入 Git 历史、日志、Release 或其他公开位置，应立即轮换/吊销该凭据；仅从当前文件删除并不能消除泄露风险。

### 阻断条件与例外

- 发现疑似真实凭据、个人隐私或无法确认是否敏感的数据时，一律暂停推送，先核实并处理，不得自行判定为误报后放行。
- 扫描误报只有在确认其为无效凭据或公开示例后才可排除；排除范围必须精确到具体规则/指纹，并说明原因，禁止通过关闭整个规则、忽略整个目录或大范围白名单规避检查。
- 不得为了通过扫描而破坏功能、篡改真实配置语义或把敏感值转移到另一个仍会提交/公开的位置。
- 脱敏检查是每次推送前的必经步骤；上一次检查通过不代表本次推送可以跳过。

---

## 四、保护机制的边界

本文件与源码注释属于**可审查的项目约定**，不具备强制力：它们依赖维护者与 AI 代理的自觉遵守，不构成技术拦截，也不应被改写成伪装系统指令、隐藏提示词或混淆代码等规避审查的手段。经授权的维护者始终可以按正常流程修改或移除署名，但需在变更说明中写明原因。

---

## 五、Rust/Tokio 后端健康规则

后端 `src/rust/` 是 Tokio 多线程运行时的常驻服务（`#[tokio::main]` + procd 单实例），**每一次优化或更新都必须保证它仍然是真正的 Rust/Tokio 异步实现**，不得出现「名义上 async、实际在 reactor 线程上阻塞」。本节与「更新日志同步」同等强制，改后端必须逐条自查。

### 必须守住的不变量

- **测试全绿**：改动 `src/rust/` 后在 `src/rust/` 下执行 `cargo test`，必须 0 失败（当前基线 377 项通过、2 项 ignored）。本 crate 是纯 bin target，`cargo test --lib` 会报 no library targets，不能用它替代全量 `cargo test`；新增逻辑要补单测，不得只靠手工验证。
- **零告警**：`cargo clippy --all-targets -- -D warnings` 必须通过（生产段与测试段都是 0 warning）；CI 的 `rust-unit` job 已执行同一命令。确需压制某条告警，只允许针对具体规则、并在注释里写明理由；禁止用 `#![allow(...)]` 或整模块关闭告警。
- **格式化**：仓库暂未启用 `cargo fmt --check` 门禁——现有代码的紧凑风格与 rustfmt 默认输出差异较大，直接接入会产生上万行纯格式 diff。新增/修改代码按周边风格书写；若决定启用，应先单独提交一次全量格式化，再接门禁。
- **async 路径不得阻塞**：`async fn` 内禁止 `std::process::Command`、`std::fs::*`、`std::net::TcpStream`、`std::thread::sleep`、`ureq` 等同步/阻塞 API。确有无法异步化的同步依赖（例如 `uci` 命令行、`/sys` 读取、系统串口枚举）时，用 `tokio::task::spawn_blocking` 包住整段，并在注释里写「为什么必须同步」；不要为了「看起来异步」硬包一层却仍在原地轮询或自旋。
- **锁的选择**：跨 `await` 持锁必须用 `tokio::sync::Mutex`。`std::sync::Mutex` 只允许「无 `await`、临界区只有几次内存操作」的场景（现存的日志环形缓冲、事件环形队列、QQ 通道句柄属此类），新增代码不得扩大这些临界区，也不得把阻塞 IO 挪进锁内。
- **AT 通道串行语义不得破坏**：单通道互斥仍是 `tokio::sync::Mutex`（`at_queue` 的 `PriLock` / `SmsTransaction`），任何时刻只允许一条命令在途；短信事务的整段占用不得被拆开插入别的命令。凡「为了并行而绕开互斥」的改动一律拒绝。
- **启动与关闭路径不得回归**：`main.rs` 的启动顺序（时区初始化 → 读配置 → 通知器 → 使用量 → 各后台任务）必须保持，且启动期的阻塞动作要在 `spawn_blocking` 里完成后再 `await`。退出仍由 `shutdown_signal()`（SIGTERM / Ctrl-C）与 `tokio::select!` 驱动：先 `ctx_tx.send(true)` 广播取消，再在 5 秒 `timeout` 内依次 await 全部后台任务收尾，最后落 `服务已停止` 日志。不得把阻塞调用塞回启动路径，也不得删掉收尾逻辑、取消信号或这段超时。
- **任务生命周期要写清**：新增或修改 `tokio::spawn` 时，必须能回答三个问题 —— 谁取消它（`watch::Receiver<bool>` / `CancellationToken` / 跑完即退出）、退出后谁 await 它（是否纳入上面的收尾列表）、失败是否会被吞掉。禁止起「既无 JoinHandle、也无取消信号」的常驻任务。

### 复核方式

```sh
cd src/rust
cargo test --locked
cargo clippy --all-targets -- -D warnings
cd ../..

# 仓库级门禁（与 checks.yml 一致）
node tests/static-check.js
node tests/i18n-test.js
for f in tests/*-test.js; do node "$f" || exit 1; done
sh tests/mock-modem/run-e2e.sh
```

CI 还会对 `*.sh` 与带 `#!/bin/sh` / `#!/bin/ash` 的脚本执行 `sh -n` 和
`shellcheck -S error`；提交前可用本机的 `shellcheck` 预跑同一命令。

扫描生产段（排除 `#[cfg(test)]`）确认没有残留阻塞调用：

```sh
grep -nE 'std::process::Command|std::fs::|std::net::Tcp|thread::sleep|ureq::' src/*.rs
```

命中的每一处要么改成 Tokio 等价物，要么位于 `spawn_blocking` 内并写明理由。提交说明或 PR 描述里要列出「调用点 → 处理方式 → 复核结果」三列。触及 `root/usr/share/rpcd/ucode/mt5700.uc` 时，另外在设备上执行 `ucode -c -s /usr/share/rpcd/ucode/mt5700.uc`。

### Rust 后端版本与包版本联动

后端自报版本（`mt5700d --version` 与启动日志里的 `mt5700d <版本> 启动中`）只由 `PKG_VERSION` 驱动，不允许再出现「二进制自报 1.29.0、包版本 1.32.7」这类分叉。

| 联动环节 | 声明或配置位置 | 作用与职责 |
| :--- | :--- | :--- |
| **单一来源** | `Makefile` 的 `PKG_VERSION` | 发版只改这一处，并 `export MT5700_VERSION := $(PKG_VERSION)` |
| **编译注入** | `src/Makefile` 的 `cargo build` 行 | `MT5700_VERSION="$(MT5700_VERSION)"` 传给 cargo；缺省时从上级 `Makefile` 解析 |
| **运行时消费** | `src/rust/src/main.rs` 的 `VERSION` | `option_env!("MT5700_VERSION")`，缺失回退 `CARGO_PKG_VERSION` |
| **元数据兜底** | `src/rust/Cargo.toml` 的 `version` | 仅本地无注入时使用，必须与 `PKG_VERSION` 保持一致 |

- 新增任何打印版本的位置（RPC 字段、日志、init.d 横幅）都必须复用 `main.rs` 的 `VERSION` 常量，不得另建常量或写死字面量。
- 改动上述任一环节后执行复核：

```sh
node tests/rust-version-test.js
grep -n '^PKG_VERSION' Makefile
grep -n '^version' src/rust/Cargo.toml
cd src/rust && cargo test
```

- 交叉编译产物核对：解包或安装后执行 `/usr/bin/mt5700d --version`，输出中的版本必须等于包管理器里的 `luci-app-mt5700` 版本。

---

## 六、第三方依赖许可证与来源规则

项目自有代码固定采用 `GPL-3.0-only`。该声明不改变任何第三方依赖、测试工具、字体、图标、角色素材或其他资产各自的许可证与权利归属。

### Rust 依赖

- 新增、删除、升级或替换 Cargo 依赖时，必须同步审查 `src/rust/Cargo.toml`、`src/rust/Cargo.lock` 与上游对应版本的许可证元数据及许可证文件。
- `deny.toml` 是 cargo-deny 的许可证与来源策略。许可证白名单必须保持明确、最小化；不得使用通配符或一揽子允许未知许可证。只有核实许可证文本、表达式及与 GPL-3.0-only 项目的兼容性后，才可新增许可标识。
- `webpki-roots` 的 Mozilla CA 根证书数据使用 `CDLA-Permissive-2.0`；完整协议必须保留在 `root/usr/share/licenses/luci-app-mt5700/CDLA-Permissive-2.0.txt`，确保固件软件包分发数据时同时提供协议文本。不得仅将该许可证写入 CI 报告而遗漏安装包。
- `src/rust/about.toml` 与 `src/rust/about.hbs` 负责生成逐项依赖许可证报告。发布工作流必须先执行 cargo-deny 的 `licenses`、`sources` 与 `bans` 检查，再生成 `RUST-DEPENDENCIES.md` 并将其注入 `root/usr/share/licenses/luci-app-mt5700/` 后编译 APK/IPK；正式包必须包含逐项 crate、版本、许可证及许可证文本。CI 的「第三方依赖许可证审计」job 必须执行 `cargo deny check licenses`、`cargo deny check sources` 与 `cargo deny check bans`，并将 cargo-about 生成的 crate、版本、许可证及许可证文本写入 GitHub Actions Summary。
- 遇到许可证缺失、识别置信度不足、非 SPDX 表达式或许可证文件与元数据不一致时，先核对上游发布包；不得为了让 CI 通过而直接放宽阈值、扩大白名单或忽略整个 crate。
- 自动化报告不替代人工审查。对外分发前，仍须核对上游版权声明、NOTICE、许可证全文及其要求的再分发义务。

### Node.js 测试依赖

- `tests/mock-modem/package.json` 是独立测试工具，当前自身许可证为 `ISC`。
- `tests/mock-modem/package-lock.json` 锁定 `ws@8.21.3`，当前锁定元数据声明为 `MIT`；不得将其许可证与 mock-modem 自身的 ISC 混为一谈。
- npm 锁文件使用官方 `registry.npmjs.org` 地址并保留 integrity 校验。升级依赖时必须同步核对包版本、许可证字段、来源地址与完整性哈希。

### 复核命令

```sh
node tests/license-metadata-test.js
cd src/rust
cargo deny check licenses
cargo deny check sources
cargo deny check bans
cargo about generate about.hbs
```

新增或升级依赖后，必须审查完整报告；未知许可证或未知来源未解决前，不得合并或发布。
