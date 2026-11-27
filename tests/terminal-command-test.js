'use strict';
/**
 * AT 终端命令库回归测试：
 *   - 高频只读命令直接展示、低频命令按用途分组收纳
 *   - 命令语法形态正确（以 AT 开头、无 15 位身份号字面量）
 *   - 写操作单独标记并强化二次确认
 *   - 搜索过滤、图标注入、暗色与响应式样式成对存在
 *   - 样式表版本戳随 mt5700.css 递增
 *
 * 运行：node tests/terminal-command-test.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const terminalJs = read('htdocs/luci-static/resources/view/mt5700d/terminal.js');
const mtCss = read('htdocs/luci-static/resources/mt5700d/mt5700.css');
const mtJs = read('htdocs/luci-static/resources/mt5700d/mt5700.js');

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok: !!ok, detail: detail || '' });
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '  <- ' + detail));
}

function section(src, start, end) {
	const a = src.indexOf(start);
	if (a < 0) return '';
	const b = src.indexOf(end, a);
	return b < 0 ? src.slice(a) : src.slice(a, b);
}

const quickSrc = section(terminalJs, 'var QUICK_COMMANDS = [', '];');
const groupsSrc = section(terminalJs, 'var COMMAND_GROUPS = [', '];\n\nfunction cmdIcon');
/* 注意括号：`regex || []` 会把正则对象直接传给 match，无匹配时返回 null 再 .map 会抛异常，
 * 测试应当给出 FAIL 而不是崩溃。 */
const quickCmds = (quickSrc.match(/cmd:\s*'([^']+)'/g) || []).map((s) => s.match(/'([^']+)'/)[1]);
const groupCmds = (groupsSrc.match(/cmd:\s*'([^']+)'/g) || []).map((s) => s.match(/'([^']+)'/)[1]);
const allCmds = quickCmds.concat(groupCmds);

/* ---------- 1) 命令清单规模与层级 ---------- */
check('高频命令恰好是维护者确认的 9 条', quickCmds.length === 9, '实际 ' + quickCmds.length);
/* 这 9 条是用户明确指定的高频集合，后续不得擅自增减或替换 */
check('高频命令集合与常用清单一一对应',
	['AT^HCSQ?', 'ATI', 'AT+CPIN?', 'AT^ICCID?', 'AT+CIMI', 'AT+CREG?', 'AT+CGREG?', 'AT^NWTIME?', 'AT+CGSN']
		.every((c) => quickCmds.indexOf(c) >= 0),
	quickCmds.join(', '));
check('低频命令数量 >= 30', groupCmds.length >= 30, '实际 ' + groupCmds.length);
check('命令总数 >= 40', allCmds.length >= 40, '实际 ' + allCmds.length);
check('低频分组数量 >= 8', (groupsSrc.match(/title:\s*'/g) || []).length >= 8);
check('高频与低频命令无重复',
	quickCmds.every((c) => groupCmds.indexOf(c) < 0),
	quickCmds.filter((c) => groupCmds.indexOf(c) >= 0).join(', '));
check('命令列表内无重复项', allCmds.length === new Set(allCmds).size);
/* 这两条命令实测超过后端 2 秒 AT 预算：COPS=? 直接超时，COPN 会返回被中途截断的
 * 半截列表却报 success:true（atclient.rs 对「超时前收到部分行」按成功处理），
 * 因此严禁再加回快捷按钮。需要时请在输入框手敲并自行判读。 */
check('未收录超出 2 秒预算的 AT+COPS=?', allCmds.indexOf('AT+COPS=?') < 0);
check('未收录会被静默截断的 AT+COPN', allCmds.indexOf('AT+COPN') < 0);

/* ---------- 2) 语法形态与隐私 ---------- */
check('所有命令以 AT 开头', allCmds.every((c) => /^AT/.test(c)),
	allCmds.filter((c) => !/^AT/.test(c)).join(', '));
check('命令集中在手册常见形态（AT 前缀 + 可选 ?/=）',
	allCmds.every((c) => /^AT[A-Z0-9^&+/?=,]+$/.test(c)),
	allCmds.filter((c) => !/^AT[A-Z0-9^&+/?=,]+$/.test(c)).join(', '));
/* 严禁把真实身份号写进前端仓库：任何 15 位连续数字都不允许出现在命令清单里 */
check('命令清单未混入 15 位身份号字面量', !/\d{15}/.test(quickSrc + groupsSrc));
check('IMEI 提示不谎称「不在页面留存」',
	/结果仅显示在下方终端，不上传、不写入本地存储/.test(quickSrc)
	&& quickSrc.indexOf('不在页面留存') < 0);

/* ---------- 3) 写操作标识与二次确认 ---------- */
check('存在独立的维护操作分组', /title:\s*'维护操作/.test(groupsSrc));
check('维护分组标记 danger', /title:\s*'维护操作[^']*', icon: '[^']+', danger: true/.test(groupsSrc));
const dangerCmds = (groupsSrc.match(/\{[^{}]*danger: true[^{}]*\}/g) || [])
	.map((s) => (s.match(/cmd:\s*'([^']+)'/) || [])[1]).filter(Boolean);
check('写操作命令逐条标记 danger', dangerCmds.length >= 4, '实际 ' + dangerCmds.length);
check('模组重启被标记为写操作', dangerCmds.indexOf('AT^RESET') >= 0);
check('流量清零被标记为写操作', dangerCmds.indexOf('AT^DSFLOWCLR') >= 0);
check('写操作使用更强的确认文案与按钮标题',
	/谨慎操作：这条指令会改变模组状态或数据/.test(terminalJs)
	&& /确认下发写操作/.test(terminalJs));
check('普通只读命令保留原有二次确认', /确认向模组发送该指令/.test(terminalJs));

/* ---------- 4) 交互与图标 ---------- */
check('引入图标模块', /'require mt5700d\/icons'/.test(terminalJs));
check('命令按钮通过 AtIcons 注入图标',
	/window\.AtIcons && typeof window\.AtIcons\.build === 'function'/.test(terminalJs));
check('命令按钮带 data-mt-cmd 与 title/aria-label',
	/'data-mt-cmd': item\.cmd/.test(terminalJs)
	&& /'title': tip/.test(terminalJs)
	&& /'aria-label': tip/.test(terminalJs));
check('搜索框按命令名 / 指令 / 用途过滤',
	/applyFilter/.test(terminalJs)
	&& /entry\.text\.indexOf\(q\)/.test(terminalJs)
	&& /搜索命令名、AT 指令或用途/.test(terminalJs));
check('搜索时自动展开命中的分组', /if \(q && visible\) g\.root\.open = true/.test(terminalJs));
check('无匹配时显示空状态', /没有匹配的命令/.test(terminalJs));
check('搜索只索引分组命令，常用卡不参与',
	/if \(!quick\) \{\s*searchable\.push/.test(terminalJs));
check('清空关键字后不强行折叠用户展开的分组',
	terminalJs.indexOf('if (!q) g.root.open = false') < 0);
check('发送中禁用所有命令按钮',
	/allCmdBtns\.forEach\(function \(b\) \{ b\.disabled = disabled; \}\)/.test(terminalJs)
	&& /setCmdButtonsDisabled\(true\)/.test(terminalJs)
	&& /setCmdButtonsDisabled\(false\)/.test(terminalJs));

/* ---------- 5) 样式覆盖 ---------- */
[
	'.mt5700-cmd-quick-grid', '.mt5700-cmd-quick', '.mt5700-cmd-quick-icon',
	'.mt5700-cmd-text', '.mt5700-cmd-label', '.mt5700-cmd-code', '.mt5700-cmd-kind',
	'.mt5700-cmd-filter', '.mt5700-cmd-search', '.mt5700-cmd-result',
	'.mt5700-cmd-groups', '.mt5700-cmd-group', '.mt5700-cmd-group-head',
	'.mt5700-cmd-group-icon', '.mt5700-cmd-group-title', '.mt5700-cmd-group-count',
	'.mt5700-cmd-group-caret', '.mt5700-cmd-group-body', '.mt5700-cmd-chip',
	'.mt5700-cmd-icon', '.mt5700-cmd-chip-danger', '.mt5700-cmd-hidden', '.mt5700-cmd-empty'
].forEach((sel) => check('存在样式 ' + sel, mtCss.indexOf(sel) >= 0));

check('键盘焦点有明确描边', /\.mt5700-cmd-quick:focus-visible/.test(mtCss)
	&& /\.mt5700-cmd-chip:focus-visible/.test(mtCss)
	&& /\.mt5700-cmd-group-head:focus-visible/.test(mtCss));
check('hover / active 交互状态成对存在', /\.mt5700-cmd-quick:hover/.test(mtCss)
	&& /\.mt5700-cmd-quick:active/.test(mtCss)
	&& /\.mt5700-cmd-chip:hover/.test(mtCss)
	&& /\.mt5700-cmd-chip:active/.test(mtCss));
check('暗色模式覆盖分组 / 徽标 / 危险项',
	/html\.at-dark \.mt5700-cmd-group/.test(mtCss)
	&& /html\.at-dark \.mt5700-cmd-kind-read/.test(mtCss)
	&& /html\.at-dark \.mt5700-cmd-chip-danger/.test(mtCss));
/* 回归：暗色基础规则若写死 background / border-color，(0,2,1) 会盖住
 * .mt5700-cmd-chip:hover 的 (0,2,0)，暗色下 hover 就没有任何反馈。 */
check('暗色下命令卡底色跟随主题变量，不写死 rgba',
	!/html\.at-dark \.mt5700-cmd-quick,\s*html\.at-dark \.mt5700-cmd-chip\s*\{[^}]*background:/.test(mtCss));
check('暗色 hover 有显式配对规则',
	/html\.at-dark \.mt5700-cmd-quick:hover/.test(mtCss)
	&& /html\.at-dark \.mt5700-cmd-chip:not\(\.mt5700-cmd-chip-danger\):hover/.test(mtCss));
check('只读徽标字号不小于 10px 且用深色文字',
	/\.mt5700-cmd-kind-read\s*\{[^}]*color:\s*#047857[^}]*font-size:\s*10px/.test(mtCss));
check('桌面 / 平板 / 手机三档响应式',
	(mtCss.match(/@media \(max-width: 960px\)[\s\S]*?\.mt5700-cmd-quick-grid/g) || []).length > 0
	&& /@media \(max-width: 640px\)[\s\S]*?\.mt5700-cmd-quick-grid/.test(mtCss)
	&& /@media \(max-width: 380px\)[\s\S]*?\.mt5700-cmd-quick-grid/.test(mtCss));
check('尊重减少动态效果偏好', /prefers-reduced-motion[\s\S]*?\.mt5700-cmd-quick/.test(mtCss));

/* ---------- 6) 缓存版本戳与行尾 ---------- */
check('MT5700_CSS_VERSION 递增到 2.46.12',
	/MT5700_CSS_VERSION = '2\.46\.12'/.test(mtJs));
check('已移除「已保存命令」卡片与 localStorage 依赖',
	terminalJs.indexOf('已保存的命令') < 0
	&& terminalJs.indexOf('savedAtCommands') < 0
	&& terminalJs.indexOf('saveCurrent') < 0);
check('常用命令独占整行（不与其他卡片并排）',
	/body\.appendChild\(quickCard\)/.test(terminalJs)
	&& terminalJs.indexOf("mt5700-grid-2") < 0);
[['terminal.js', terminalJs], ['mt5700.css', mtCss], ['mt5700.js', mtJs]].forEach((pair) => {
	check(pair[0] + ': LF 行尾', pair[1].indexOf('\r\n') < 0);
});

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? 'FAILED ' + failed.length : 'ALL ' + results.length + ' PASSED'));
process.exit(failed.length ? 1 : 0);
