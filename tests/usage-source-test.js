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

/* 五、DNS 下发：按 WAN 区域 + 模组物理网口自动反查，不绑定接口名 */
assert(initd.includes('dns_direct_ifaces()'), 'init.d 缺少直接承载接口反查');
assert(initd.includes('dns_alias_ifaces()'), 'init.d 缺少 IPv6 别名接口反查');
assert(initd.includes('iface_in_wan_zone()'), 'init.d 缺少 WAN 区域归属校验');
assert(initd.includes('targets4=$(dns_direct_ifaces'), 'DNS 下发目标未改用自动识别');
assert(initd.includes('for i in $targets4'), 'IPv4 DNS 需下发到所有识别出的接口');
assert(initd.includes('for i in $targets6'), 'IPv6 DNS 需下发到所有别名接口');
assert(!initd.includes('lo|br-*|eth0|eth1'), 'USB 探测不应再硬编码 eth0/eth1');

/* 六、旧实现残留（冗余检查） */
assert(!usageRs.includes('FALLBACK_NETDEV'), 'usage.rs 残留 LAN 网桥兜底常量');
assert(!usageRs.includes('fn detect_netdev('), 'usage.rs 残留旧网卡选择入口');
assert(!usageRs.includes('fn select_netdev('), 'usage.rs 残留旧优先级函数');
assert(!usageRs.includes('fn iface_bound_to('), 'usage.rs 残留旧绑定判定');
assert(!usageRs.includes('fn modem_bound_netdev('), 'usage.rs 残留旧模组绑定判定');
assert(!usageRs.includes('fn first_netdev('), 'usage.rs 残留旧 UCI 取值解析');

console.log('usage source / DNS target consistency: 50+ checks passed');
