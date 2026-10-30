'use strict';
/**
 * Parse.parseNdisStat 单测
 *
 * 拨号页（判断是否已拨上）与扫频页（扫频会断网、需二次确认）原先各写了一份
 * `^NDISSTATQRY:\s*1\s*,\s*(\d+)` 并各自判定，同一条口径两处维护。收口到
 * parse.js 之后，这里逐例证明新实现与原正则**完全等价**（含 null/undefined、
 * 大小写、多空白、多行回包），并钉住「取第二字段」这条易错点。
 *
 * 运行：node tests/parse-ndis-test.js
 */

const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver');
let pass = 0;
let fail = 0;

function check(name, cond, detail) {
	if (cond) { pass++; console.log('PASS  ' + name); }
	else { fail++; console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}

(function () {
	const src = fs.readFileSync(path.join(libDir, 'parse.js'), 'utf8');
	const factory = new Function('L', 'window', 'document', src);
	const L_STUB = { Class: { extend: function (o) { return function ParseClass() { Object.assign(this, o); }; } } };
	const Parse = new (factory(L_STUB, {}, {}))();

	/* 原实现（dial.js / scan.js 改造前逐字抄写） */
	const legacyRaw = (raw) => {
		const m = String(raw).replace(/\r/g, '').match(/\^NDISSTATQRY:\s*1\s*,\s*(\d+)/i);
		return !!m && m[1] === '1';
	};

	const cases = [
		'^NDISSTATQRY: 1,1',
		'^NDISSTATQRY: 1,0',
		'^NDISSTATQRY:1,1',
		'^NDISSTATQRY:  1 , 1',
		'\r\n^NDISSTATQRY: 1,1\r\n\r\nOK\r\n',
		'^NDISSTATQRY: 2,1',
		'^NDISSTATQRY: 1',
		'^NDISSTATQRY: 1,',
		'^ndisstatqry: 1,1',
		'ERROR',
		'',
		null,
		undefined
	];
	let same = true;
	const diffs = [];
	cases.forEach(function (c) {
		const a = legacyRaw(c);
		const b = Parse.parseNdisStat(c) === '1';
		if (a !== b) { same = false; diffs.push(JSON.stringify(c) + ': old=' + a + ' new=' + b); }
	});
	check('parseNdisStat 与原正则逐例等价（' + cases.length + ' 例，含 null/undefined/大小写/多空白）',
		same, diffs.join('; '));
	check('parseNdisStat 返回第二字段（CID=1 且 stat=1 → "1"）',
		Parse.parseNdisStat('^NDISSTATQRY: 1,1,0,0') === '1');
	check('CID 非 1 时不认（^NDISSTATQRY: 2,1 → null）',
		Parse.parseNdisStat('^NDISSTATQRY: 2,1') === null);
	check('无回包返回 null', Parse.parseNdisStat('OK') === null && Parse.parseNdisStat(null) === null);
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
