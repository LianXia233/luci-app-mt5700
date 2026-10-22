#!/usr/bin/env node
/*
 * VoWiFi 能力评估契约测试（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 2026-09-24：VoWiFi 能不能用，取决于五道门，ePDG 只是其中一道：
 *     卡身份（MCC/MNC）→ IMS 身份（IMPI）→ AKA 就绪 → ePDG 发布 → IMS 已注册
 * 本文件守的是「判据有没有被绕开」，不是「功能在不在」。
 *
 * 为什么必须单独一个测试文件：
 *   这条判定跨四个文件（ucode 方法 / ACL / rpc 声明 / 前端渲染），而且它的
 *   **结论形态是负面的** —— 绝大多数卡会拿到「不成立」。这种结论最容易被
 *   写歪：查不到就说没发布，等于把「本机 DNS 坏了」也算到运营商头上；
 *   「卡上没有 ISIM」被写成「有 ISIM」，等于凭空造证据。
 *
 * 本测试覆盖：
 *   ① ucode vowifi：args 为空（无用户输入面）、域名由常量拼、拼前过 safeEpdgFqdn
 *   ② ★ 阳性对照门禁：阳性对照都查不到时，ePDG 必须是 unknown，
 *      不许落「该运营商未发布」（这是本功能最容易写歪的一处）
 *   ③ 四态判定：available / polluted / not_published / unknown 各自成立，
 *      且「读不出来」不许并进「没有」（红线 23）
 *   ④ AT+CIMI 必须走 fresh：它在 STATIC_READS 里缓存 300s，换卡后不 fresh
 *      会拿上一张卡的 IMSI 拼出上一张卡的域名（红线 24 同型事故）
 *   ⑤ ★ EF_DIR / IMPI / AKA 实测能力三件套（本轮新增，全部有真机实测依据）
 *   ⑥ 五道门与阻断清单齐全、ACL / rpc.js / 前端文案对齐
 *   ⑦ 真机取值回归（2026-09-24 实测，中国移动卡 + 三组对照）
 *   ⑧ ★ 触发方式契约（2026-09-27 用户口径「改成不自动进行」）：五道门只由
 *      「评估 VoWiFi」按钮触发，进页面与点「刷新」都不许自动跑；但开关的
 *      当前值单独用一条只读 AT^IMSSWITCH? 保证是真值（读不到则显示未知）
 *
 * 运行：node tests/vowifi-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UCODE = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');
const ACL = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'acl.d', 'luci-app-mt5700.json');
const RPC = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');
/*
 * ★ 2026-09-24 迁页：VoWiFi 是「能开的功能」，属于**模组设置**页（那页全是开关与下发），
 *   不再挂在「网络状态」（那页全是读数）。这里读的是新宿主；另加反向断言，
 *   保证旧宿主里不留残骸 —— 两页都渲染同一张卡是最难发现的一类重复。
 */
const VIEW = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'modem_settings.js');
const OLD_VIEW = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');

const ucSrc = fs.readFileSync(UCODE, 'utf8');
const aclSrc = fs.readFileSync(ACL, 'utf8');
const rpcSrc = fs.readFileSync(RPC, 'utf8');
const viewSrc = fs.readFileSync(VIEW, 'utf8');
const oldViewSrc = fs.readFileSync(OLD_VIEW, 'utf8');

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return true; }
	fails.push('  ✗ ' + name + (hint ? '\n      ' + hint : ''));
	return false;
}
function eq(name, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; return true; }
	fails.push('  ✗ ' + name + '\n      实际: ' + g + '\n      期望: ' + w);
	return false;
}

/* 按括号配对抠出整个函数（改名请同步本测试） */
function grab(name, src) {
	const i = src.indexOf('function ' + name + '(');
	if (i < 0) throw new Error('源码里找不到函数 ' + name + '（改名请同步本测试）');
	let depth = 0, started = false;
	for (let j = i; j < src.length; j++) {
		const c = src[j];
		if (c === '{') { depth++; started = true; }
		else if (c === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
	}
	throw new Error('函数体括号不配对：' + name);
}

/*
 * 去注释后的纯代码（实现与 tests/esim-contract.test.js 的 stripComments 同一份）。
 *
 * ★ 为什么必须有它：⑧ 那组断言查的是「某个调用点在不在了」，
 *   而**说明注释里必然要引用那个调用点的旧写法**（改动的来龙去脉就写在那儿）。
 *   不做这一步判定，守卫会被自己的注释顶住 —— 今天已经踩过一次同型的
 *   （说明注释把一个 po 孤儿「洗白」了）。
 */
function stripComments(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/* ucode 与 JS 在这几个函数上语法一致（length()/substr() 是注入的），直接 eval 跑真逻辑。
   常量从源码里抠出来一起注入 —— 断言的是**源码里那个真实值**，不是这里另抄一份。 */
const L = (x) => x.length;
const S = (s, a, b) => s.substr(a, b);
const T = (s) => String(s).trim();
const IX = (h, n) => String(h).indexOf(n);

function constStr(re) { return (ucSrc.match(re) || [])[1]; }
const EPDG_PREFIX = constStr(/const EPDG_PREFIX = '([^']+)';/);
const EPDG_SUFFIX = constStr(/const EPDG_SUFFIX = '([^']+)';/);
const HEX_UP = constStr(/const HEX_UP = '([^']+)';/);
const HEX_LO = constStr(/const HEX_LO = '([^']+)';/);
const CSIM_MAX_HEX = Number(constStr(/const CSIM_MAX_HEX = (\d+);/));
const AKA_AUTH_HEX = Number(constStr(/const AKA_AUTH_HEX = (\d+);/));
const ASCII_LIT = constStr(/const ASCII_VISIBLE = ("(?:[^"\\]|\\.)*");/);
const ASCII_VISIBLE = ASCII_LIT ? JSON.parse(ASCII_LIT) : null;

ok('能从源码抠出 EPDG_PREFIX / EPDG_SUFFIX（改名请同步本测试）',
	EPDG_PREFIX === 'epdg.epc.' && EPDG_SUFFIX === '.pub.3gppnetwork.org');
ok('能从源码抠出 HEX 表与 ASCII 可见字符表',
	HEX_UP === '0123456789ABCDEF' && HEX_LO === '0123456789abcdef'
	&& ASCII_VISIBLE != null && ASCII_VISIBLE.length === 95,
	'ASCII_VISIBLE 长度应为 95（0x20~0x7E）');

/* ucode 的 length()/substr()/trim()/index() 都是内置，这里注入同义实现即可
   （index(h, n) ≡ JS 的 h.indexOf(n)） */
function ucFn(names, entry) {
	const bodies = names.map((n) => grab(n, ucSrc)).join('\n');
	const src = 'return function(length, substr, trim, index, EPDG_PREFIX, EPDG_SUFFIX) {'
		+ 'const HEX_UP = ' + JSON.stringify(HEX_UP) + ';'
		+ 'const HEX_LO = ' + JSON.stringify(HEX_LO) + ';'
		+ 'const ASCII_VISIBLE = ' + JSON.stringify(ASCII_VISIBLE) + ';'
		+ 'const CSIM_MAX_HEX = ' + JSON.stringify(CSIM_MAX_HEX) + ';'
		+ 'const AKA_AUTH_HEX = ' + JSON.stringify(AKA_AUTH_HEX) + ';'
		+ bodies + '\n; return ' + entry + '; };';
	// eslint-disable-next-line no-new-func
	return new Function(src)();
}
/* 先注入 ucode 的那几个内置（length/substr/trim/index + 常量），再传业务参数 */
const run = (fn, ...args) => fn(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)(...args);

/* ---------- 1. ucode：注入面必须封死 ---------- */

ok('ucode 注册了 mt5700.vowifi', /\bvowifi: \{/.test(ucSrc));
ok('★ vowifi 不接受任何入参（args 为空 → 没有命令注入面）',
	/vowifi: \{\s*\n\s*args: \{\},/.test(ucSrc));
ok('★ ePDG 域名由前缀/后缀常量拼装（不是 req 里的字符串）',
	/const EPDG_PREFIX = 'epdg\.epc\.';/.test(ucSrc)
	&& /const EPDG_SUFFIX = '\.pub\.3gppnetwork\.org';/.test(ucSrc));
ok('★ DNS 服务器写死在常量里（不接受外部传入）',
	/const EPDG_DNS = \['223\.5\.5\.5', '114\.114\.114\.114'\];/.test(ucSrc));
/*
 * ★ 阳性对照why换成 AT&T（mnc280.mcc310）：原先用 T-Mobile（mnc260），但那是
 *   「听说它开了 VoWiFi」；AT&T 是**本机实测过**的 —— 2026-09-24 经 DoH 解析出
 *   真实公网地址 107.122.31.31。对照组的意义是「证明这条链路能查到真东西」，
 *   没实测过的对照组证明不了任何事。
 */
ok('★ 对照组域名是常量（阳性对照不能被请求带偏）',
	/const EPDG_POS_FQDN = 'epdg\.epc\.mnc280\.mcc310\.pub\.3gppnetwork\.org';/.test(ucSrc));

/* safeEpdgFqdn：拼进 shell 前的最后一道闸 */
const safeFqdn = ucFn(['safeEpdgFqdn'], 'safeEpdgFqdn');
ok('safeEpdgFqdn 放行标准 ePDG 域名',
	run(safeFqdn, 'epdg.epc.mnc000.mcc460.pub.3gppnetwork.org')
	=== 'epdg.epc.mnc000.mcc460.pub.3gppnetwork.org');
ok('★ safeEpdgFqdn 拒绝命令注入（分号 + 空格 + 反引号一律挡掉）',
	run(safeFqdn, 'epdg.epc.mnc000.mcc460.pub.3gppnetwork.org; rm -rf /') === null);
ok('★ safeEpdgFqdn 拒绝不是 ePDG 形状的其他域名',
	run(safeFqdn, 'www.baidu.com') === null);
ok('★ safeEpdgFqdn 拒绝空串与超短串',
	run(safeFqdn, '') === null && run(safeFqdn, 'epdg') === null);
/*
 * ★★ 下面两条是**专为穿过长度检查**设计的：长度必须落在 32~80 之间，
 *   否则会被 length 那一关先挡下 —— 前缀/后缀的形状校验就算被改坏也测不出来。
 *   2026-09-24 变异验证时这条真被放过过一次：当时只有 www.baidu.com 这种短串，
 *   去掉前缀校验后它仍被 length 挡住，变异判不出来（红线 16：写了守卫 ≠ 有了守卫）。
 */
ok('★★ 前缀不对但长度合规的域名也要挡',
	run(safeFqdn, 'www.baidu.com.evil.example.pub.3gppnetwork.org') === null);
ok('★★ 后缀不对但长度合规的域名也要挡',
	run(safeFqdn, 'epdg.epc.mnc000.mcc460.attacker.example.com') === null);

/* ---------- 1b. nslookup 输出解析（★ 真机格式回归） ----------
 *
 * 2026-09-24 真机踩坑：busybox nslookup 的开头两行是
 *     Server:\t223.5.5.5
 *     Address:\t223.5.5.5:53        ← 带端口
 * 它是**输入**不是结果，而且 "223.5.5.5:53" 与传入的 dns 常量并不相等 ——
 * 用「值 != dns」过滤根本滤不掉。上线第一版就栽在这里：必然不存在的 mnc999
 * 也「解析到了地址」，总判定恒为 available，最关键的结论被反过来说。
 *
 * 所以下面三条断言用的都是**真机抓下来的输出格式**，不是想象的格式。
 */
const pick = ucFn(['nsPickAddrs'], 'nsPickAddrs');
const NS_SRV = ['Server:\t223.5.5.5', 'Address:\t223.5.5.5:53'];
eq('★★ NXDOMAIN 输出（真机格式）一个地址都不产生',
	run(pick, NS_SRV.concat(['', "** server can't find epdg.epc.mnc000.mcc460.pub.3gppnetwork.org: NXDOMAIN"]),
		'223.5.5.5'), []);
eq('★★ 阳性对照（真机格式）：Server 段被排除，只留真正的 A 记录',
	run(pick, NS_SRV.concat(['', 'Name:\tepdg.epc.mnc260.mcc310.pub.3gppnetwork.org',
		'Address 1: 198.51.100.9']),
		'223.5.5.5'), ['198.51.100.9']);
eq('★★ 阴性对照（真机格式）：只回 127.0.0.1 —— 通配污染的原貌',
	run(pick, NS_SRV.concat(['', 'Name:\tepdg.epc.mnc999.mcc460.pub.3gppnetwork.org',
		'Address 1: 127.0.0.1']),
		'223.5.5.5'), ['127.0.0.1']);

/* ---------- 2. 四态判定（可执行，用真机实测值回归） ---------- */

const epdgState = ucFn(['isLoopbackAddr', 'epdgState'], 'epdgState');

/* 2026-09-24 真机：中国移动卡（IMSI 460001234567890） */
eq('真机回归：本卡 ePDG 查不到 → not_published',
	run(epdgState, { addrs: [], nx: true, cname: '' }), 'not_published');
eq('真机回归：阳性对照解析到 208.54.39.163 → available',
	run(epdgState, { addrs: ['208.54.39.163'], nx: false, cname: '' }), 'available');
eq('真机回归：阴性对照 mnc999 只回 127.0.0.1 → polluted（不是真 ePDG）',
	run(epdgState, { addrs: ['127.0.0.1'], nx: false, cname: '' }), 'polluted');
eq('★ 读不出来必须独立成 unknown，不许并进「没有」',
	run(epdgState, { addrs: [], nx: false, cname: '' }), 'unknown');
eq('★ 探针本身没跑起来（null）也是 unknown', run(epdgState, null), 'unknown');
eq('IPv6 环回 ::1 同样判污染',
	run(epdgState, { addrs: ['::1'], nx: false, cname: '' }), 'polluted');
eq('★ 真地址与环回地址混合时，按「有真地址」判 available（不因混入假地址降级）',
	run(epdgState, { addrs: ['127.0.0.1', '182.239.118.1'], nx: false, cname: '' }), 'available');

const isLoop = ucFn(['isLoopbackAddr'], 'isLoopbackAddr');
ok('isLoopbackAddr 认 127.x', run(isLoop, '127.0.0.1') === true);
ok('isLoopbackAddr 认 ::1', run(isLoop, '::1') === true);
ok('★ isLoopbackAddr 不误杀 182.239.118.1（真机 CSL ePDG）', run(isLoop, '182.239.118.1') === false);

/* IMSI 提取：AT 应答里夹着 \r\nOK，只取第一段够长的数字串 */
const exImsi = ucFn(['extractImsi'], 'extractImsi');
eq('extractImsi 从「460001234567890\\r\\nOK」里取出 IMSI',
	run(exImsi, '460001234567890\r\nOK'), '460001234567890');
eq('★ extractImsi 遇到没有 IMSI 的应答返回空串（不许返回 OK 里的杂数）',
	run(exImsi, 'ERROR'), '');

/* ---------- 3. ★★ 阳性对照门禁（本功能最关键的一条判据） ---------- */

const factsBody = grab('epdgFacts', ucSrc);
ok('★★ 阳性对照查不到时，verdict 必须退回 unknown（不许把 DNS 故障说成运营商没发布）',
	/posCtl\.state != 'available'[\s\S]{0,200}?verdict = 'unknown';/.test(factsBody),
	'找不到「阳性对照失败 → verdict=unknown」的分支');
ok('★ 阳性对照必须真的参与判定（不能只是查了不看的装饰；B01 后包在预算 if 里）',
	/posCtl = epdgProbe\(safeEpdgFqdn\(EPDG_POS_FQDN\)\);/.test(factsBody)
	&& /let posCtl = \{ state: 'unknown' \};/.test(factsBody));
ok('★ 阳性对照组也要查一次（不是写死结论）',
	/posCtl: posCtl,/.test(factsBody));
ok('★ 阴性对照组（mnc999）也要查并返回（用来识别通配污染）',
	/negCtl = epdgProbe\(negFqdn\);/.test(factsBody) && /negCtl: negCtl,/.test(factsBody));

/* ---------- 4. AT+CIMI 必须 fresh（换卡后不能拿旧 IMSI） ---------- */

ok('★★ AT+CIMI 走 fresh（否则换卡后 300s 内拼出上一张卡的 ePDG 域名）',
	/rpcCall\('at', \{ cmd: 'AT\+CIMI', fresh: true \}\)/.test(ucSrc),
	'STATIC_READS 里 AT+CIMI 缓存 300 秒，不 fresh 就是红线 24 的同型事故');
ok('★ 读不到 IMSI 要明确报失败（不许拿空值继续拼域名）',
	/读不到 IMSI（AT\+CIMI 失败）/.test(factsBody) && /AT\+CIMI 的应答里没有 IMSI/.test(factsBody));

/* ---------- 5. MNC 长度不猜：两种解读都查 ---------- */

/*
 * ★ MNC 长度**不猜**（参考 VoCat：orchestrator 不猜 MNC 长度）。
 *   猜错会拼出一个必然 NXDOMAIN 的域名 —— 那等于把「我拼错了」报成「运营商没发布」。
 *   正确做法：问卡（EF_AD），问不出来退 EHPLMN，再问不出来才两种都查且如实标注。
 */
ok('★ MNC 长度先问卡（EF_AD），不是从 IMSI 猜',
	/let mncLen = readMncLength\(\);/.test(factsBody)
	&& /mncSource = 'ef_ad';/.test(factsBody));
ok('★ 卡上读不到 MNC 长度时退 EHPLMN，仍读不到才标 ambiguous 并两种都查',
	/mncSource = 'ehplmn';/.test(factsBody)
	&& /mncSource = 'ambiguous';/.test(factsBody)
	&& /let m2 = substr\(imsi, 3, 2\);/.test(factsBody)
	&& /let m3 = substr\(imsi, 3, 3\);/.test(factsBody));
ok('★ 3GPP 标准写法（MNC 补零到三位）与两位变体都要构造（参考 alternate3GPPHostname）',
	/r\.label = '标准写法（mnc' \+ m3 \+ '）';/.test(factsBody)
	&& /r\.label = '两位变体（mnc' \+ substr\(m3, 1\) \+ '）';/.test(factsBody));

/* ---------- 5b. DoH 地理回退（参考 VoCat resolveEPDG） ---------- */

const probeBody = grab('epdgProbe', ucSrc);
ok('★★ 系统 DNS 没给出 available 时，要换 DoH 再问一次（单条链路的结论可能正好说反）',
	/let d = dohLookup\(fqdn, EPDG_ECS\);/.test(probeBody));
ok('★ DoH 要带归属国的 EDNS Client Subnet（ePDG 权威 DNS 常只对归属国解析器给答案）',
	/edns_client_subnet=/.test(ucSrc) && /const EPDG_ECS = '223\.5\.5\.0\/24';/.test(ucSrc));
ok('★ DoH 端点写成常量（不接受外部传入）',
	/const EPDG_DOH = 'https:\/\/dns\.alidns\.com\/resolve';/.test(ucSrc));
ok('★ 只有 DoH 给出**更确定**的结论才覆盖系统 DNS（unknown 不覆盖）',
	/if \(r\.doh\.state == 'unknown'\) \{\s*\n\s*return r;/.test(probeBody));
ok('★ 系统 DNS 的原结论要单独留一份（被 DoH 覆盖后，页面仍要能看到两条路各说了什么）',
	/r\.sysState = r\.state;/.test(probeBody) && /r\.sysAddrs = r\.addrs;/.test(probeBody));
ok('★ DoH 的结论要单独留在 r.doh 上（两条路各说了什么必须都能看见，否则判不了污染）',
	/r\.doh = \{ addrs: d\.addrs, nx: d\.nx, status: d\.status, state: epdgState\(d\) \};/.test(probeBody));
ok('★ 系统 DNS 已经说 available 就不再查 DoH（省一次往返）',
	/if \(r\.state == 'available'\) \{\s*\n\s*return r;/.test(probeBody));
/*
 * ★ 防回归：曾经 epdgResolve 与 epdgProbe **各查一次 DoH** —— 同一个域名被问两遍，
 *   耗时翻倍，而且两层各自覆盖 state，最后采用哪个取决于调用顺序。
 *   分工必须是：epdgResolve 只管系统 DNS，换链路只在 epdgProbe 里做一次。
 */
ok('★ epdgResolve 只走系统 DNS（DoH 全仓只在 epdgProbe 里查一次）',
	!/dohLookup/.test(grab('epdgResolve', ucSrc)),
	'epdgResolve 里又出现了 dohLookup —— 同一个域名会被查两遍');

/* ---------- 5c. 身份链与 AKA 证据（参考 VoCat SIMIdentity / AKAEvidence） ---------- */

ok('★ MNC 长度用 AT+CRSM 读 EF_AD（卡说了算，不从 IMSI 猜）',
	/'AT\+CRSM=176,' \+ EF_AD_ID \+ ',0,0,4'/.test(ucSrc));
ok('★ CRSM 只在成功状态字下才认数据（错误应答里的内容不许当成 EF 内容）',
	/crsmOk\(/.test(ucSrc) && /crsmHex\(/.test(ucSrc));
ok('★ ICCID 与 IMSI 同一次 fresh 取（换卡后不许新 IMSI 配旧 ICCID）',
	/let iccid = readIccid\(\);/.test(factsBody));
const aidBody = grab('uiccAkaAid', ucSrc);
ok('★★ AKA 应用的 AID 从 STATUS 的 FCI 里解（tag 84），函数体内不发 AT+CCHO',
	/AT\+CRSM=242/.test(aidBody) && !/AT\+CCHO/.test(aidBody),
	'逐个 AID 去试＝盲扫未定义对象，会把 AT 通道搞死');
/*
 * ★★ 反向守卫（真机事故，2026-09-24 本机）：
 *   用 AT+CCHO 开逻辑通道做「能不能鉴权」验证，连开两次之后 CCHO 一律
 *   `+CME ERROR: missing resource`，且 AT+CCHC 对已开的 session 一律回
 *   `+CME ERROR: SIM failure` —— **通道占上就无法回收**，只能重启模组。
 *   euicc.js 里也早就记着同一条（「永远不用 CCHO，固定 sessionid=0」）。
 *   页面可以被反复点、可以被强杀，每次点击都占一份不可回收的卡资源是不可接受的。
 *   → AKA 就绪只用卡自己上报的 FCI/AID 作证据，**一条 CCHO 都不许发**。
 */
ok('★★ VoWiFi 评估全程不许发 AT+CCHO（逻辑通道占上后不可回收）',
	!/AT\+CCHO/.test(factsBody) && !/'AT\+CCHO/.test(ucSrc));
ok('★★ AKA 证据等级要如实区分（fci = 卡上报的 AID，不是开过通道）',
	/verified: 'fci'/.test(ucSrc) && /verified: 'none'/.test(ucSrc));
/*
 * ★ 判定：canonical（EF_AD 定长推出的标准写法）结论优先。
 *   真机：mnc000 明确 NXDOMAIN，两位变体 mnc00 返回 127.0.0.1 —— 后者跟
 *   「必然不存在的 mnc999」同值，是污染不是证据。不这么判就会被污染项
 *   把「运营商明确没发布」搅成「无法判定」。
 */
ok('★★ 权威域名说 NXDOMAIN 时，被污染的变体不许把结论搅成 unknown',
	/canon != null && canon\.state == 'not_published'/.test(factsBody)
	&& /verdict = 'not_published';/.test(factsBody));
ok('★ IMS 是否注册只看 AT+CIREG 实测（不认「功能开关是开的」）',
	/'AT\+CIREG\?'/.test(ucSrc));

/* ---------- 6. ★★ 本轮新增：EF_DIR / IMPI / AKA 实测能力 ---------- */

/*
 * ★ 卡上装了哪些应用（ISIM 有没有）是 VoWiFi 的硬条件：
 *   EAP-AKA 要用的 IMPI 正常情况下来自 ISIM 的 EF_IMPI；没有 ISIM 就只能从
 *   IMSI 派生（TS 23.003），而不少运营商的 IMS 核心网只认 ISIM 里那个。
 *   所以「有没有 ISIM」必须单独报，不能混在「有 USIM」里一起算通过。
 */
ok('★ EF_DIR 用 AT+CRSM=178 读记录（列应用，不是挨个 AID 去试）',
	/'AT\+CRSM=178,' \+ EF_DIR_ID \+ ',' \+ rec \+ ',4,0,,"' \+ EF_DIR_PATH \+ '"'/.test(ucSrc));
ok('★★ EF_DIR 必须带 path="3F00"（真机实测：不带 path 一律 +CME ERROR: UNKNOWN）',
	/const EF_DIR_PATH = '3F00';/.test(ucSrc));
ok('★ EF_DIR 最多读 6 条记录就停（不无限读）',
	/const EF_DIR_MAX_REC = 6;/.test(ucSrc) && /rec <= EF_DIR_MAX_REC/.test(ucSrc));
/*
 * ★★ EF_DIR 的停止条件有两种，性质完全不同，必须分开（红线 23）：
 *   6A83（记录不存在）＝卡上就这些，读完了 —— 这是**客观事实**，err 保持空；
 *   其它状态字（6A88/6A82/6981…）= 这次**读不到** —— 不许当成「卡上没有」。
 */
const dirBody = grab('efDirApps', ucSrc);
ok('★ EF_DIR 读到 6A83 就停（记录不存在＝读完了，不猜「再读一条也许有」）',
	/if \(sw == '6A83'\) \{\s*\n\s*break;/.test(dirBody));
const branch83 = dirBody.slice(dirBody.indexOf("if (sw == '6A83')")).split('}')[0];
ok('★★ 6A83 分支只 break 不置 err（真读完了；err 非空会把「没装应用」说成「读不到」）',
	/break;/.test(branch83) && branch83.indexOf('err') < 0);
ok('★★ 其它非 9000 状态字要留下 err（ef_dir_sw_XXXX —— 读不到 ≠ 没有）',
	/if \(sw != '9000'\) \{\s*\n\s*err = 'ef_dir_sw_' \+ sw;/.test(dirBody));
ok('★ AT 通道失败 / 解不出状态字 / 没有数据段都要留 err（三种「读不到」都不许静默成空列表）',
	/err = 'ef_dir_read_failed';/.test(dirBody) && /err = 'ef_dir_nodata';/.test(dirBody)
	&& (dirBody.match(/err = 'ef_dir_read_failed';/g) || []).length === 2);
ok('★ efDirApps 返回 { apps, err }（调用方要能区分「读不到」与「确实没有」）',
	/return \{ apps: apps, err: err \};/.test(dirBody));
ok('★ 编排层把 dirError 带出去（前端据此显示「读不到」而不是「没有 ISIM」）',
	/dirError: dir\.err,/.test(ucSrc) && /let dir = efDirApps\(dl\);[\s\S]{0,80}?let apps = dir\.apps;/.test(ucSrc));

const crsmSw = ucFn(['decHex2', 'crsmSw'], 'crsmSw');
/* 真机：+CRSM: 106,131,"" —— 6A83＝EF_DIR 记录不存在（读到头了） */
eq('★★ crsmSw 把真机的 106,131 解成 6A83（EF_DIR 读完的判据）',
	run(crsmSw, '+CRSM: 106,131,""'), '6A83');
eq('crsmSw 把 144,0 解成 9000（成功）', run(crsmSw, '+CRSM: 144,0,"00000002"'), '9000');
eq('★ crsmSw 对没有 +CRSM 的应答返回 null（不许拿空串当状态字）',
	run(crsmSw, 'ERROR'), null);
eq('★ crsmSw 对越界值给 ?? 而不是溢出成别的数', run(crsmSw, '+CRSM: 999,0,""'), '????'.slice(0, 2) + '00');

const decHex2 = ucFn(['decHex2'], 'decHex2');
eq('decHex2(106) = 6A', run(decHex2, '106'), '6A');
eq('decHex2(131) = 83', run(decHex2, '131'), '83');
eq('decHex2(0) = 00', run(decHex2, '0'), '00');
eq('decHex2(255) = FF', run(decHex2, '255'), 'FF');
eq('★ decHex2 遇到非数字返回 ??（不许静默当 0）', run(decHex2, '12a'), '??');

const tlvVal = ucFn(['hexPairVal', 'hexDigit', 'tlvVal'], 'tlvVal');
/* 真机 EF_DIR 记录：61 24 4F 10 <AID> 50 10 <label> */
const REAL_DIR_REC = '61244F10A0000000871002FF86FFFF89FFFFFFFF5010434D434348424F5553494D322E304127';
eq('★★ tlvVal 从真机 EF_DIR 记录里取出 AID（tag 4F）',
	run(tlvVal, REAL_DIR_REC, '4F'), 'A0000000871002FF86FFFF89FFFFFFFF');
eq('★★ tlvVal 从真机 EF_DIR 记录里取出应用标签（tag 50）',
	run(tlvVal, REAL_DIR_REC, '50'), '434D434348424F5553494D322E304127');
eq('★ tlvVal 找不到该 tag 返回 null（不许返回后面的字节）',
	run(tlvVal, REAL_DIR_REC, '51'), null);
eq('★ tlvVal 长度越界返回 null（不许截断着返回）',
	run(tlvVal, '4FFF01', '4F'), null);

const hexAscii = ucFn(['hexPairVal', 'hexDigit', 'hexAscii'], 'hexAscii');
/* 真机 EF_DIR 里的应用标签：43 4D 43 43 48 42 4F 55 53 49 4D 32 2E 30 41 27
   = "CMCCHBOUSIM2.0A'"（末尾那个 0x27 是卡上写着的，原样保留，不替它美化） */
eq('★★ hexAscii 把真机标签解成可读串',
	run(hexAscii, '434D434348424F5553494D322E304127'), "CMCCHBOUSIM2.0A'");
eq('★ hexAscii 遇到第一个不可打印字节就停（不猜 UCS2 等其它编码）',
	run(hexAscii, '414200'), 'AB');
eq('★ hexAscii 对 null 返回空串', run(hexAscii, null), '');

const appKind = ucFn(['appKind'], 'appKind');
eq('appKind 认 USIM（A0000000871002…）',
	run(appKind, 'A0000000871002FF86FFFF89FFFFFFFF'), 'USIM');
eq('appKind 认 ISIM（A0000000871004…）',
	run(appKind, 'A0000000871004FF86FFFF89FFFFFFFF'), 'ISIM');
eq('★ appKind 对别的应用如实说 other（不许把未知 AID 当 USIM）',
	run(appKind, 'A000000151000000'), 'other');
eq('★ appKind 对过短 AID 说 other', run(appKind, 'A00000'), 'other');

const mnc3Of = ucFn(['mnc3Of'], 'mnc3Of');
eq('mnc3Of 把两位 MNC 补成三位（00 → 000）', run(mnc3Of, '00'), '000');
eq('mnc3Of 三位不动', run(mnc3Of, '123'), '123');
eq('★ mnc3Of 对空串返回空（不许补成 "0000"）', run(mnc3Of, ''), '');

const deriveImpi = ucFn(['deriveImpi'], 'deriveImpi');
/* 真机：IMSI 460001234567890，MCC 460，MNC 00（EF_AD 定长 2） */
eq('★★ deriveImpi 按 TS 23.003 拼出真机 IMPI',
	run(deriveImpi, '460001234567890', '460', '000'),
	'460001234567890@ims.mnc000.mcc460.3gppnetwork.org');
eq('★ deriveImpi 参数不全返回空串（不许拼半个 IMPI 出来）',
	run(deriveImpi, '460001234567890', '460', ''), '');
eq('★ deriveImpi 对 MCC 不是三位也返回空串', run(deriveImpi, '460', '46', '000'), '');

/*
 * ★★ AKA 实测能力（本轮最重要的一条事实守卫）：
 *   本模组的 AT+CSIM **只接受 ≤42 个十六进制字符**的命令（真机实测：42 通过，
 *   44 起一律 ERROR，且用同一条 SELECT 补填充到 44 也一样 —— 与命令内容无关）。
 *   而 USIM AUTHENTICATE（80 88 00 80 22 <RAND 16B><AUTN 16B> 00）需要 76 个。
 *   → 「能不能真的算一次 AKA」在本机上**发不出去**，aka.probe.supported 必须是 false。
 *   这两个数字一旦被改（比如把上限拍成 512 好让它 supported），测试必须红。
 */
ok('★★ CSIM 上限常量取真机实测值 42', CSIM_MAX_HEX === 42, '实际: ' + CSIM_MAX_HEX);
ok('★★ AUTHENTICATE 需要 76 个十六进制字符', AKA_AUTH_HEX === 76, '实际: ' + AKA_AUTH_HEX);
const akaProbeSupported = ucFn(['akaProbeSupported'], 'akaProbeSupported');
eq('★★★ 本模组不支持 AUTHENTICATE 实测（42 < 76，不是漏实现）', run(akaProbeSupported), false);
ok('★ aka.probe 把两个数字都带回前端（用户能看到为什么发不出去）',
	/supported: akaProbeSupported\(\),/.test(ucSrc)
	&& /apduHex: AKA_AUTH_HEX,/.test(ucSrc)
	&& /maxHex: CSIM_MAX_HEX/.test(ucSrc));
ok('★ IMPI 来源如实标 derived（本模组读不到 ISIM 下的 EF，不假装读过）',
	/impiSource: 'derived'/.test(ucSrc));

/* ---------- 6b. 五道门与阻断清单（参考 VoCat orchestrator） ---------- */

const vwBody = grab('vowifiFacts', ucSrc);
ok('★★ 五道门齐全且各自独立报（sim / identity / aka / epdg / ims）',
	/key: 'sim'/.test(vwBody) && /key: 'identity'/.test(vwBody) && /key: 'aka'/.test(vwBody)
	&& /key: 'epdg'/.test(vwBody) && /key: 'ims'/.test(vwBody));
ok('★ identity 门独立存在（VoWiFi 用的是 IMPI，不是 IMSI —— 不能省这道门）',
	/key: 'identity',[\s\S]{0,200}?ok: \(impi != ''\)/.test(vwBody));
ok('★ 阶段链只在编排层组装（ePDG 层不再自己报一套四段链，两套 stages 必有一个没人看）',
	!/let stages = \[/.test(factsBody) && /let stages = \[/.test(vwBody));
ok('★ 阻断清单逐条点名（不给笼统的「不可用」）',
	/blockers\[length\(blockers\)\] = 'no_impi';/.test(vwBody)
	&& /blockers\[length\(blockers\)\] = 'no_usim_isim';/.test(vwBody)
	&& /blockers\[length\(blockers\)\] = 'epdg_' \+ ep\.verdict;/.test(vwBody)
	&& /blockers\[length\(blockers\)\] = 'ims_not_registered';/.test(vwBody));
ok('★ MNC 没定下来要单独成一条阻断（ambiguous ≠ 读不到）',
	/blockers\[length\(blockers\)\] = \(ep\.mncSource == 'ambiguous'\) \? 'mnc_ambiguous' : 'sim_unread';/.test(vwBody));
ok('★ 五门全过才叫 capable（不做「前面过了所以后面也应该过」的推理）',
	/verdict = 'capable';[\s\S]{0,120}?length\(blockers\) == 0/.test(vwBody)
	|| /if \(length\(blockers\) == 0\) \{\s*\n\s*verdict = 'capable';/.test(vwBody));
ok('★ ePDG 无法判定时总判定不许说「不通」',
	/\} else if \(ep\.verdict == 'unknown'\) \{\s*\n\s*verdict = 'unknown';/.test(vwBody));
/*
 * ★★ phase 必须是**连续通过的前缀**，不是「最后一个 ok 的门」。
 *   真机形态（sim✓ identity✓ aka✓ epdg✗ ims✓）下，取「最后一个 ok」会算出
 *   ims_ready —— 界面于是同时显示「走到：IMS 已注册」和「VoWiFi 不成立」，
 *   自相矛盾且看着像只差最后一步。卡在第三道门就该报 aka_ready。
 *   （断言收窄到 PHASE_BY_STAGE 之后那段，避免被别处同形代码顶住而恒绿）
 */
const phaseBlock = vwBody.slice(vwBody.indexOf('const PHASE_BY_STAGE'));
ok('★★ phase 是「连续通过的前缀」：遇到第一道没过的门就 break',
	/PHASE_BY_STAGE = \['sim_ready', 'identity_ready', 'aka_ready', 'access_ready', 'ims_ready'\];/.test(phaseBlock)
	&& /if \(!stages\[i\]\.ok\) \{\s*\n\s*break;/.test(phaseBlock));
ok('★ phase 初值为 blocked（第一道门就没过时不能停在 sim_ready）',
	/let phase = 'blocked';/.test(phaseBlock) && /phase = PHASE_BY_STAGE\[i\];/.test(phaseBlock));
ok('★ 带 traceId（排障时能对应到这一次评估）',
	/traceId: vowifiTraceId\(ep\.iccid\),/.test(vwBody));
ok('★ 编排层注明「不关射频」的理由（参考项目会关，这台设备关了就是断网）',
	/唯一上行/.test(ucSrc));

/* ---------- 6c. VoWiFi 开关（用户口径：能开的功能，开不了要告知原因） ---------- */

/*
 * ★ 这台模组的 238 条 AT 命令里**没有 VoWiFi / ePDG 命令**，跟 IMS 有关的只有
 *   AT^IMSSWITCH（手册 4.10，掉电保存）。开关落在它身上：真实可写、可回读，
 *   不是「点一下改个本地变量」的空壳（红线 14）。
 */
const setBody = grab('vowifiSet', ucSrc);
const cmdFn = ucFn(['vowifiSetCmd'], 'vowifiSetCmd');
eq('★ 开 = AT^IMSSWITCH=1,0,0（手册 4.10 的举例写法）', run(cmdFn, 1), 'AT^IMSSWITCH=1,0,0');
eq('★ 关 = AT^IMSSWITCH=0,0,0', run(cmdFn, 0), 'AT^IMSSWITCH=0,0,0');
ok('ucode 注册了 mt5700.vowifi_set', /\bvowifi_set: \{/.test(ucSrc));
ok('★ 开关只收 enable 一个参数（其余一律不接受 → 没有注入面）',
	/vowifi_set: \{\s*\n\s*args: \{ enable: 0 \},/.test(ucSrc));
/*
 * ★★ 真机实测（2026-09-24）：args 声明整型后，字符串 '1' 与布尔 true 都被 rpcd
 *   以 code=2 挡在 ucode 之外（界面只能落到兜底的「设置失败」，看不出是类型问题）。
 *   → 后端只写数字分支（其余是不可达的死分支），前端必须传数字，两侧各钉一条。
 */
ok('★★ 后端只认数字 0/1（字符串与布尔被 rpcd 挡在 ucode 外，写了也跑不到）',
	/let enable = -1;\s*\n\s*if \(v === 1\) \{\s*\n\s*enable = 1;\s*\n\s*\} else if \(v === 0\) \{\s*\n\s*enable = 0;\s*\n\s*\}/
		.test(ucSrc));
ok('★★ 后端不为「字符串形态的 enable」留分支（真机拿不到，留着就是死代码）',
	!/v === '1'/.test(ucSrc) && !/v === true/.test(ucSrc));
ok('★★ 缺 enable 必须报错，不许默认成 0（默认 0＝关 IMS，是有后果的动作）',
	/if \(v == null\) \{\s*\n\s*return \{ success: false, error: '缺少 enable 参数（0=关，1=开）' \};/.test(ucSrc));
ok('★ enable 只认 0/1，其它一律拒绝',
	/if \(enable < 0\) \{\s*\n\s*return \{ success: false, error: 'enable 只能是 0 或 1' \};/.test(ucSrc));

/*
 * ★★ 拒绝路径：**一条写命令都不下发**，把阻断项带回去（用户要的是原因，
 *   不是静默失败，也不是下发一条注定失败的命令）。
 *   断言方式：比较两侧的**位置** —— 拒绝分支必须排在真正下发之前。
 */
ok('★★ 本地三门没过时拒绝下发：refused 分支在 imsswitchWrite 调用之前',
	setBody.indexOf('refused: true') >= 0
	&& setBody.indexOf('refused: true') < setBody.indexOf('imsswitchWrite(enable)'));
ok('★ 拒绝时把最新五门一起回给前端（用户能看见卡在哪儿，不用再点一次评估）',
	/refused: true,[\s\S]{0,200}?facts: f/.test(setBody));
ok('★ 只有开启方向设门禁（关 = 收敛现状，不需要前置条件）',
	/if \(enable\) \{\s*\n\s*let local = vowifiLocalBlockers\(f\);/.test(setBody));

/* 本地三门白名单：ePDG 与「IMS 已注册」不是本机/这张卡能改的事，不该挡住开启 */
const localFn = ucFn(['vowifiLocalBlockers'], 'vowifiLocalBlockers');
eq('★ 只把本机/本卡的四类阻断算作「不能开启」',
	JSON.stringify(run(localFn, { success: true, blockers: ['sim_unread', 'no_impi', 'no_usim_isim',
		'epdg_not_published', 'ims_not_registered'] })),
	JSON.stringify(['sim_unread', 'no_impi', 'no_usim_isim']));
eq('★★ ePDG 没发布不挡开启（它是运营商侧的网元，挡了开关就永远是死的）',
	JSON.stringify(run(localFn, { success: true, blockers: ['epdg_not_published'] })),
	JSON.stringify([]));
eq('★ 评估失败时按「读不到卡」处理（不许放行）',
	JSON.stringify(run(localFn, { success: false })), JSON.stringify(['sim_unread']));

/*
 * ★ 回读：^IMSSWITCH? 不在 rpc.js 的读缓存档（默认 2500ms），不 fresh 会捞到
 *   下发前的旧值 → 把「已生效」误判成「没生效」（sms_settings R04 同一套约定）。
 */
const imsswBody = grab('imsswitchStat', ucSrc);
ok('★★ 回读 ^IMSSWITCH? 必须 fresh（否则读到下发前的旧值）',
	/cmd: 'AT\^IMSSWITCH\?', fresh: true/.test(imsswBody));
const wrBody = grab('imsswitchWrite', ucSrc);
ok('★ 写命令不带 fresh（写路径不走读缓存，带上反而误导）',
	/cmd: vowifiSetCmd\(enable\)/.test(wrBody) && wrBody.indexOf('vowifiSetCmd(enable)') > 0
	&& !/vowifiSetCmd\(enable\),\s*\n?\s*fresh/.test(wrBody));
ok('★★ 回读不一致只报「未生效」，不反向重下发（手册三条失败条件那一刻通常仍成立）',
	wrBody.indexOf('AT^IMSSWITCH') < 0 && /effective: \(actual == \(enable \? '1' : '0'\)\)/.test(wrBody));
ok('★ 回读不到要标 unknown（不许据此断言生效）',
	/unknown: true/.test(wrBody) && /if \(actual == null\)/.test(wrBody));
ok('★ 下发后重跑五门（开关状态与「VoWiFi 成不成立」是两件事，都要回；B01 后带 20s 预算）',
	/let after = vowifiFacts\(time\(\) \+ 20\);/.test(setBody) && /facts: after/.test(setBody));

/* ---------- 7. ACL / rpc / 前端 ---------- */

const aclJson = JSON.parse(aclSrc);
let aclHits = 0;
let aclSetHits = 0;   /* ★ 2026-09-28：vowifi_set 单独计数 —— 原来这条断言写的是 clHits >= 0（恒真），实际只检查了一处 ACL 段 */
function walk(o) {
	if (o == null || typeof o !== 'object') return;
	if (Array.isArray(o)) {
		if (o.indexOf('vowifi') >= 0) aclHits++;
		if (o.indexOf('vowifi_set') >= 0) aclSetHits++;
		o.forEach(walk);
		return;
	}
	for (const k in o) walk(o[k]);
}
walk(aclJson);
ok('★ ACL 两段都放行 vowifi（漏一处就是 rpcd Access denied，页面静默失败）',
	aclHits >= 2, '实际命中段数: ' + aclHits);
ok('★ ACL 里没有残留的 epdg（旧方法名已改名，留着就是死条目）',
	aclSrc.indexOf('epdg') < 0);

ok('rpc.js 声明了 mt5700.vowifi',
	/method: 'vowifi'/.test(rpcSrc) && /var rpcVowifi = L\.rpc\.declare\(\{/.test(rpcSrc));
ok('★ rpc 声明不带 params（域名由后端拼，前端不传任何东西进去）',
	/var rpcVowifi = L\.rpc\.declare\(\{[\s\S]{0,200}?params: \[\]/.test(rpcSrc));
ok('rpc.js 暴露了 AtWs.vowifi', /\bvowifi: fetchVowifi,/.test(rpcSrc));
ok('★ 后端没升级时前端要明确提示（不能静默什么都不出）',
	/后端未升级：rpcd 没有 mt5700\.vowifi 方法/.test(viewSrc));
ok('★ 评估按钮在（五道门只能靠它触发）',
	/Mt5700\.ghostButton\(t\.busy \? '评估中…' : '评估 VoWiFi', runVowifi\)/.test(viewSrc));
ok('★ 评估中重复点击要挡住（并发会占满 rpcd 工作线程）',
	/function runVowifi\(\) \{\s*\n\s*var t = vowifiState;\s*\n\s*if \(t\.busy\) return;/.test(viewSrc));

/*
 * ★★ 反向契约：五道门评估**只能手点「评估 VoWiFi」触发**（2026-09-27 用户口径
 *   「评估vowifi 功能改成不自动进行」）。
 *
 * 改之前的行为：进页面自动跑一次（真机实测 t=1.8s 发出 mt5700.vowifi → t=4.0s
 *   出结论，≈2.2s，含逐条读卡 + 两次公网解析），且底部「刷新」也连带重跑一次。
 *
 * ⚠ 这类「不许出现 X」的断言**默认就是绿的**（没有 = 通过），最容易写成恒绿。
 *   所以用两条互相独立的定位断言（都跑在**去注释后的纯代码**上）：
 *     ① 从 connectThen 起直到文件末尾，不许再出现 runVowifi 这个词；
 *     ② 全文件里 `runVowifi()` 只允许出现 1 次（函数声明本身）——
 *        按钮绑的是**函数引用** `runVowifi`（不带括号），所以任何**调用**
 *        都会让计数变成 2。
 */
const vowifiCode = stripComments(viewSrc);
const connTail = vowifiCode.slice(vowifiCode.indexOf('Mt5700.connectThen('));
ok('★★ 进页面不再自动跑五道门（用户口径：改成不自动进行）',
	connTail.length > 100 && connTail.indexOf('runVowifi') < 0,
	'connectThen 之后仍出现 runVowifi —— 五道门又变成进页面就跑了');
ok('★★ 全页只有函数声明那一处 `runVowifi()`，没有任何自动调用点',
	(vowifiCode.match(/runVowifi\(\)/g) || []).length === 1,
	'实际出现 ' + (vowifiCode.match(/runVowifi\(\)/g) || []).length + ' 次（期望 1：只剩函数声明）');
ok('★ 刷新按钮不再连带跑五道门（评估只由「评估 VoWiFi」按钮触发）',
	/Mt5700\.primaryButton\('刷新', function \(\) \{\s*\n\s*loadAll\(\);\s*\n\s*\}\)/.test(vowifiCode)
	&& vowifiCode.indexOf('loadAll().then(function () { runVowifi(); })') < 0);

/*
 * ★ 但开关的当前值不能跟着一起"不自动"：它原先取自那份评估结果，不评估就没数据
 *   → 开关会一直显示「关」，与真机真实状态相反（真机实测 ^IMSSWITCH=1,0,0，
 *   而基线测量里未评估时开关确实渲染成 off）。所以单独留**一条只读**：
 *   AT^IMSSWITCH?（手册 4.10），挂在 loadAll 链里，点「刷新」时它跟着刷新。
 *   ★ 必须 fresh —— 状态类读取不许吃读缓存（否则显示的是下发前的旧值）。
 */
ok('★ 页面加载只读一条开关状态 AT^IMSSWITCH?（手册 4.10）',
	/function fetchImsSwitch\(\)/.test(viewSrc)
	&& /sendCommand\('AT\^IMSSWITCH\?', \{ fresh: true \}\)/.test(viewSrc));
ok('★ 那条读挂在 loadAll 链里（点「刷新」时一并刷新开关状态）',
	/\.then\(fetchImsSwitch\)/.test(viewSrc));

/* 迁移：旧宿主不许留残骸（两页都渲染同一张卡是最难发现的一类重复） */
ok('★★ 网络状态页已不再有任何 VoWiFi / ePDG 痕迹（整块迁到模组设置）',
	!/vowifi/i.test(oldViewSrc) && !/epdg/i.test(oldViewSrc));
ok('★★ 模组设置页是 VoWiFi 的新宿主（卡片 + 开关 + 渲染齐全）',
	/Mt5700\.card\('VoWiFi（Wi-Fi 通话）'/.test(viewSrc)
	&& /var vowifiSwitchWrap = E\('div', \{ 'class': 'mt5700-switch' \}\);/.test(viewSrc)
	&& /function renderVowifi\(\)/.test(viewSrc));
ok('★ 页面已卸载就不再重绘（避免已发起的链回来时操作已销毁的 DOM）',
	/if \(!disposed\) renderVowifi\(\);/.test(viewSrc));

/* 前端：四态文案必须齐全，缺一种就会显示 undefined */
const stateMap = viewSrc.slice(viewSrc.indexOf('var EPDG_STATE = {'), viewSrc.indexOf('var BLOCKER_TEXT = {'));
ok('前端 EPDG_STATE 四态齐全（available/polluted/not_published/unknown）',
	/available:/.test(stateMap) && /polluted:/.test(stateMap)
	&& /not_published:/.test(stateMap) && /unknown:/.test(stateMap));
ok('前端 ePDG 门的结论提示四态齐全（available/not_published/polluted/unknown）',
	/var EPDG_VERDICT_HINT = \{[\s\S]{0,600}?unknown:/.test(viewSrc));
ok('★ 不再有裸的 EPDG_VERDICT 常量（总判定已统一用 VOWIFI_VERDICT，留着同形死表会被误用）',
	!/var EPDG_VERDICT = \{/.test(viewSrc));

/* 前端：新增的三张表必须和后端字段对得上 */
const blockerMap = viewSrc.slice(viewSrc.indexOf('var BLOCKER_TEXT = {'), viewSrc.indexOf('var VOWIFI_PHASE = {'));
for (const key of ['sim_unread', 'mnc_ambiguous', 'no_impi', 'no_usim_isim',
	'epdg_not_published', 'epdg_polluted', 'epdg_unknown', 'ims_not_registered']) {
	ok('前端 BLOCKER_TEXT 覆盖了后端阻断项 ' + key, blockerMap.indexOf(key + ':') >= 0);
}
const phaseMap = viewSrc.slice(viewSrc.indexOf('var VOWIFI_PHASE = {'), viewSrc.indexOf('var VOWIFI_VERDICT = {'));
for (const key of ['blocked', 'sim_ready', 'identity_ready', 'aka_ready', 'access_ready', 'ims_ready']) {
	ok('前端 VOWIFI_PHASE 覆盖了后端 phase ' + key, phaseMap.indexOf(key + ':') >= 0);
}
ok('前端 VOWIFI_VERDICT 三态齐全（capable/blocked/unknown）',
	/var VOWIFI_VERDICT = \{[\s\S]{0,300}?unknown: '无法判定'/.test(viewSrc));
ok('★ 前端展示 IMPI 与 EF_DIR 应用列表（这两项是本轮新增的证据）',
	/IMPI（IMS 身份）/.test(viewSrc) && /EF_DIR 里的应用/.test(viewSrc));
/*
 * ★ AUTHENTICATE 实测这一行要钉死：**发不出去**是实测结论，不是没实现；
 *   而且必须把两个数都摆出来（需要 76 个十六进制字符 / AT+CSIM 上限 42），
 *   否则用户只会看到「不支持」三个字，无从判断能不能绕。
 *   （数值取自后端 aka.probe，前端只负责展示，不在这里写死 76/42。）
 */
ok('★ 前端展示 AUTHENTICATE 实测能力（不发不出去的命令，但要说清为什么）',
	/AUTHENTICATE 实测/.test(viewSrc));
ok('★ AUTHENTICATE 那一行把「发不出去 + 需要多少字符 + 上限多少」三件事都说清',
	/'本模组发不出去'/.test(viewSrc)
	&& /'需要 ' \+ \(\(d\.aka\.probe && d\.aka\.probe\.apduHex\) \|\| '\?'\) \+ ' 个十六进制字符，'/
		.test(viewSrc)
	&& /'AT\+CSIM 上限 ' \+ \(\(d\.aka\.probe && d\.aka\.probe\.maxHex\) \|\| '\?'\) \+ '（实测）'/
		.test(viewSrc));
ok('★ 前端展示 traceId', /'trace ' \+ d\.traceId/.test(viewSrc));
ok('★★ 前端把「读不到 EF_DIR」与「没有 ISIM」分开显示（一次 AT 失败不许说成卡的客观事实）',
	/if \(d\.identity\.dirError\) \{\s*\n\s*irows\.push\(\['卡上有 ISIM', '读不到', 'EF_DIR 读取失败（' \+ d\.identity\.dirError \+ '）'\]\);/.test(viewSrc));

/* 开关：ACL / rpc / 前端三处都得通，缺一段就是点了没反应 */
ok('★ ACL 两段都放行 vowifi_set（漏一处就是 rpcd Access denied，点了静默失败）',
	/* ★ 2026-09-28 修：这里原来写 `aclHits >= 0`（计数 >= 0 恒真），等于只检查了
	   `luci-app-mt5700` 那一段 —— 而注释要的是「ACL **两段**都放行 vowifi_set，
	   漏一处就是 rpcd Access denied、点了静默失败」。改为对 vowifi_set 单独计数并
	   要求两段都命中（与上面 vowifi 那条用同一判据）。 */
	aclSetHits >= 2
	&& aclJson['luci-app-mt5700'].write.ubus.mt5700.indexOf('vowifi_set') >= 0);
ok('rpc.js 声明了 mt5700.vowifi_set，且参数只有 enable',
	/method: 'vowifi_set',\s*\n\s*params: \['enable'\],/.test(rpcSrc));
ok('rpc.js 暴露了 AtWs.vowifiSet', /\bvowifiSet: fetchVowifiSet,/.test(rpcSrc));
ok('★ 后端没升级时前端对开关也要明确提示（不能点了什么都不出）',
	/后端未升级：rpcd 没有 mt5700\.vowifi_set 方法/.test(viewSrc));
ok('★ 开关用五页共用的 .mt5700-switch 组件（不另造一套开关）',
	/var vowifiSwitchWrap = E\('div', \{ 'class': 'mt5700-switch' \}\);/.test(viewSrc));
ok('★★ 开关状态取实测值，不是本地勾选记忆（掉电保存的命令会记住一次没生效的写入）',
	/var known = \(t\.imssw === '1' \|\| t\.imssw === '0'\);/.test(viewSrc)
	&& /vowifiSwitch\.checked = \(t\.imssw === '1'\);/.test(viewSrc));
ok('★★ 读不到开关状态时不许显示成「关」（红线 23：读不到 ≠ 确实是 0）',
	/vowifiSwitch\.disabled = !known \|\| !!\(t\.busy \|\| t\.setBusy\);/.test(viewSrc));
ok('★★ 关 IMS 要先确认（会断掉 IMS 短信与 VoLTE 语音），取消时把开关拨回去',
	/Mt5700\.confirm\('关闭会下发 AT\^IMSSWITCH=0,0,0/.test(viewSrc)
	&& /function \(\) \{ doVowifiSet\(0\); \}, '确定关闭',\s*\n\s*function \(\) \{ renderVowifiSwitch\(\); \}/
		.test(viewSrc));
ok('★★ 被拒绝时前端要说出「无法开启：原因」，不是笼统的「设置失败」',
	/t\.setMsg = '无法开启：' \+ blockersToText\(r\.blockers\);/.test(viewSrc));
ok('★ 开了但 VoWiFi 仍不成立时，要把还差什么一起说出来',
	/'，但 VoWiFi 仍不成立：' \+ blockersToText\(r\.blockers\)/.test(viewSrc));
ok('★ 回读不到不许说「已生效」（unknown 单独成一句）',
	/'命令已下发，但回读不到 \^IMSSWITCH/.test(viewSrc));
ok('★ 开关与评估两条路互斥（都碰串口，并发会让回读拿到别人的包）',
	/!known \|\| !!\(t\.busy \|\| t\.setBusy\)/.test(viewSrc)
	&& /if \(t\.busy \|\| t\.setBusy\) \{ renderVowifiSwitch\(\); return; \}/.test(viewSrc));
ok('★ 开关文案说清「开关只管本机 IMS，通不通要看五道门」（不假装开了就通）',
	viewSrc.includes('开关只管本机 IMS') && viewSrc.includes('还要看下面五道门'));

/* ★ 真机事实（2026-09-24 实测）：`args: { enable: 0 }` 声明的是**整型**，
 *   传字符串 '1' 会被 rpcd 以 code=2（Invalid argument）整包拒掉，ucode 根本进不去。
 *   所以前端必须传数字 —— 这条钉的是「点的通不通」，不是风格问题。 */
ok('★★ 前端传的是数字 0/1（传字符串会被 rpcd 以 Invalid argument 拒，点了没反应）',
	/rpcVowifiSet\(enable \? 1 : 0\)/.test(rpcSrc)
	&& !/rpcVowifiSet\(enable \? '1' : '0'\)/.test(rpcSrc));

/* ---------- 汇总 ---------- */

console.log('VoWiFi 契约测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
if (fails.length) {
	console.log(fails.join('\n'));
	process.exit(1);
}
