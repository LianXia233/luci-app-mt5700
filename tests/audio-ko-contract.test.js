#!/usr/bin/env node
/*
 * 音频内核模块装载器契约（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 背景（2026-10-22 实测）：MT5700M-CN 的 USB 两个配置全解析过，六个接口是
 * CDC-NCM / CDC-Data / vendor(ff/06)×4，**没有任何 Audio Class**；手册 244 条
 * 命令也没有音频数据通道。所以本机永远听不到模组语音 —— 除非换带 UAC 的模组。
 *
 * 而换模组这件事，软件侧已经被实测验证过是零成本的：厂商固件那套 ALSA 模块
 * vermagic 与本机内核（6.12.112 SMP mod_unload aarch64）字节一致，11 个 insmod
 * 全部 rc=0，dmesg 出现 `usbcore: registered new interface driver snd-usb-audio`。
 * 于是把这批模块随插件打包，插上新模组就自动装载。
 *
 * 本测试守六件在真机上真出过问题的事：
 *   ① 文件集与装载清单一一对应（少一个 = 装到一半停住，而半套音频栈不报错）
 *   ② 装载顺序满足依赖（拓扑序错了 insmod 会报 Unknown symbol）
 *   ③ 没有 UAC 时不装任何模块（当前这台机器的正常态，零开销是设计意图）
 *   ④ 模块名连字符 → 下划线（lsmod 里叫 snd_usb_audio，不转换就永远「未加载」）
 *   ⑤ 模块文件必须在 .gitattributes 里声明 binary（否则被 eol 转换静默损坏）
 *   ⑥ SHA256SUMS 必须是 sha256sum -c 认的两段格式（三段格式会 11 条全 FAILED）
 *   ⑦ 文件后缀必须是 .kmod 而非 .ko（否则 OpenWrt 打包扫 depends 必失败）
 *
 * 运行：node tests/audio-ko-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const KO = path.join(ROOT, 'root', 'usr', 'share', 'mt5700', 'audio-ko.sh');
const AUDIO = path.join(ROOT, 'root', 'usr', 'share', 'mt5700', 'audio');
const MODDIR = path.join(AUDIO, '6.12.112');
const MANIFEST = path.join(AUDIO, 'MANIFEST.md');
const HOTPLUG = path.join(ROOT, 'root', 'etc', 'hotplug.d', 'usb', '99-mt5700-audio');
const INITD = path.join(ROOT, 'root', 'etc', 'init.d', 'at-webserver');
const GITATTR = path.join(ROOT, '.gitattributes');

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return true; }
	fails.push('  ✗ ' + name + (hint ? '\n      ' + hint : ''));
	return false;
}

/* ---------- 前置：文件都在 ---------- */

const missing = [KO, MANIFEST, HOTPLUG, MODDIR].filter(function (p) { return !fs.existsSync(p); });
if (missing.length) {
	console.log('缺少必需文件：' + missing.join(', '));
	process.exit(1);
}

const koSrc = fs.readFileSync(KO, 'utf8');
const manifestSrc = fs.readFileSync(MANIFEST, 'utf8');
const hotplugSrc = fs.readFileSync(HOTPLUG, 'utf8');
const initdSrc = fs.readFileSync(INITD, 'utf8');
const gitattrSrc = fs.readFileSync(GITATTR, 'utf8');

/* 注意：靠 `.replace(/\r\n/g, '\n')` 归一而不是假设 LF —— 本测试同时要在
 * Windows 工作区与 CI 上跑，但 line-endings-contract 已经守着仓库必须 LF。 */

/* ---------- ① 装载清单 ---------- */

const m = koSrc.match(/^KO_ORDER="([^"]+)"/m);
ok('audio-ko.sh 声明了 KO_ORDER', !!m);
const order = m ? m[1].trim().split(/\s+/) : [];

ok('装载清单是 11 个模块（snd 依赖链全长）', order.length === 11,
	'实际 ' + order.length + ' 个：' + order.join(' '));

const filesOnDisk = fs.readdirSync(MODDIR)
	.filter(function (f) { return f.endsWith('.kmod'); })
	.map(function (f) { return f.slice(0, -5); })
	.sort();

ok('清单与目录里的 .kmod 一一对应（不多不少）',
	JSON.stringify(order.slice().sort()) === JSON.stringify(filesOnDisk),
	'清单独有：' + order.filter(function (x) { return filesOnDisk.indexOf(x) < 0; }).join(',')
	+ ' / 目录独有：' + filesOnDisk.filter(function (x) { return order.indexOf(x) < 0; }).join(','));

/* ---------- ② 拓扑序 ---------- */

/*
 * 依赖取自各模块的 modinfo depends（2026-10-22 提取），不是照抄手册。
 * 顺序错了 insmod 会报 "Unknown symbol in module"，而半套装好的状态不会自动
 * 回滚 —— 表现是 /proc/asound 空着、看起来像「驱动没生效」。
 */
const DEPS = {
	soundcore: [],
	snd: ['soundcore'],
	'snd-timer': ['snd'],
	'snd-pcm': ['snd', 'snd-timer'],
	'snd-hwdep': ['snd'],
	'snd-seq-device': ['snd'],
	'snd-rawmidi': ['snd', 'snd-seq-device'],
	'snd-usbmidi-lib': ['snd', 'snd-rawmidi'],
	mc: [],
	'input-core': [],
	'snd-usb-audio': ['mc', 'snd', 'snd-pcm', 'input-core', 'snd-usbmidi-lib', 'snd-hwdep'],
};

const badOrder = [];
order.forEach(function (mod, i) {
	(DEPS[mod] || []).forEach(function (dep) {
		const j = order.indexOf(dep);
		if (j < 0) { badOrder.push(mod + ' 依赖 ' + dep + ' 但清单里没有它'); }
		else if (j > i) { badOrder.push(mod + ' 排在依赖 ' + dep + ' 之前'); }
	});
});
ok('装载顺序满足依赖（被依赖的先装）', badOrder.length === 0, badOrder.join('；'));

ok('snd-usb-audio 是最后装的那个（它是唯一注册 USB 驱动的）',
	order[order.length - 1] === 'snd-usb-audio');

/*
 * MANIFEST 里那一行是人读的依赖序（分两行写，箭头连接），两处不能漂。
 * 归一化时把换行与箭头一起折成单空格再比，避免「排版换了就对不上」的假红。
 */
const mBlock = manifestSrc.match(/```\n(soundcore[^`]*?snd-usb-audio)\n```/);
const mOrder = mBlock ? mBlock[1].replace(/[→\s]+/g, ' ').trim() : '';
ok('MANIFEST 的依赖序与 KO_ORDER 一致',
	mOrder === order.join(' '),
	mBlock ? ('MANIFEST: ' + mOrder + '\n      KO_ORDER: ' + order.join(' '))
		: 'MANIFEST 里找不到依赖序那个代码块');

/* ---------- ③ 无 UAC 时不装任何模块 ---------- */

const iProbe = koSrc.indexOf('has_uac || return 3');
const iLoop = koSrc.indexOf('for m in $KO_ORDER');
ok('cmd_load 先判 UAC 再进装载循环（没有硬件就一个模块都不装）',
	iProbe > 0 && iLoop > iProbe,
	'has_uac 的判断必须在 for 循环之前 —— 否则插个 U 盘也会往内核塞 11 个音频模块');

/* 顺序断言要落在 cmd_load 函数体内，而不是碰巧在文件里前后位置对上 */
ok('has_uac 判据只认 bInterfaceClass=01（Audio Class 控制接口）',
	/cls=\$\(cat "\$f" 2>\/dev\/null\)[\s\S]{0,80}\[ "\$cls" = "01" \]/.test(koSrc));

ok('音频模块目录按内核版本分（换内核不会装错版本）',
	koSrc.includes('KO_ROOT=/usr/share/mt5700/audio') &&
	/cmd_load\(\) \{[\s\S]{0,200}dir=\$\(ko_dir\)/.test(koSrc));

ok('insmod 失败就中止并记录原因（不跳过去继续装半套）',
	/if ! insmod "\$f" 2>"\$ERRFILE"; then[\s\S]{0,200}return 5/.test(koSrc));

/* ---------- ④ 模块名转换 ---------- */

ok('模块名做 连字符→下划线 转换（lsmod 里叫 snd_usb_audio）',
	/echo "\$1" \| tr '-' '_'/.test(koSrc));
ok('is_loaded 用转换后的名字比对',
	/for m in \$KO_ORDER; do[\s\S]{0,120}nm=\$\(mod_name "\$m"\)[\s\S]{0,160}is_loaded "\$nm"/.test(koSrc));

/* ---------- ⑤ 二进制不能被 eol 转换 ---------- */

ok('.gitattributes 声明 *.kmod binary（否则 ELF 被当文本改坏，git 侧看不出来）',
	/^\*\.kmod binary$/m.test(gitattrSrc));

/* ---------- ⑥ SHA256SUMS 格式 ---------- */

const sums = fs.readFileSync(path.join(MODDIR, 'SHA256SUMS'), 'utf8').trim().split('\n');
ok('SHA256SUMS 有 11 行', sums.length === 11, '实际 ' + sums.length + ' 行');

/*
 * ★ 这条是真踩过的坑：一开始写成「名字  大小  哈希」三段，sha256sum -c 认不出，
 *   11 条全报 FAILED（它把大小当成了文件名）。格式必须是 "哈希  文件名"。
 */
const badSum = sums.filter(function (l) { return !/^[0-9a-f]{64}  \S+\.kmod$/.test(l); });
ok('SHA256SUMS 每行都是 sha256sum -c 认的「哈希+两空格+文件名」',
	badSum.length === 0, badSum.slice(0, 2).join(' | '));

/* 哈希要与文件内容真的对得上 —— 否则清单只是装饰 */
const badHash = [];
sums.forEach(function (line) {
	const mm = line.match(/^([0-9a-f]{64})  (\S+\.kmod)$/);
	if (!mm) { return; }
	const p = path.join(MODDIR, mm[2]);
	if (!fs.existsSync(p)) { badHash.push(mm[2] + ' 不存在'); return; }
	const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
	if (h !== mm[1]) { badHash.push(mm[2] + ' 哈希不符'); }
});
ok('清单里的哈希与磁盘文件一致（命令模块是厂家原样二进制）',
	badHash.length === 0, badHash.join('；'));

/* ---------- ⑦ 两个接入点 ---------- */

ok('hotplug 脚本只处理 add 事件（不是每次 USB 变化都跑）',
	/\[ "\$ACTION" = "add" \] \|\| exit 0/.test(hotplugSrc));
ok('hotplug 覆盖 usb_device / usb_interface 两种 DEVTYPE',
	/usb_device\|usb_interface/.test(hotplugSrc));
ok('hotplug 先等接口注册完再探测（UAC 的 AC 接口在后）',
	/sleep 1\n\t\/usr\/share\/mt5700\/audio-ko\.sh load/.test(hotplugSrc));
ok('init.d 开机兜底调用一次（hotplug 未触发的场景）',
	initdSrc.includes('/usr/share/mt5700/audio-ko.sh load'));

/* ---------- ⑧ 打包期执行位 ---------- */

const mkSrc = fs.readFileSync(path.join(ROOT, 'Makefile'), 'utf8');
ok('Makefile 打包期给 hotplug 与装载器补 0755',
	mkSrc.includes('hotplug.d/usb/99-mt5700-audio') &&
	mkSrc.includes('usr/share/mt5700/audio-ko.sh'));

/* ---------- ⑨ 后缀必须是 .kmod（2026-10-22 CI 真炸过） ---------- */

/*
 * OpenWrt 的 scripts/gen-dependencies.sh 对包内每个 `-name '*.ko'` 取 .modinfo
 * 的 depends=，与包自身 .provides 做差集，差集非空即 build 失败。本批里
 * snd-usb-audio / snd-usbmidi-lib 依赖 usbcore，而 usbcore 各平台内建、没有
 * usbcore.ko 可供 ⇒ 差集恒为 {usbcore.ko}，包在任何平台都编不过。
 *
 * 这两条守的是「改了文件名却忘了改装载器」和「又有人把后缀改回去」——
 * 前者让功能静默失效（找不到文件 → return 4），后者让 CI 直接红。
 */
ok('装载器取的是 .kmod 后缀（与磁盘实际文件名一致，否则永远是"缺少模块文件"）',
	/\$dir\/\$m\.kmod/.test(koSrc));

function walkKo(dir, out) {
	fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) { walkKo(p, out); }
		else if (e.name.endsWith('.ko')) { out.push(path.relative(ROOT, p)); }
	});
	return out;
}
const strayKo = walkKo(path.join(ROOT, 'root'), []);
ok('root/ 下不存在任何 *.ko（存在即触发 OpenWrt 模块依赖扫描，usbcore.ko 必然缺失）',
	strayKo.length === 0,
	strayKo.slice(0, 3).join(', ') + (strayKo.length > 3 ? ' 等 ' + strayKo.length + ' 个' : ''));

/* ---------- 汇总 ---------- */

console.log('');
if (fails.length) {
	console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项：');
	fails.forEach(function (f) { console.log(f); });
	process.exit(1);
}
console.log('全部通过（' + pass + ' 项断言）');
