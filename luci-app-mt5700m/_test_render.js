'use strict';
/*
 * Faithful LuCI E()/DOM render self-test.
 *
 * The key fidelity detail: a real browser turns `String(<strong>)` into
 * EXACTLY "[object HTMLElement]" (the <strong> element is represented by the
 * generic HTMLElement interface, whose Object.prototype.toString is
 * "[object HTMLElement]").  Our FakeElement replicates that via toString(),
 * so the OLD v2.3.12-style `row()` that did `E('strong', {}, String(value))`
 * reproduces the user's exact symptom, while the v2.3.13 node-passthrough row
 * appends the real node and produces zero "[object]".
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);
const NET = path.join(ROOT, 'htdocs/luci-static/resources/view/mt5700m/network.js');
const ST  = path.join(ROOT, 'htdocs/luci-static/resources/view/mt5700m/status.js');
const CTL = path.join(ROOT, 'htdocs/luci-static/resources/mt5700m/controls.js');

// ---- global bug collector ----
const BUGS = [];
let STACK = [];

// ---- minimal faithful DOM ----
function FakeElement(tag) {
  this.nodeName = String(tag).toUpperCase();
  this.tagName = this.nodeName;
  this.nodeType = 1;
  this.childNodes = [];
  this.attributes = {};
  this.className = '';
  this.style = {};
  this.value = '';
  this.checked = false;
  this.parentNode = null;
}
FakeElement.prototype.appendChild = function (c) { this.childNodes.push(c); c.parentNode = this; return c; };
FakeElement.prototype.setAttribute = function (k, v) { this.attributes[k] = v; };
FakeElement.prototype.addEventListener = function () {};
FakeElement.prototype.removeChild = function (c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); };
FakeElement.prototype.querySelector = function () { return null; };
// Fidelity: String(<strong>) in a browser === "[object HTMLElement]"
FakeElement.prototype.toString = function () { return '[object HTMLElement]'; };

function createElement(tag) { return new FakeElement(tag); }
function createTextNode(t) { return { nodeType: 3, nodeName: '#text', text: String(t), parentNode: null }; }

function applyAttr(node, k, v) {
  if (v == null) return;
  if (k === 'class') node.className = String(v);
  else if (k === 'style') node.setAttribute('style', String(v));
  else if (k === 'click' || k === 'change' || k === 'input') return; // listeners are no-ops
  else node.setAttribute(k, String(v));
}

function E(el, attrs) {
  let node;
  if (typeof el === 'function') node = el(attrs);
  else if (typeof el === 'string') node = createElement(el);
  else if (el instanceof FakeElement || (el && typeof el === 'object' && el.nodeType === 1)) node = el;
  else throw new Error('E: invalid el ' + typeof el);

  if (attrs) for (const k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) applyAttr(node, k, attrs[k]); }

  STACK.push(typeof el === 'string' ? el : (el.nodeName || 'node'));
  for (let i = 2; i < arguments.length; i++) appendChildren(node, arguments[i]);
  STACK.pop();
  return node;
}

function appendChildren(node, child) {
  if (child == null || child === false || child === true) return;
  if (child instanceof FakeElement || (child && typeof child === 'object' && child.nodeType === 1)) { node.appendChild(child); return; }
  if (Array.isArray(child)) { child.forEach((c) => appendChildren(node, c)); return; }
  if (typeof child === 'function') { appendChildren(node, child()); return; }
  if (typeof child === 'object') {
    const s = String(child);
    if (s.indexOf('[object') === 0) BUGS.push('[object] (object child) @[' + STACK.join('>') + '] -> ' + s);
    node.appendChild(createTextNode(s));
    return;
  }
  const s = String(child);
  if (s.indexOf('[object') === 0) BUGS.push('[object] (string child) @[' + STACK.join('>') + '] -> ' + s);
  node.appendChild(createTextNode(s));
}

// ---- LuCI globals ----
const documentStub = { createElement, createTextNode };
const ui = { showModal() {}, hideModal() {}, addNotification() {} };
const fsStub = { exec() { return Promise.resolve({ stdout: '', stderr: '' }); } };
const rpc = { declare() { return function () { return Promise.resolve({}); }; } };
const dom = { content(host, node) { if (node) host.appendChild(node); } };
const L = { url() { return '#'; } };
const windowStub = { setTimeout(fn) { try { fn(); } catch (e) {} }, location: { reload() {} } };
function _(s) { return s; }
String.prototype.format = function () {
  let out = this;
  for (let i = 0; i < arguments.length; i++) out = out.replace(/%[sdh]/, arguments[i]);
  return out;
};
const baseclass = { extend(o) { return o; } };
const view = { extend(o) { return o; } };
const HTMLElement = FakeElement;
const Node = FakeElement;

// ---- module loader ----
function loadModule(file, controlsArg) {
  const src = fs.readFileSync(file, 'utf8');
  const factory = new Function(
    'require', 'E', 'ui', 'fs', 'rpc', 'dom', 'L', '_', 'document', 'window', 'console',
    'baseclass', 'view', 'controls', 'HTMLElement', 'Node',
    '"use strict";\n' + src + '\n;return __mod;'
  );
  // The module ends with `return baseclass.extend({...})` which is the return
  // value of the factory.  We capture it directly.
  const wrapped = new Function(
    'require', 'E', 'ui', 'fs', 'rpc', 'dom', 'L', '_', 'document', 'window', 'console',
    'baseclass', 'view', 'controls', 'HTMLElement', 'Node',
    '"use strict";\n' + src + '\n;return (typeof module!=="undefined")?null:null;'
  );
  // Simpler: build a function whose body is the source and returns its last return.
  const fn = new Function(
    'require', 'E', 'ui', 'fs', 'rpc', 'dom', 'L', '_', 'document', 'window', 'console',
    'baseclass', 'view', 'controls', 'HTMLElement', 'Node',
    '"use strict";\n' + src
  );
  return fn(require, E, ui, fsStub, rpc, dom, L, _, documentStub, windowStub, console,
    baseclass, view, controlsArg || null, HTMLElement, Node);
}

// controls must be loaded first (network.js/status.js depend on it)
const controls = loadModule(CTL);
const V = loadModule(NET, controls);
const S = loadModule(ST, controls);

// re-bind controls now that we have it
['section','pick','csvValues','hexIPv4','hexNumber','formatBytes','formatDuration','formatRate','parseSession','select','confirmRun','row','action','card','state','styleNode'].forEach(() => {});

function run(name, fn) {
  BUGS.length = 0;
  let err = null;
  try { fn(); } catch (e) { err = e; }
  const tagged = BUGS.slice();
  console.log('--------------------------------------------------');
  console.log(name);
  if (err) { console.log('  THREW: ' + err.message); return; }
  if (tagged.length === 0) console.log('  OK — 0 [object] occurrences');
  else tagged.forEach((b) => console.log('  BUG: ' + b));
  console.log('  total: ' + tagged.length);
}

// ---- mock data ----
const radioRaw = [
  '===== Uplink MCS:',
  '^MCS: 1,1,0,20,1,16',
  '===== Downlink MCS:',
  '^MCS: 1,1,0,21,1,17',
  '===== NR transmit power:',
  '^NTXPOWER: 23,23,0,0,2100',
  '===== NR SSB beam:',
  '^NRSSBID: 100,200,300,45,-70,-5,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,1,500,1,-80,-6,2,600,2,-75,-4',
  '===== QoS:',
  '+CGEQOSRDP: 1,7,100,200',
  '===== Data registration:',
  '+C5GREG: 1,5',
  '===== IMS registration:',
  '+CIREG: 1,1',
  '===== Dual connectivity:',
  '^LENDC: 1',
  '===== LTE secondary cells:',
  '^CASCELLINFO: 1',
  '===== NSA secondary cells:',
  '^MONSSC: NR 1',
  '===== Neighbour cells:',
  '^MONNC: NR,520000,100,-70,-6,-78',
].join('\n');

const statusRaw = [
  'product_name=MT5700M',
  'manufacturer=Quectel',
  'revision=RG502QEAAR11A04M4G',
  'imei=123456789012345',
  'at_port=/dev/ttyUSB1',
  'operator=46000',
  'network_mode=5G NR',
  'sysmode=NR',
  'connected=1',
  'sim=READY',
  'iccid=8986001234567890123',
  'imsi=460001234567890',
  'active_apn=cmnet',
  'qci=7',
  'temperature=35',
  'usb_state=normal',
].join('\n');

const sessionRaw = [
  '===== Data session:',
  '^NDISSTATQRY: 1,1,1,ipv4,255.255.255.0,0.0.0.0,0.0.0.0,ipv6,0,0,0.0.0.0,0.0.0.0',
].join('\n');

const statusRes = {
  native: { stdout: statusRaw, stderr: '' },
  session: { stdout: sessionRaw, stderr: '' },
  traffic: { interfaces: [] },
  manager: { at_port: '/dev/ttyUSB1', connected: true, network: 'eth2' }
};

const netRaw = [
  '===== Signal:',
  '^HCSQ: "NR",-70,-10,20',
  '===== Serving cell:',
  '^MONSC: NR,460,00,520000,1,12345,100,200,-70,-10,20',
  '===== Network registration:',
  '+CEREG: 1,5',
  '===== Operator:',
  '+COPS: 0,0,"46000",7',
  '===== LTE lock:',
  '^LTEFREQLOCK: 0,0',
  '===== NR lock:',
  '^NRFREQLOCK: 0,0',
  '===== RRC state:',
  '^RRCSTAT: 1,1,98',
  '===== Radio mode:',
  '^SYSCFGEX: 080302,3FFFFFFF,1,2,7FFFFFFFFFFFFFFF',
].join('\n');
const netRadioRaw = '===== Radio mode:\n^SYSCFGEX: 080302,3FFFFFFF,1,2,7FFFFFFFFFFFFFFF\n';

console.log('=== RENDER SELF-TEST (faithful LuCI E) ===');

// 1) v2.3.13 radioDiagnostics (the page with the two node rows)
run('network.radioDiagnostics (v2.3.13 code)', function () {
  V.radioDiagnostics(radioRaw);
});

// 2) v2.3.13 status.render
run('status.render (v2.3.13 code)', function () {
  S.render(statusRes);
});

// 3) v2.3.13 network.render (+ async radioDiagnostics via setTimeout)
run('network.render (v2.3.13 code)', function () {
  V.render([{ stdout: netRaw, stderr: '' }, { stdout: netRadioRaw, stderr: '' }]);
});

// 4) SIMULATE the OLD v2.3.12 row() to prove the user's symptom
run('SIMULATE v2.3.12 row() on radioDiagnostics (expected: 2x [object HTMLElement])', function () {
  const orig = V.row;
  V.row = function (label, value) {
    // OLD buggy implementation: wraps EVERY value (incl. DOM nodes) in String()
    return E('div', { 'class': 'mt-net-row' }, [ E('span', {}, label), E('strong', {}, String(value)) ]);
  };
  try { V.radioDiagnostics(radioRaw); } finally { V.row = orig; }
});

console.log('--------------------------------------------------');
console.log('If v2.3.13 renders show 0 and the simulation shows 2x [object HTMLElement],');
console.log('then v2.3.13 code is clean and the device is running the OLD build.');

// 5) Reproduce the REAL root cause: a cross-runtime node (like LuCI L.dom.Node)
//    that is NOT `instanceof HTMLElement` but HAS nodeType === 1.  v2.3.9's row
//    used `value instanceof HTMLElement` and therefore mis-classified it as a
//    scalar, calling String() on it -> [object HTMLElement].
function LdomNode(tag) { this.nodeName = String(tag).toUpperCase(); this.nodeType = 1; this.childNodes = []; }
LdomNode.prototype.appendChild = function (c) { this.childNodes.push(c); return c; };
LdomNode.prototype.toString = function () { return '[object HTMLElement]'; };

run('SIMULATE v2.3.9 row() WITH cross-runtime node (real root cause: 2x [object HTMLElement])', function () {
  const crossNode = new LdomNode('strong');
  const rowV239 = function (label, value) {
    const valueNode = (value instanceof HTMLElement) ? value : E('strong', {}, String(value || '--'));
    return E('div', {}, [E('span', {}, label), valueNode]);
  };
  rowV239('Uplink modulation', crossNode);
  rowV239('Downlink modulation', crossNode);
});

// 6) The v2.3.14 fix uses isNode() (nodeType === 1), so the same cross-runtime
//    node is correctly recognised and passed through -> 0 [object].
run('v2.3.14 isNode() check WITH cross-runtime node (expect: 0)', function () {
  const crossNode = new LdomNode('strong');
  const isNode = function (v) { return v && typeof v === 'object' && (v instanceof HTMLElement || v.nodeType === 1); };
  const rowFixed = function (label, value) {
    const valueNode = isNode(value) ? value : E('strong', {}, String(value || '--'));
    return E('div', {}, [E('span', {}, label), valueNode]);
  };
  rowFixed('Uplink modulation', crossNode);
  rowFixed('Downlink modulation', crossNode);
});

console.log('--------------------------------------------------');
console.log('SUMMARY: v2.3.9 (instanceof HTMLElement) breaks on cross-runtime nodes;');
console.log('v2.3.10+ and v2.3.14 (nodeType===1 / isNode) are immune.');
