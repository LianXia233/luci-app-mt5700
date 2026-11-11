'use strict';

/* 统计来源开关 + DNS 自动识别的跨层一致性静态检查（纯 Node，无外部依赖）。
 *
 * 背景：usage_source 从 UCI 默认值一路贯穿到 Rust、ucode、rpc.js、前端视图，
 * 任何一层漏改都会表现为「界面切了但后端没切」或「参数被 LuCI 按名字丢掉」。
 * 本脚本把这些契约集中断言，同时检查旧实现是否已清理干净。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = function (rel) {
	return fs.readFileSync(path.join(root, rel), 'utf8');
};

const uci = read('root/etc/config/at-webserver');
const uc = read('root/usr/share/rpcd/ucode/mt5700.uc');
const usageRs = read('src/rust/src/usage.rs');
const configRs = read('src/rust/src/config.rs');
const mainRs = read('src/rust/src/main.rs');
const rpcServerRs = read('src/rust/src/rpcserver.rs');
const rpcJs = read('htdocs/luci-static/resources/at-webserver/rpc.js');
const viewJs = read('htdocs/luci-static/resources/view/at-webserver/network_status.js');
const initd = read('root/etc/init.d/at-webserver');

/* 一、UCI 契约 */
assert(/option usage_source 'netdev'/.test(uci), 'UCI 必须有默认来源 netdev');
assert(/option usage_reset_day '1'/.test(uci), '既有的每月清零日配置不得丢失');

/* 二、Rust 后端 */
assert(usageRs.includes('pub const SOURCE_NETDEV'), 'usage.rs 缺少 netdev 常量');
assert(usageRs.includes('pub const SOURCE_MODEM'), 'usage.rs 缺少 modem 常量');
assert(usageRs.includes('pub fn normalize_usage_source'), 'usage.rs 缺少来源归一化');
assert(usageRs.includes('fn parse_dsflowqry'), 'usage.rs 缺少 AT^DSFLOWQRY 解析');
assert(usageRs.includes('fn select_wan_netdev'), 'usage.rs 缺少 WAN 网卡自动识别');
assert(usageRs.includes('pub async fn counters'), 'usage.rs 缺少统一的计数器入口');
assert(usageRs.includes('pub async fn set_source'), 'usage.rs 缺少来源热切换');
assert(usageRs.includes('pub source: String'), 'UsageSnapshot 必须回传当前来源');
assert(usageRs.includes('MODEM_SAMPLE_INTERVAL'), '模组来源需与 2s 缓存刷新对齐');
assert(configRs.includes('pub usage_source: String'), 'Config 缺少 usage_source 字段');
assert(configRs.includes('normalize_usage_source('), 'config.rs 未做来源归一化');
assert(mainRs.includes('cache.clone()') && mainRs.includes('UsageTracker::new('),
	'启动流程必须把状态缓存注入统计器');
assert(rpcServerRs.includes('"set_source"'), '后端 usage_ctl 缺少 set_source 动作');
assert(rpcServerRs.includes('"netrate"'), '后端缺少模组来源的 netrate 方法');

/* 三、rpcd ucode */
assert(uc.includes('function detectWanDevice('), 'ucode 缺少 WAN 网卡自动识别');
assert(uc.includes('function usageSource('), 'ucode 缺少来源读取');
assert(uc.includes("args: { action: '', day: 0, source: '', _rid: '' }"),
	'usage_ctl 的 args 必须声明 source，否则 LuCI 会丢参数');
assert(uc.includes("&& action != 'set_source'"), 'usage_ctl 白名单缺少 set_source');
assert(uc.includes("params.source = 'modem'"), 'ucode 必须按白名单归一化 source');
assert(uc.indexOf('function netrateCall(') > uc.indexOf('function rpcCall('),
	'netrateCall 必须在 rpcCall 之后声明（ucode 无函数提升）');
assert(!uc.includes("return 'br-lan'"), 'ucode 不应再有回退 LAN 网桥的兜底');
assert(!uc.includes('function detectModemDevice('), '旧 detectModemDevice 应已删除');
assert(!uc.includes('function ifaceNetdev('), '旧 ifaceNetdev 应已删除');
assert(!uc.includes('function boundModemNetdev('), '旧 boundModemNetdev 应已删除');
/* 实机 ucode 的 split() 单参数返回 null，不是「按空白切分」；漏传分隔符会让
 * networkDevices() 抛 left-hand side expression is null，netrate 整条 RPC 失败。 */
['split(trim(raw));', 'split(trim(uciValueTokens(substr(lines[i], pos + 1))));',
	'split(trim(lanIfaces));', 'split(trim(wanIfaces));',
	'split(trim(candidates));'].forEach(function (s) {
		assert(!uc.includes(s), 'ucode 残留单参数 split（实机返回 null）: ' + s);
	});
assert(uc.includes("split(trim(candidates), ' ')"), 'split 必须显式给分隔符');
assert(uc.includes("if (list[i] != '') return list[i];"),
	'候选全无时必须跳过空项，保住 WAN 侧 USB 回落分支');

/* 四、前端 */
assert(rpcJs.includes("params: ['action', 'day', 'source']"),
	'rpcUsageCtl 必须声明 source 参数（LuCI 按名字组装请求）');
assert(rpcJs.includes("source: u.source === 'modem'"), 'normalizeUsage 必须保留来源字段');
assert(rpcJs.includes('function fetchUsageCtl(action, day, source)'),
	'fetchUsageCtl 必须接受 source 参数');
assert(viewJs.includes("'id': 'usage-source'"), '使用量卡片缺少来源选择控件');
assert(viewJs.includes('function setUsageSource()'), '缺少来源切换处理函数');
assert(viewJs.includes("AtWs.usageCtl('set_source', undefined, source)"),
	'来源切换必须走 usage_ctl set_source');
assert(viewJs.includes("document.getElementById('usage-source')"), '渲染逻辑需同步来源控件');
assert(viewJs.includes('var usageNetdev = (state.usage && state.usage.source !=='),
	'数据通信接口需优先取后端识别的模组物理网卡');
assert(viewJs.includes("state.usage.source !== 'modem'"),
	'modem 来源的 device 是来源标签，不能当网卡名显示');
assert(viewJs.includes('usageNetdev || state.deviceInterface || sampledNetdev'),
	'数据通信接口优先级需为 usage > netrate > 占位符');

/* 四之二、来源控件样式契约：防止再次被全局 select 深度美化吞掉 */
const viewCss = read('htdocs/luci-static/resources/at-webserver/mt5700.css');
const skeletonJs = read('htdocs/luci-static/resources/at-webserver/mt5700.js');
const compatJs = read('htdocs/luci-static/resources/at-webserver/compat.js');
const makefile = read('Makefile');
assert(viewJs.includes("'class': 'mt-usage-source', 'id': 'usage-source'"),
	'来源下拉必须使用独立样式 class');
assert(!viewJs.includes("'class': 'mt-usage-days', 'id': 'usage-source'"),
	'来源下拉不得复用天数输入框的 .mt-usage-days');
assert(viewJs.includes("'class': 'mt-usage-cell wide auto source'"),
	'来源行必须带 source 修饰');
assert(viewJs.includes("'class': 'mt-usage-unit mt-usage-source-hint'"),
	'设备名提示必须带独立修饰');
assert(viewCss.includes('.mt-usage-cell.source .mt-usage-auto select.mt-usage-source'),
	'CSS 缺少来源控件轻量样式');
assert(viewCss.includes('background-color: transparent !important'),
	'来源控件必须压过全局 select 的白底');
assert(viewCss.includes('border-radius: 4px !important') &&
	viewCss.includes('min-width: 0 !important'),
	'来源控件需为贴合文字的小方框，不设最小宽度');
assert(skeletonJs.includes("MT5700_CSS_VERSION = '2.46.9'"),
	'改 mt5700.css 必须递增 MT5700_CSS_VERSION');
assert(compatJs.includes("MT5700_UI_VERSION = '1.32.9'") &&
	makefile.includes('PKG_VERSION:=1.32.9'),
	'UI 版本戳必须与 PKG_VERSION 一致');

/* 五、DNS 下发：按 WAN 区域 + 模组物理网口自动反查，不绑定接口名 */
assert(initd.includes('dns_direct_ifaces()'), 'init.d 缺少直接承载接口反查');
assert(initd.includes('dns_alias_ifaces()'), 'init.d 缺少 IPv6 别名接口反查');
assert(initd.includes('iface_in_wan_zone()'), 'init.d 缺少 WAN 区域归属校验');
assert(initd.includes('targets4=$(dns_direct_ifaces'), 'DNS 下发目标未改用自动识别');
assert(initd.includes('for i in $targets4'), 'IPv4 DNS 需下发到所有识别出的接口');
assert(initd.includes('for i in $targets6'), 'IPv6 DNS 需下发到所有别名接口');
assert(initd.includes('found=$(dns_direct_ifaces | head -n 1)'),
	'数据通信接口自动判断需优先按模组物理网卡 + WAN 区域');
assert(initd.includes('[ -n "$found" ] || found=$(modem_direct_ifaces | head -n 1)'),
	'WAN 归属无结果时需回落到纯物理网卡反查');
assert(!initd.includes('lo|br-*|eth0|eth1'), 'USB 探测不应再硬编码 eth0/eth1');

/* 六、默认 WAN 口物理网卡回落（无模组专用 WAN 口的设备） */
assert(usageRs.includes('resolve_netdev("wan", &net)'),
	'Rust 需按默认 WAN 口反查物理网卡');
assert(usageRs.includes('wan_ifaces.iter().any(|i| i == "wan")'),
	'Rust 需校验默认 WAN 口确实属于 WAN 区域');
assert(uc.includes("resolveNetdev('wan', devs)"),
	'ucode 需按默认 WAN 口反查物理网卡');
assert(uc.includes("index(' ' + trim(wanIfaces) + ' ', ' wan ') >= 0"),
	'ucode 需校验默认 WAN 口确实属于 WAN 区域');
assert(viewJs.includes('回落默认 WAN 口物理网卡'),
	'数据通信接口提示需说明默认 WAN 口回落判据');

/* 七、流量统计图表必须跟随统计来源切换 */
const sliceViewFn = function (name) {
	const marker = '\n\t\tfunction ' + name + '(';
	const start = viewJs.indexOf(marker);
	assert(start >= 0, '视图缺少函数 ' + name);
	const next = viewJs.indexOf('\n\t\tfunction ', start + marker.length);
	return viewJs.slice(start, next < 0 ? viewJs.length : next);
};
const fnRender = sliceViewFn('renderSpeedUI');
const fnPush = sliceViewFn('pushTrafficSample');
const fnReset = sliceViewFn('resetTrafficSeries');
const fnSetSource = sliceViewFn('setUsageSource');
const fnSampleUsage = sliceViewFn('sampleUsage');
const fnSampleRate = sliceViewFn('sampleRate');
assert(!fnRender.includes('sparkDown.push'),
	'renderSpeedUI 被多处复用，不能在这里推火花线点');
assert(fnRender.includes("'实时 · ' + srcLabel"),
	'流量统计卡片需显示当前统计来源');
assert(fnRender.includes("state.usage.source === 'modem'"),
	'renderSpeedUI 需按来源取标签');
assert(fnPush.includes('sparkDown.push(down > 0 ? down : 0)') &&
	fnPush.includes('sparkUp.push(up > 0 ? up : 0)'),
	'火花线需由采样函数推进');
assert(fnReset.includes('sparkSource = source'),
	'resetTrafficSeries 需切换图表来源');
assert(fnReset.includes('sparkDown = zeroSparkSeries()') &&
	fnReset.includes('sparkUp = zeroSparkSeries()'),
	'切源需清空两套火花线历史，避免虚假尖峰');
assert(fnReset.includes('rateSample = null'), '切源需重置速率采样基线');
assert(fnSetSource.includes('resetTrafficSeries(r.usage.source)') &&
	fnSetSource.includes('sampleRate()'),
	'来源切换成功后需立即换源并按新来源重新采样');
assert(fnSampleUsage.includes('prevSource !== r.usage.source'),
	'使用量轮询需检测页面外来源变化');
assert(fnSampleRate.includes('sparkSource !== src'),
	'速率采样需校验图表来源一致');
assert(fnSampleRate.includes('rateSample.source === src'),
	'采样基线必须绑定来源，两套计数器不可混算');
assert(fnSampleRate.includes('pushTrafficSample('),
	'速率采样需推进火花线点');
assert(fnSampleRate.includes("src !== 'modem'"),
	'modem 来源的 DS 标签不能写进数据通信接口');
assert(viewJs.includes("'id': 'traffic-source-tag'"),
	'流量统计卡片需有来源标识元素');
assert(uc.includes("if (usageSource() == 'modem')") && uc.includes("rpcCall('netrate'"),
	'ucode 的 netrate 必须按来源分流，图表数据才真的跟着源走');

/* 八、旧实现残留（冗余检查） */
assert(!usageRs.includes('FALLBACK_NETDEV'), 'usage.rs 残留 LAN 网桥兜底常量');
assert(!usageRs.includes('fn detect_netdev('), 'usage.rs 残留旧网卡选择入口');
assert(!usageRs.includes('fn select_netdev('), 'usage.rs 残留旧优先级函数');
assert(!usageRs.includes('fn iface_bound_to('), 'usage.rs 残留旧绑定判定');
assert(!usageRs.includes('fn modem_bound_netdev('), 'usage.rs 残留旧模组绑定判定');
assert(!usageRs.includes('fn first_netdev('), 'usage.rs 残留旧 UCI 取值解析');

console.log('usage source / DNS target consistency: 50+ checks passed');
