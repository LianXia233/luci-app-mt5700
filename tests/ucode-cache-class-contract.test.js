/*
 * 静态断言：ucode 侧读缓存分类（P03 / P05 / P08）
 * ----------------------------------------------------------------------------
 * 本机起不了 rpcd，只能解析源码文本。这三条的共同点是「写错一个字符就永不命中」，
 * 运行时毫无症状，靠人眼复查必漏，所以钉死在这里。
 *
 * 每条都有**反向验证**：把改动前的旧文本喂给同一个检查函数，必须判为不通过。
 * 报不了红就说明这个守卫根本没在检查（历史上出过这种事故）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');
let pass = 0;
const fails = [];
function ok(name, cond, detail) {
	if (cond) { pass++; }
	else { fails.push(detail ? name + ' :: ' + detail : name); }
}

/* 取出 `const NAME = [...]` 的数组字面量文本 */
function arrayLiteral(src, name) {
	const i = src.indexOf('const ' + name + ' = [');
	if (i < 0) return null;
	const s = src.indexOf('[', i);
	const e = src.indexOf(']', s);
	if (s < 0 || e < 0) return null;
	return src.slice(s, e + 1);
}

const src = fs.readFileSync(SRC, 'utf8');

/* ---------------- P03：ICCID 不能留在「不变类」 ---------------- */
const statics = arrayLiteral(src, 'STATIC_READS');
ok('P03 STATIC_READS 解析得到', statics !== null, '没找到 STATIC_READS 数组');
ok('P03 STATIC_READS 不含 AT^ICCID?（换卡 / 切 profile 会变）',
	statics !== null && !/AT\^ICCID\?/.test(statics),
	'AT^ICCID? 仍在 STATIC_READS 里，换 profile 后最长陈旧 5 分钟');
ok('P03 其余不变类仍在（ATI / 型号 / 固件 / IMEI / PHYNUM / VERSION）',
	statics !== null
	&& /'ATI'/.test(statics) && /'AT\+CGMM'/.test(statics) && /'AT\+CGMR'/.test(statics)
	&& /'AT\+CGSN'/.test(statics)
	&& /'AT\^PHYNUM\?'/.test(statics) && /'AT\^VERSION\?'/.test(statics),
	'移出 ICCID 时误删了其它不变类');
/* B10（2026-10-22 审计）：IMSI 与 ICCID 同判据 —— 随卡变，不进静态档。 */
ok('B10 AT+CIMI 已移出静态档（IMSI 随卡变，换卡后 300s 旧值）',
	statics !== null && !/'AT\+CIMI'/.test(statics),
	'AT+CIMI 不该再出现在 STATIC_READS');
/* 反向：含 ICCID 的旧数组必须被同一检查判红 */
const oldStatics = "const STATIC_READS = [\n\t'ATI', 'AT+CGMM', 'AT+CGMR', 'AT+CGSN', 'AT+CIMI', 'AT+CGMI',\n\t'AT^ICCID?', 'AT^PHYNUM?', 'AT^VERSION?'\n];";
ok('P03 反向：旧数组（含 AT^ICCID?）被同一检查判为不通过',
	/AT\^ICCID\?/.test(arrayLiteral(oldStatics, 'STATIC_READS') || ''),
	'旧数组竟被判为通过，检查函数无效');

/* ---------------- P08：NEVER_CACHE 的命令名必须真能命中 ---------------- */
const never = arrayLiteral(src, 'NEVER_CACHE');
ok('P08 NEVER_CACHE 解析得到', never !== null, '没找到 NEVER_CACHE 数组');
ok('P08 NEVER_CACHE 含 AT+SMSJOB（与 rpcserver.rs:49 / sms_center.js:476 一致）',
	never !== null && /'AT\+SMSJOB'/.test(never),
	'NEVER_CACHE 里没有 AT+SMSJOB，read_cache_ttl>0 时短信作业状态会被缓存');
ok('P08 NEVER_CACHE 不再含笔误的 AT^SMSJOB',
	never !== null && !/AT\^SMSJOB/.test(never),
	'仍保留 AT^SMSJOB（脱字符），前缀匹配永不命中');
/* 反向：旧文本既不含正确的 AT+SMSJOB，又含笔误 —— 必须两条都判红 */
const oldNever = "const NEVER_CACHE = ['AT^CELLSCAN', 'AT^SMSJOB', 'AT^FOTA', 'AT^FWUP', 'AT+CMG'];";
const oldNeverArr = arrayLiteral(oldNever, 'NEVER_CACHE') || '';
ok('P08 反向：旧 NEVER_CACHE 被判为不通过（缺 AT+SMSJOB 且含笔误）',
	!/'AT\+SMSJOB'/.test(oldNeverArr) && /AT\^SMSJOB/.test(oldNeverArr),
	'旧文本竟被判为通过，检查函数无效');

/* ---------------- P05：清缓存只能由「确认写命令」触发 ---------------- */
ok('P05 cacheClear() 位于写命令判断之内（含 = 且不是 =? 测试命令）',
	/if \(eqIdx >= 0 && substr\(cmd, eqIdx \+ 1, 1\) != '\?'\)[\s\S]{0,300}?cacheClear\(\);/.test(src),
	'cacheClear() 仍是无条件执行，纯读命令会把整份缓存删光');
ok('P05 不再是「cls == 0 就清」的直通写法',
	!/if \(cls > 0\)[\s\S]*?\n\t\}\n\tcacheClear\(\);/.test(src),
	'仍是 cls==0 直通 cacheClear 的旧结构');
/* 反向：改动前的旧片段必须被同一检查判红 */
const oldAtCall = "\t/* 写命令（或后端状态类命令）：清掉读缓存，避免\"保存后读回旧值\" */\n\tcacheClear();\n\treturn rpcCall('at', { cmd: cmd });";
ok('P05 反向：旧的无条件 cacheClear 片段被判为不通过',
	!/if \(eqIdx >= 0/.test(oldAtCall),
	'旧片段竟被判为通过，检查函数无效');

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	fails.forEach(function (f) { console.log('  ✗ ' + f); });
	process.exit(1);
}
process.exit(0);
