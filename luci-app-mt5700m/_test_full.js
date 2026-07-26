/* Faithful LuCI E() simulation to locate [object ...] render bugs.
 * LuCI's real E() only recognises an object as a DOM element when it has a
 * string `nodeName` (or is instanceof Element). Anything else (plain object,
 * or — worse — a node that gets explicitly String()-ed) is coerced with
 * String(child) -> "[object Object]" / "[object HTMLElement]".
 * We replicate that exactly, track the build stack, and record every
 * non-element object that reaches a child position. */
const fs = require('fs'), vm = require('vm');

const issues = [];
const buildStack = [];

function makeNode(tag) {
  return {
    tag: tag, nodeName: (tag || 'div').toUpperCase(), attrs: {}, children: [],
    nodeType: 1,
    appendChild: function (c) { this.children.push(c); },
    addEventListener: function () {}, style: {}, closest: function () { return null; },
    // Reproduce the real browser node toString so explicit String(node) is caught
    toString: function () { return '[object HTMLElement]'; }
  };
}
// Controls in the real LuCI return genuine DOM nodes (with nodeName), so they
// must pass isElement. Our mock mirrors that or it spits false [object] noise.
function ctrlNode(tag) {
  var n = makeNode(tag);
  return n;
}
function isElement(o) { return o && typeof o === 'object' && (typeof o.nodeName === 'string'); }
function addChild(node, c) {
  if (c == null || c === false || c === true) return;
  if (Array.isArray(c)) { c.forEach(x => addChild(node, x)); return; }
  if (typeof c === 'function') { addChild(node, c()); return; }
  if (typeof c === 'string' || typeof c === 'number') { node.children.push({ text: String(c) }); return; }
  if (isElement(c)) { node.children.push(c); return; }
  // non-element object -> LuCI stringifies it
  const s = String(c);
  if (s.indexOf('[object') === 0)
    issues.push('NON-ELEMENT @ [' + buildStack.join(' > ') + '] -> ' + s);
  node.children.push({ text: s });
}
function E(tag, attrs) {
  const node = makeNode(tag);
  node.attrs = attrs || {};
  buildStack.push(tag);
  for (let i = 2; i < arguments.length; i++) addChild(node, arguments[i]);
  buildStack.pop();
  return node;
}
function findText(node, acc) {
  acc = acc || [];
  if (!node || typeof node !== 'object') return acc;
  if (node.text != null) acc.push(node.text);
  (node.children || []).forEach(c => findText(c, acc));
  return acc;
}

function makeSandbox() {
  const controls = {
    section: (t) => t,
    pick: (t, r, f) => f,
    select: () => ctrlNode('select'),
    card: (t, d, b) => { var n = ctrlNode('div'); n.children = [].concat(b || []); return n; },
    row: (l, i) => { var n = ctrlNode('div'); n.children = [i]; return n; },
    action: () => ctrlNode('button'),
    state: () => ctrlNode('div'),
    confirmRun: () => undefined,
    styleNode: () => ctrlNode('style'),
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
    document: {}, Event: function () {}, HTMLElement: function () {},
    encodeURIComponent: encodeURIComponent, L: { url: () => '' }, console: console
  };
}
function loadView(file) {
  let src = fs.readFileSync(file, 'utf8').replace(/return view\.extend\(/, 'var __V = view.extend(');
  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  vm.runInContext("String.prototype.format=function(){var a=[this].concat([].slice.call(arguments));var i=0;return (''+a[0]).replace(/%[sd]/g,function(){i++;return i<a.length?a[i]:''});};", sandbox);
  vm.runInContext(src, sandbox, { filename: file });
  return { V: sandbox.__V, globals: sandbox };
}

const base = 'htdocs/luci-static/resources/view/mt5700m';
const SN = loadView(base + '/network.js');
const SS = loadView(base + '/status.js');
const NV = SN.V, NS = SN.globals;
const SV = SS.V;

function run(name, fn) {
  const before = issues.length;
  let out;
  try { out = fn(); } catch (e) { issues.push('THROW @ ' + name + ': ' + e.message); return; }
  const texts = findText(out).filter(t => t.indexOf('[object') === 0);
  console.log(name + ': ' + (texts.length ? 'HAS [object]: ' + JSON.stringify(texts) : 'clean') +
    '  (non-element issues this run: ' + (issues.length - before) + ')');
}

// 1) network.js render (main Network & Cell page)
const netStatus = [
  'Operator: +COPS: 0,2,,46000,7\n' +
  'Serving cell: ^MONSC: NR,460,11,630000,30,123456,100,7, -85,-10,20\n' +
  'Network registration: +CEREG: 0,1\n' +
  'Signal: ^HCSQ: "NR",-85,-10,20\n' +
  'RRC state: ^RRCSTAT: 1,98\n' +
  'LTE lock: ^LTEFREQLOCK: 0\n' +
  'NR lock: ^NRFREQLOCK: 0\n',
  'Radio mode: ^SYSCFGEX: 08,3FFFFFFF,1,2,7FFFFFFFFFFFFFFF\n' +
  '5G access mode: ^C5GOPTION: 1,0,1\n' +
  'NR carrier aggregation: ^NRRCCAPQRY: 3,1\n' +
  'VoNR: ^NRRCCAPQRY: 2,0\n' +
  'DSS: ^NRRCCAPQRY: 5,0,0\n'
].join('\n');
run('network.render', () => NV.render([{ stdout: netStatus }, { stdout: netStatus }]));

// 2) network.js radioDiagnostics (async SBB / neighbours panel)
const diagRaw = [
  '===== NR SSB beam:',
  '^NRSSBID: 630000,1,100,-85,18,5,0,-95,1,-92,2,-88,3,-85,4,-80,5,-78,6,-75,7,-70,0,2,0,630500,101,-90,10,0',
  '===== Neighbour cells:',
  '^MONNC: NR,630000,100,-85,-12,18',
  '^MONNC: NR,630500,101,-90,-15,10',
  '^MONNC: LTE,1850,200,-80,-10,25',
  '===== Uplink MCS:',
  '^MCS: 1,1,3,256QAM,3,256QAM',
  '===== Downlink MCS:',
  '^MCS: 1,1,3,256QAM,3,256QAM',
  '===== QoS:',
  '+CGEQOSRDP: 1,9,',
  '===== NR transmit power:',
  '^NTXPOWER: 10,10,0,0,2100',
  '===== Data registration:',
  '+C5GREG: 0,1',
  '===== IMS registration:',
  '+CIREG: 1,1',
  '===== Dual connectivity:',
  '^LENDC: 1'
].join('\n');
run('network.radioDiagnostics', () => NV.radioDiagnostics(diagRaw));
run('network.renderCellScan', () => NS.renderCellScan(diagRaw));

// 3) status.js render (home page)
const statusNative = 'operator=46000\nsysmode=NR\nnetwork_mode=5G NR\nat_port=/dev/ttyUSB2\nusb_state=normal\n' +
  'sim=READY\nimei=123456789012345\nimsi=460001234567890\niccid=8986001234567890\nphone_number_state=not_stored\n' +
  'ambr_down_mbps=500\nambr_up_mbps=60\nproduct_name=MT5700M\nrevision=1.0\nmanufacturer=Quectel\n' +
  'rsrp=-85\nrsrq=-10\nsinr=20\ntemperature=42\nconnected=1\n';
const sessionOut = 'capability=LTE\nmtu=1500\nipv4Connected=1\nipv4Address=10.0.0.2\nipv6Connected=0\nipv6Address=\n';
run('status.render', () => SV.render({
  native: { stdout: statusNative, stderr: '' },
  manager: { at_port: '/dev/ttyUSB2', connected: true, network: 'eth2' },
  session: { stdout: sessionOut },
  traffic: {}
}));

console.log('\n=== ALL NON-ELEMENT ISSUES (' + issues.length + ') ===');
issues.forEach(i => console.log('  ' + i));
console.log('\nRESULT: ' + (issues.length ? 'FAIL' : 'PASS'));
process.exit(issues.length ? 1 : 0);
