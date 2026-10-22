#!/usr/bin/env node
/*
 * UI 文案契约（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 背景（2026-10-22 用户口径「功能说明太多，看起来不简练」）：界面上曾把
 * **取证报告**直接贴给用户 —— 语音页那条提示有 208 字，讲 USB 六个接口、
 * 手册 244 条命令、要不要重编固件；VoWiFi 卡片把 DNS 通配污染、mnc999
 * 阴性对照的推理过程也写在页面上。用户点进来只想打电话，不是读实验记录。
 *
 * 判定原则：内部取证语言（带日期的实测标注、手册条数、NXDOMAIN/mnc999、
 * 指向 REFERENCE 的引用）**不该出现在给用户看的字符串里**。它属于
 * README §已知限制 与开发记忆，不属于界面。
 *
 * 本测试守三件：
 *   ① 字符串字面量里没有内部取证语言（注释不受限 —— 注释本来就该写这些）
 *   ② 单条中文字符串不超过 100 字（防「又贴了一大段」）
 *   ③ 检测器自己能抓到构造的样本（否则规则写错也恒绿）
 *
 * 运行：node tests/ui-copy-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = [
	path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver'),
	path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver')
];

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return true; }
	fails.push('  ✗ ' + name + (hint ? '\n      ' + hint : ''));
	return false;
}

/* ---------- 词法：先剥注释，再逐行抽字符串 ---------- */

/*
 * 为什么不用「一个状态机同时抽字符串」：那必须正确区分正则字面量 `/.../`
 * 与除号，否则正则里的引号会把后面的整段代码当成字符串 —— 本测试第一版
 * 就栽在这里，8 处误报 + 62 处假超长全是这个原因。
 *
 * 改成分两步：
 *   ① stripComments：只处理注释与字符串边界，遇到 `/` 先判 `//` `/*`，
 *      其余一律当普通字符。正则里的引号可能被误当字符串起点 —— 无害，
 *      因为 ② 只保留**含中文**的串，正则与代码片段都不含。
 *   ② 逐行正则抽引号串：行号天然正确，跨行串被拆成两段，只会更严格。
 */
function stripComments(src) {
	let out = '';
	let i = 0;
	const n = src.length;

	while (i < n) {
		const c = src[i];

		if (c === '/' && src[i + 1] === '/') {
			while (i < n && src[i] !== '\n') i++;
			continue;
		}
		if (c === '/' && src[i + 1] === '*') {
			i += 2;
			while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
				if (src[i] === '\n') out += '\n';   // 保留换行，行号不漂
				i++;
			}
			i += 2;
			continue;
		}
		if (c === '\'' || c === '"' || c === '`') {
			const q = c;
			out += c;
			i++;
			while (i < n) {
				if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
				out += src[i];
				if (src[i] === q) { i++; break; }
				i++;
			}
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

const STR_RE = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;

/* 只收含中文的串：UI 文案一定有中文，代码片段/正则/路径不会有 */
function extractStrings(src) {
	const stripped = stripComments(src.replace(/\r\n/g, '\n'));
	const out = [];
	stripped.split('\n').forEach(function (line, idx) {
		let m;
		STR_RE.lastIndex = 0;
		while ((m = STR_RE.exec(line)) !== null) {
			const text = (m[1] != null ? m[1] : m[2]) || '';
			if (/[\u4e00-\u9fff]/.test(text)) out.push({ text: text, line: idx + 1 });
		}
	});
	return out;
}

/* ---------- 检测规则 ---------- */

/* 内部取证语言：出现在用户文案里就是错位 */
const FORBIDDEN = [
	{ re: /实测[（(]\s*20\d\d-\d\d-\d\d/, why: '带日期的实测标注（版本考据）' },
	{ re: /手册\s*\d+\s*条/, why: '手册条数（取证口径）' },
	{ re: /\bNXDOMAIN\b/, why: 'DNS 返回码（排障术语）' },
	{ re: /\bmnc\d{3}\b/, why: '探针构造的 PLMN（内部对照）' },
	{ re: /REFERENCE/, why: '指向开发记忆文档' },
	{ re: /详见\s*REF/, why: '指向开发记忆文档' }
];

function scanViolations(strings) {
	const hits = [];
	for (const s of strings) {
		for (const rule of FORBIDDEN) {
			if (rule.re.test(s.text)) {
				hits.push({ line: s.line, why: rule.why, text: s.text.slice(0, 80) });
			}
		}
	}
	return hits;
}

/* 中文长度上限：单条字符串超过就是「又贴了一段」 */
const MAX_CN = 100;
function cnLen(str) {
	const m = str.match(/[\u4e00-\u9fff]/g);
	return m ? m.length : 0;
}

/* ---------- ③ 先证明检测器本身有效（红线 16：守卫也要能红） ---------- */

const SELF_SAMPLE = [
	'实测（2026-10-22）：USB 六个接口没有 Audio Class',
	'手册 244 条命令没有音频数据通道',
	'正常说明'
].map(function (t, i) { return { text: t, line: i + 1 }; });

const selfHits = scanViolations(SELF_SAMPLE);
ok('检测器能抓到「带日期的实测标注」',
	selfHits.some(function (h) { return h.why.indexOf('实测标注') >= 0; }),
	'检测规则失效 —— 后面的「无违规」结论都不可信');
ok('检测器能抓到「手册条数」',
	selfHits.some(function (h) { return h.why.indexOf('手册条数') >= 0; }));
ok('检测器不误伤正常文案',
	scanViolations([{ text: '这一页只管信令，通话内容听不到', line: 1 }]).length === 0);

/* 词法扫描器也要自证：注释里的违规词必须被跳过 */
const LEX_SAMPLE = [
	'/* 实测（2026-10-22）写在注释里是允许的，mnc999 也是 */',
	'// 手册 244 条 同样允许',
	'var a = \'真正的文案\';'
].join('\n');
const lexed = extractStrings(LEX_SAMPLE);
ok('词法扫描跳过注释、只取字符串',
	lexed.length === 1 && lexed[0].text === '真正的文案',
	'取到 ' + lexed.length + ' 条：' + JSON.stringify(lexed.map(function (x) { return x.text; })));

/* ---------- 逐文件扫 ---------- */

const files = [];
for (const d of DIRS) {
	if (!fs.existsSync(d)) continue;
	for (const f of fs.readdirSync(d)) {
		if (f.endsWith('.js')) files.push(path.join(d, f));
	}
}
ok('扫到了 UI 源文件', files.length >= 10, '只找到 ' + files.length + ' 个');

const perFile = [];
let allViol = [];
const tooLong = [];

for (const p of files) {
	const src = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
	const strings = extractStrings(src);
	perFile.push({ file: path.basename(p), count: strings.length });

	const hits = scanViolations(strings);
	for (const h of hits) allViol.push({ file: path.basename(p), line: h.line, why: h.why, text: h.text });

	for (const s of strings) {
		if (cnLen(s.text) > MAX_CN) {
			tooLong.push({ file: path.basename(p), line: s.line, len: cnLen(s.text), text: s.text.slice(0, 70) });
		}
	}
}

/*
 * 不要求「每个文件都取到」：jsqr.js 是第三方 QR 库、smsEncode.js 是编码表、
 * compat.js 是兼容层，本来就没有中文字符串。只要求整体规模够 —— 否则
 * 扫描器空跑也会「零违规」通过。
 */
const totalStrings = perFile.reduce(function (a, x) { return a + x.count; }, 0);
const nonEmptyFiles = perFile.filter(function (x) { return x.count > 0; }).length;
ok('词法扫描规模正常（没有空跑）',
	totalStrings >= 100 && nonEmptyFiles >= 8,
	'取到 ' + totalStrings + ' 条、涉及 ' + nonEmptyFiles + ' 个文件' +
	'（空跑时「零违规」不可信）');

/* ---------- ①② 两条硬契约 ---------- */

ok('UI 字符串里没有内部取证语言（实测日期 / 手册条数 / NXDOMAIN / mnc999 / REFERENCE）',
	allViol.length === 0,
	allViol.length ? '违规 ' + allViol.length + ' 处：\n      ' +
		allViol.map(function (v) { return v.file + ':' + v.line + ' 「' + v.why + '」 ' + v.text; }).join('\n      ') : '');

ok('单条 UI 中文字符串不超过 ' + MAX_CN + ' 字（界面不是实验记录）',
	tooLong.length === 0,
	tooLong.length ? '超长 ' + tooLong.length + ' 处：\n      ' +
		tooLong.map(function (v) { return v.file + ':' + v.line + ' ' + v.len + ' 字 「' + v.text + '…」'; }).join('\n      ') : '');

/* ---------- ④ 关键告知不能被精简掉 ---------- */

const voiceSrc = fs.readFileSync(path.join(DIRS[1], 'voice_call.js'), 'utf8');
ok('语音页仍常驻「听不到声音」告知（精简不等于删掉）',
	voiceSrc.includes('通话内容听不到'));

const readme = path.join(ROOT, 'README.md');
ok('README 有「已知限制」章节承接被移出界面的依据',
	fs.existsSync(readme) && fs.readFileSync(readme, 'utf8').includes('## 已知限制'));

/* ---------- 汇总 ---------- */

if (fails.length) {
	console.log('UI 文案契约测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
	fails.forEach(function (f) { console.log(f); });
	process.exit(1);
}
console.log('UI 文案契约：全部通过（' + pass + ' 项断言）');
