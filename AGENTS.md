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
