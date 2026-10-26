#!/usr/bin/env node
'use strict';

/**
 * 自愈契约（2026-10-26）
 * ============================================================================
 * 背景：用户要求「出现意外时能自愈」。但这个插件在 2026-09-20 **主动删掉过看门狗**，
 * 原因是「自动动作本身也是断网源」。所以自愈要回来，边界必须写死：
 *
 *   ① 只修自家组件：AT 服务（at-webserver）、rpcd 的 ucode 插件注册。
 *      **绝不能**动 network / wireless / firewall / ifup / wifi reload。
 *   ② 必须有限额：连续失败才动手 + 动作冷却 —— 否则会把 eSIM 写卡、短信发送
 *      这类正常长操作误判成故障，越修越坏。
 *   ③ 用户主动停用（uci enabled=0）时一律不动手。
 *   ④ 手动模式（经 rpcd 调用）不许重启 rpcd —— 那等于让处理本次请求的进程自杀。
 *
 * 用法：node tests/selfheal-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INIT = path.join(ROOT, 'root/etc/init.d/at-webserver');
const UCI_DEFAULTS = path.join(ROOT, 'root/etc/uci-defaults/at-webserver');
const UCODE = path.join(ROOT, 'root/usr/share/rpcd/ucode/mt5700.uc');
const ACL = path.join(ROOT, 'root/usr/share/rpcd/acl.d/luci-app-mt5700.json');
const MT = path.join(ROOT, 'htdocs/luci-static/resources/at-webserver/mt5700.js');
const RPC = path.join(ROOT, 'htdocs/luci-static/resources/at-webserver/rpc.js');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
	if (cond) { pass++; console.log('  ok   ' + name); }
	else { fails.push(name + (detail ? ' :: ' + detail : '')); console.log('  ✗ ' + name + (detail ? '\n       ' + detail : '')); }
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

/* 取出 selfheal() 函数体：边界检查只针对它，别被文件其它部分的注释带偏 */
function extractFn(src, marker) {
	const a = src.indexOf(marker);
	if (a < 0) return '';
	let depth = 0, begun = false;
	for (let i = a; i < src.length; i++) {
		if (src[i] === '{') { depth++; begun = true; }
		else if (src[i] === '}') { depth--; if (begun && depth === 0) return src.slice(a, i + 1); }
	}
	return src.slice(a);
}

console.log('== 1. init.d 自愈入口 ==');

const init = read(INIT);
const body = extractFn(init, 'selfheal() {');
ok('存在 selfheal() 入口', body.length > 0, 'init.d 里找不到 selfheal()');
ok('支持 --auto（cron 用）与默认手动模式', /--auto/.test(body) && /mode="manual"/.test(body));

/* ★ 边界：只碰自家组件 */
const forbidden = ['wifi', 'wireless', 'network restart', 'ifup', 'ifdown', 'firewall'];
const hit = forbidden.filter((w) => new RegExp(w, 'i').test(body));
ok('★ 只修自家组件：不碰 wifi/无线/网络/ifup/防火墙',
	hit.length === 0,
	'发现越界动作：' + hit.join(', '));

ok('允许的动作只有 at-webserver 与 rpcd 重启',
	/etc\/init\.d\/at-webserver restart/.test(body) && /etc\/init\.d\/rpcd restart/.test(body));

console.log('== 2. 限额与保护 ==');

ok('auto 模式要求连续失败 ≥2 次才动手', /"\$fail" -lt 2/.test(body),
	'单次失败就重启 —— eSIM 写卡/短信这类长操作会被误判成故障');
ok('10 分钟动作冷却（600s）', /-lt 600/.test(body));
ok('rpcd 重启单独 30 分钟冷却（1800s）', /-lt 1800/.test(body));
ok('用户主动停用（enabled=0）时不动手',
	/enabled.*= "0"|config\.enabled/.test(body) && /return 0/.test(body));
ok('经 rpcd 调用时不许重启 rpcd（否则等于处理本次请求的进程自杀）',
	/if \[ "\$mode" != "auto" \]; then[\s\S]{0,260}?return 1/.test(body),
	'非 auto 模式下仍可能重启 rpcd');
/*
 * ★ 2026-10-26 真机踩到：脚本经 ubus 被调用时自己就跑在 rpcd 里，此时再
 *   `ubus call mt5700 at` 是让**单线程的 rpcd 等自己** → 必然超时 → 把
 *   「一切正常」误判成「AT 坏了」并白重启一次（CLI 说正常、ubus 说已重启）。
 */
ok('★ --from-ubus 模式跳过嵌套 ubus 探测（避免 rpcd 自己等自己）',
	/--from-ubus/.test(body) && /"\$mode" != "ubus"/.test(body),
	'经 rpcd 调用时仍会嵌套 ubus call');
ok('ucode 侧传 --from-ubus', /selfheal --from-ubus/.test(read(UCODE)),
	'ucode 没传 --from-ubus，手动修复会误判并重启服务');
ok('每个动作都写 logger（事后可审计）', (body.match(/logger -t at-webserver/g) || []).length >= 3);
ok('探测带超时（用随包限时器，ubus call 自身无超时）',
	/\/usr\/share\/mt5700\/to/.test(body) || /timeout/.test(body));

console.log('== 3. cron 落地 ==');

const ud = read(UCI_DEFAULTS);
ok('uci-defaults 挂 cron', /at-webserver selfheal --auto/.test(ud));
ok('cron 落地是幂等的（先 grep 再追加）', /grep -q 'at-webserver selfheal --auto'/.test(ud));
ok('每 5 分钟一次', /\*\/5 \* \* \* \*/.test(ud));

console.log('== 4. ubus 方法 + ACL ==');

const ucode = read(UCODE);
ok('ucode 注册 mt5700.selfheal', /\n\t\tselfheal: \{/.test(ucode));
ok('selfheal 方法调用 init.d 入口', /\/etc\/init\.d\/at-webserver selfheal/.test(ucode));

const acl = JSON.parse(read(ACL))['luci-app-mt5700'];
ok('ACL read 段放行 selfheal', (acl.read.ubus.mt5700 || []).indexOf('selfheal') >= 0);
ok('ACL write 段放行 selfheal（它会重启服务）', (acl.write.ubus.mt5700 || []).indexOf('selfheal') >= 0);

console.log('== 5. 前端：SIM 状态区分与自愈触发 ==');

const mt = read(MT);
const simFn = extractFn(mt, 'function refreshSimStatus() {');
const readFn = extractFn(mt, 'function readSimsq(attempt) {');

ok('区分「读取失败」与「未知」', /'读取失败'/.test(simFn) && /'未知'/.test(simFn),
	'读不到和解析不出显示同一个词 —— 违背红线 23');
ok('读失败后有一次快速重试', /attempt < 2/.test(readFn) && /setTimeout/.test(readFn));
ok('连续失败才自愈（阈值 ≥3）', /simFail < 3/.test(mt));
ok('自愈有 5 分钟冷却', /5 \* 60 \* 1000/.test(mt));
ok('自愈后补读一次', /setTimeout\(refreshSimStatus/.test(mt));
ok('rpc.js 声明了 selfheal 方法并导出', /method: 'selfheal'/.test(read(RPC)) && /selfHeal: runSelfHeal/.test(read(RPC)));

/* 反向：把边界改坏必须判红 */
const bad = body.split('/etc/init.d/at-webserver restart').join('wifi reload');
ok('反向：selfheal 里塞入 wifi reload 必须判红',
	/restart/.test(bad) ? forbidden.some((w) => new RegExp(w, 'i').test(bad)) : false,
	'越界检查无效');

console.log('');
if (fails.length === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fails.length + ' 项失败 / 共 ' + (pass + fails.length) + ' 项');
fails.forEach((f) => console.log('  ✗ ' + f));
process.exit(1);
