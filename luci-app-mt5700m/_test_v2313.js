/* Self-check harness for v2.3.13 fix:
 * - row()/infoRow() must pass DOM nodes straight through (no String(node) -> [object HTMLElement])
 * - operatorInfo() must resolve numeric / full +COPS tuples to Chinese name + logo
 * The mock E() node's toString() returns "[object HTMLElement]" to reproduce the
 * real-LuCI environment where String(node) yields that exact string. */
const fs = require('fs'), vm = require('vm');

const issues = [];

function makeNode(tag) {
  return {
    tag: tag, attrs: {}, children: [], nodeType: 1,
    appendChild: function (c) { this.children.push(c); },
    addEventListener: function () {}, style: {}, closest: function () { return null; },
    // Reproduce the real LuCI node toString behaviour
    toString: function () { return '[object HTMLElement]'; }
  };
}
function E(tag, attrs) {
  const node = makeNode(tag);
  node.attrs = attrs || {};
  for (let i = 2; i < arguments.length; i++) addChild(node, arguments[i]);
  return node;
}
function addChild(node, c) {
  if (c == null || c === false || c === true) return;
  if (Array.isArray(c)) { c.forEach(x => addChild(node, x)); return; }
  const t = typeof c;
  if (t === 'object') {
    if (c.nodeType === 1 || typeof c.appendChild === 'function') node.appendChild(c);
    else { issues.push('NON-NODE object passed to E(): ' + (c.tag || JSON.stringify(Object.keys(c)))); node.appendChild(c); }
  } else if (t === 'function') {
    addChild(node, c());
  } else {
    const s = String(c);
    if (s.indexOf('[object ') === 0) issues.push('[object...] TEXT NODE: ' + s);
    node.appendChild({ text: s });
  }
}
function findText(node, acc) {
  acc = acc || [];
  if (!node || typeof node !== 'object') return acc;
  if (node.text != null) acc.push(node.text);
  (node.children || []).forEach(c => findText(c, acc));
  return acc;
}
function findNodes(node, acc) {
  acc = acc || [];
  if (!node || typeof node !== 'object' || node.text != null) return acc;
  if (node.nodeType === 1) acc.push(node);
  (node.children || []).forEach(c => findNodes(c, acc));
  return acc;
}

function makeSandbox() {
  const controls = {
    section: (t) => t,
    pick: (t, r, f) => f,
    select: () => ({ nodeType: 1, tag: 'select', value: '', addEventListener() {}, dispatchEvent() {} }),
    card: (t, d, b) => ({ nodeType: 1, tag: 'div', children: [].concat(b || []) }),
    row: (l, i) => ({ nodeType: 1, tag: 'div', children: [i] }),
    action: () => ({ nodeType: 1, tag: 'button', children: [] }),
    state: () => ({ nodeType: 1, tag: 'div', children: [] }),
    confirmRun: () => undefined,
    styleNode: () => ({ nodeType: 1, tag: 'style', children: [] }),
    parseSession: () => ({}),
    formatBytes: (v) => '' + v
  };
  return {
    view: { extend: (o) => o },
    E: E, controls: controls,
    fs: { exec: () => Promise.resolve({ stdout: '', stderr: '' }) },
    dom: { content() {} },
    ui: { showModal() {}, hideModal() {}, addNotification() {} },
    rpc: { declare: () => (() => Promise.resolve({})) },
    _: (s) => s,
    window: { setTimeout: () => 0, location: { reload() {} } },
    document: {},
    Event: function () {},
    HTMLElement: function () {},
    encodeURIComponent: encodeURIComponent,
    L: { url: () => '' },
    console: console
  };
}

function loadView(file) {
  let src = fs.readFileSync(file, 'utf8').replace(/return view\.extend\(/, 'var __V = view.extend(');
  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  vm.runInContext("String.prototype.format=function(){var a=[this].concat([].slice.call(arguments));var i=0;return (''+a[0]).replace(/%[sd]/g,function(){i++;return i<a.length?a[i]:''});};", sandbox);
  vm.runInContext(src, sandbox, { filename: file });
  return sandbox.__V;
}

const base = 'htdocs/luci-static/resources/view/mt5700m';
const V = loadView(base + '/network.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('ok  - ' + name); }
  else { fail++; console.log('FAIL- ' + name + (extra ? ' :: ' + extra : '')); }
}

// 1) row passes a node straight through (no [object HTMLElement])
const nodeChild = E('strong', {}, 'MCS 3 · 256QAM');
const rowRes = V.row('Uplink modulation', nodeChild);
const rowTexts = findText(rowRes);
check('row passes node through (no [object HTMLElement])',
  !rowTexts.some(t => t.indexOf('[object') === 0),
  'texts=' + JSON.stringify(rowTexts));
const rowNodes = findNodes(rowRes);
check('row result contains the original node', rowNodes.indexOf(nodeChild) !== -1);

// 2) row wraps scalar values in <strong>
const rowScalar = V.row('PCI', '123');
const scalarTexts = findText(rowScalar);
check('row scalar value shown as text', scalarTexts.indexOf('123') !== -1, JSON.stringify(scalarTexts));
check('row scalar not [object]', !scalarTexts.some(t => t.indexOf('[object') === 0));

// 3) operatorInfo resolves numeric / full +COPS tuple
const cases = [
  ['46000', '中国移动'], ['0,2,,46000,7', '中国移动'],
  ['46001', '中国联通'], ['0,0,"46001",7', '中国联通'],
  ['46003', '中国电信'], ['China Mobile', '中国移动'], ['CMCC', '中国移动']
];
cases.forEach(([inp, expect]) => {
  const r = V.operatorInfo(inp);
  check('operatorInfo("' + inp + '") -> ' + expect, r.name === expect && !!r.logo,
    'got name=' + r.name + ' logo=' + (r.logo ? 'yes' : 'no'));
});
const unk = V.operatorInfo('SomeForeign');
check('operatorInfo unknown -> no logo', unk.logo === null);

// 4) full radioDiagnostics render (SBB + neighbours) must not emit [object HTMLElement]
const ssbRaw = [
  '===== NR SSB beam:',
  '^NRSSBID: 630000,1,100,-85,18,5,0,-95,1,-92,2,-88,3,-85,4,-80,5,-78,6,-75,7,-70,0,2,0,630500,101,-90,10,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0',
  '===== Neighbour cells:',
  '^MONNC: NR,630000,100,-85,-12,18',
  '^MONNC: NR,630500,101,-90,-15,10',
  '^MONNC: LTE,1850,200,-80,-10,25',
  '===== Uplink MCS:',
  '^ULMCS: 1,3,256QAM',
  '===== Downlink MCS:',
  '^DLMCS: 1,3,256QAM'
].join('\n');
const diag = V.radioDiagnostics(ssbRaw);
const diagTexts = findText(diag);
check('radioDiagnostics no [object HTMLElement] text',
  !diagTexts.some(t => t.indexOf('[object') === 0),
  'texts=' + JSON.stringify(diagTexts.filter(t => t.indexOf('[object') === 0)));
check('radioDiagnostics no NON-NODE object to E', !issues.some(i => i.indexOf('NON-NODE') === 0),
  issues.filter(i => i.indexOf('NON-NODE') === 0).join(' | '));

// 5) status.js infoRow passes nodes through and operatorInfo resolves same cases
const VS = loadView(base + '/status.js');
const sNode = E('strong', {}, 'QCI 9');
const sRowRes = VS.infoRow('QCI', sNode);
const sRowTexts = findText(sRowRes);
check('status.infoRow passes node through (no [object HTMLElement])',
  !sRowTexts.some(t => t.indexOf('[object') === 0),
  'texts=' + JSON.stringify(sRowTexts));
const sRowNodes = findNodes(sRowRes);
check('status.infoRow contains original node', sRowNodes.indexOf(sNode) !== -1);
const sScalar = VS.infoRow('ICCID', '8986001234567890');
check('status.infoRow scalar shown as text', findText(sScalar).indexOf('8986001234567890') !== -1);
[
  ['46000', '中国移动'], ['0,2,,46000,7', '中国移动'], ['46001', '中国联通'],
  ['46003', '中国电信'], ['China Mobile', '中国移动'], ['CMCC', '中国移动']
].forEach(([inp, expect]) => {
  const r = VS.operatorInfo(inp);
  check('status.operatorInfo("' + inp + '") -> ' + expect, r.name === expect && !!r.logo,
    'got name=' + r.name + ' logo=' + (r.logo ? 'yes' : 'no'));
});
check('status.operatorInfo unknown -> no logo', VS.operatorInfo('OtherX').logo === null);

console.log('\nissues array (' + issues.length + '):');
issues.forEach(i => console.log('  ' + i));
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
