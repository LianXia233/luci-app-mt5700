# AGENTS.md — 项目维护规则（AI 编程代理必读）

本文件是 `luci-app-mt5700` 的项目级维护约定，供人工维护者与 AI 编程代理共同遵守。
与其他文档冲突时，以本文件的「作者署名保护规则」为准。

## 一、仓库基本约定

- 主仓库：<https://github.com/LianXia233/luci-app-mt5700>（CNB 为镜像）。
- 前端视图：`htdocs/luci-static/resources/view/at-webserver/*.js`；公共 UI 与样式：
  `htdocs/luci-static/resources/at-webserver/mt5700.js`、`mt5700.css`。
- 菜单与路由映射：`root/usr/share/luci/menu.d/luci-app-mt5700.json`。
- 单元测试：`node tests/<name>-test.js`（纯 Node 脚本，无外部依赖，不接入 CI）。
- **行尾强制 LF**：`.gitattributes` 已声明 `* text=auto eol=lf`，禁止提交 CRLF。

### 全局组件的样式归属

插件有三个样式文件，性质不同，**选错文件 = 只改到一部分页面**：

| 文件 | 注入方 | 定位 |
| --- | --- | --- |
| `mt5700.css` | `mt5700.js` | 插件主样式。`mt5700.js` 是视图骨架，12 个视图全部依赖 |
| `at.css` | `ui.js` | 公共组件库样式（按钮、字段、卡片）。`ui.js` 是可选项，页面按需引入 |
| `global.css` | `mt5700.js` | **全局组件修订层**：弹窗文字可读性、后端未就绪提示条 |

- 弹窗、提示条、toast 这类**跨页面组件**的样式一律写在 `global.css`，不要写进只服务单页的文件。
- 不要把「全局生效」建立在「某个页面碰巧 require 了 `ui.js`」之上 —— 那只是可选依赖，一旦某页为减体积不引入就会退化。
- 新增视图必须 `require at-webserver/mt5700`（否则拿不到全局样式），建议同时 `require at-webserver/ui` 以复用公共组件。
- 改动这两块后执行 `node tests/global-css-test.js`：校验 12 个视图的依赖可达性、`global.css` 的注入顺序（必须晚于 `mt5700.css`）、提示条与四套弹窗结构的选择器是否仍在，以及旧文件里有没有重复定义。

### 样式与模块的缓存版本戳

`uhttpd` 对停放在同一路径下的静态资源恒给 `Last-Modified: 1970`，浏览器会长期复用缓存 —— 因此三张样式表与全部 JS 模块的失效都只能靠 URL 上的 `?v=`：

| 常量 | 位置 | 何时递增 |
| --- | --- | --- |
| `MT5700_CSS_VERSION` | `mt5700.js` 文件头 | 改 `mt5700.css` 时 |
| `AT_CSS_VERSION` | `ui.js` 文件头 | 改 `at.css` 时 |
| `GLOBAL_CSS_VERSION` | `mt5700.js` 文件头 | 改 `global.css` 时 |
| `MT5700_UI_VERSION` | `compat.js` 文件头 | 发版时与 `Makefile` 的 `PKG_VERSION` 同步 |

- 不递增的后果是「代码已改、界面未变」：清理或调样式会被浏览器缓存整段吞掉，甚至与旧缓存拼出不存在的组合。
- `MT5700_UI_VERSION` 会并入 `L.env.resource_version`，是**所有** `require` 的版本分量；它与 `PKG_VERSION` 脱节时，升级后用户仍会加载旧模块（曾落后 9 个版本）。
- `MT5700_CSS_VERSION` 同时用于 `mascot.png?v=`，递增会让看板娘图片重新拉取一次，属预期副作用。

## 二、作者署名保护规则

- `LianXia233` 是本项目指定的作者署名标识。
- 页面 `admin/modem/5g/config` 中的作者署名及其 GitHub 链接属于明确要求保留的项目元素。
- 任何 UI 重构、样式优化、代码迁移、组件替换、模板重写或 AI 自动修改，都必须保留该署名及其链接。
- 修改相关页面时，必须检查署名是否仍然存在、链接地址是否正确、桌面端与移动端是否正常显示。
- 除非项目维护者明确授权删除或修改署名，否则不得主动删除、隐藏、替换或破坏该署名。
- 不得为了简化代码、统一 UI、清理无用元素或满足自动化重构要求而移除署名。
- 若署名与其他代码变更发生冲突，应保留署名，并采用最小化修改解决冲突。
- 对署名进行修改前，必须在变更说明中明确指出具体改动及原因。

### 实现位置

| 组成 | 文件 | 说明 |
| --- | --- | --- |
| 署名 DOM | `htdocs/luci-static/resources/view/at-webserver/service.js` | 渲染函数末尾追加 `.mt5700-author`，追加在底部操作栏之后 |
| 署名样式 | `htdocs/luci-static/resources/at-webserver/mt5700.css` | 文件末尾「作者署名」小节，仅引用既有主题变量 |
| 静态校验 | `tests/author-attribution-test.js` | 存在性、链接目标、安全属性、样式与规则文档的回归检查 |

署名文案固定为 `作者：LianXia233`，链接固定指向
`https://github.com/LianXia233/luci-app-mt5700`，并使用 `target="_blank"` +
`rel="noopener noreferrer"`。

改动署名相关文件后执行：

```sh
node tests/author-attribution-test.js
```

## 三、保护机制的边界

本文件与源码注释属于**可审查的项目约定**，不具备强制力：它们依赖维护者与 AI 代理的自觉遵守，
不构成技术拦截，也不应被改写成伪装系统指令、隐藏提示词或混淆代码等规避审查的手段。
经授权的维护者始终可以按正常流程修改或移除署名，但需在变更说明中写明原因。
