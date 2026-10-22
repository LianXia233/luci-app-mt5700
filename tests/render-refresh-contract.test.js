#!/usr/bin/env node
'use strict';

/**
 * 渲染与刷新链契约测试
 *
 * 钉住三个「不报错、但功能静默失效」的坑，它们都是真实踩过一次的：
 *
 *   ① **QCI 永远显示「未知」**
 *      state.qci 在 getQCI() 里赋值，而 renderConn() 只在 getAMBR() 末尾和页面
 *      初始化时调用过。慢档顺序是 … getAMBR → getQCI → …，getQCI 在渲染之后才写
 *      值，且它后面再没有任何重渲染 → QCI 永远停在初始值「未知」。
 *      真机 AT+CGEQOSRDP 其实有数据（1,6 / 5,5），纯粹是渲染时机问题。
 *
 *   ② **刷新只会跑一次**
 *      `chain.catch(fn)` 换行接着写 `then(fn)`（中间漏了点号）不会报语法错：
 *      ASI 会插分号，于是 `then(fn)` 变成一行永不到达的死代码，
 *      refreshing / slowRefreshing 再也不会复位 → 首屏之后数据永不更新。
 *      这类写法必须全项目禁止。
 *
 *   ③ **已发短信排到回复后面**
 *      收到的短信用短信中心时间（SCTS），已发短信若取「发送完成」时刻，
 *      AT+CMGS 的耗时会把本地时间推到对方回复之后，表现为 10086 的回复
 *      反而排在发出的「套餐」前面。时间戳必须在点下发送那一刻就固定。
 *
 * 用法：node tests/render-refresh-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATUS_JS = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver/network_status.js');
const SMS_JS = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver/sms_center.js');
const RES_DIR = path.join(ROOT, 'htdocs/luci-static/resources');

const statusJs = fs.readFileSync(STATUS_JS, 'utf8');
const smsJs = fs.readFileSync(SMS_JS, 'utf8');

let pass = 0;
const fails = [];

function ok(name, cond, detail) {
	if (cond) {
		pass++;
	} else {
		fails.push(name + (detail ? ' —— ' + detail : ''));
	}
}

/** 从源码里按括号配对摘出某个具名函数的完整定义 */
function extractFunction(src, signature) {
	const start = src.indexOf('function ' + signature);
	if (start < 0) return '';
	let depth = 0;
	for (let i = src.indexOf('{', start); i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	return '';
}

/** 递归收集目录下所有 .js */
function collectJs(dir) {
	const out = [];
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) out.push(...collectJs(p));
		else if (name.endsWith('.js')) out.push(p);
	}
	return out;
}

/* ---------- ① QCI 渲染时机 ---------- */

const getQci = extractFunction(statusJs, 'getQCI()');
ok('能定位到 getQCI 函数定义', getQci.length > 0);
ok('getQCI 确实写入了 state.qci', /state\.qci\s*=/.test(getQci));
ok('getQCI 写完 state.qci 后必须重渲染连接状态面板（否则 QCI 永远「未知」）',
	/renderConn/.test(getQci), '当前 getQCI 内没有 renderConn');

/* renderConn 必须定义在 getQCI 之前可引用（函数声明提升，这里只确认它存在） */
ok('renderConn 函数存在', /function renderConn\(\)/.test(statusJs));

/* ---------- ② 刷新链不能出现漏点号的 then ---------- */

/*
 * 钉的是「复位语句必须挂在链的 .then 回调里」这一性质，而不是某一种拼接文本：
 * 早先精确匹配 `.then(function () { refreshing = false; });`，后来复位语句里
 * 多了一句（同时清在跑的那一轮 promise），断言就误报了 —— 而复位其实好端端
 * 地在 .then 里。漏掉复位的后果是刷新标志永久为真、此后所有刷新都空转，
 * 这才是这条断言真正要守的东西。
 */
ok('快档刷新链把复位语句串在 then 回调里',
	/\.then\(function \(\) \{[^}]*fastRunning = null/.test(statusJs),
	'fastRunning 复位必须挂在 .then 回调里，否则撞车互斥失效（refreshing 死变量已删，F-B5）');
ok('慢档刷新链把复位语句串在 then 回调里',
	/\.then\(function \(\) \{[^}]*slowRunning = null/.test(statusJs),
	'slowRunning 复位必须挂在 .then 回调里，否则撞车互斥失效（slowRefreshing 死变量已删，F-B5）');

const jsFiles = collectJs(RES_DIR);
const bareThen = [];
for (const f of jsFiles) {
	const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
	lines.forEach((line, i) => {
		/* 行首只有空白后紧跟 then( —— 这是 .catch() 漏点号的典型形态，
		   会被 ASI 切成永不到达的死代码，语法检查还发现不了。 */
		if (/^\s*then\s*\(/.test(line)) bareThen.push(path.relative(ROOT, f) + ':' + (i + 1));
	});
}
ok('前端不存在「漏点号」的裸 then() 调用（会被 ASI 变成死代码）', bareThen.length === 0,
	bareThen.join(', '));

/* ---------- ③ 已发短信的时间戳口径 ---------- */

const sendFn = extractFunction(smsJs, 'send(');
ok('能定位到 send 函数定义', sendFn.length > 0);
ok('发送时先固定发起时刻', /var sentAt\s*=\s*nowTimeStr\(\);/.test(sendFn),
	'没有 var sentAt = nowTimeStr();');
ok('已发短信使用发起时刻而不是发送完成时刻', /time:\s*sentAt,/.test(smsJs),
	'仍在使用 time: nowTimeStr()');
ok('全文件不再出现 time: nowTimeStr()', !/time:\s*nowTimeStr\(\),/.test(smsJs));
ok('发起时刻的取值早于发送链路的构造',
	sendFn.indexOf('var sentAt') >= 0 && sendFn.indexOf('var chain') >= 0 &&
	sendFn.indexOf('var sentAt') < sendFn.indexOf('var chain'),
	'sentAt 必须在 chain 之前定义');

/* ---------- 汇总 ---------- */

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach((f, i) => console.log('  ✗ ' + (i + 1) + '. ' + f));
	process.exit(1);
}
console.log('渲染与刷新链契约测试全部通过');
