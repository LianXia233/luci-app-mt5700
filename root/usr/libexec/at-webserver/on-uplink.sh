#!/bin/sh
# 由 Rust 后端在「自动拨号达成期望状态」时调用。
#
# 为什么用独立脚本而不是在后端里直接 ifup：
#   后端只应知道「拨号就绪」，不应知道承载接口叫 MT5700M 还是别的名字，
#   也不应去解析 UCI network 配置。把这段留在 init.d 侧可以复用同一套判定
#   （已取到地址就不重复 ifup、接口不存在时按 USB 网口创建），也便于单独测试
#   与手动排查（人工执行本脚本即可模拟一次「拨号刚完成」）。
#
# 尽力而为：失败静默。接口侧的兜底重试在 init.d 的 ensure_modem_interface，
# 以及 hotplug 的 iface/usb 钩子，本脚本只是让时序更准。

[ -x /etc/init.d/at-webserver ] || exit 0
/etc/init.d/at-webserver on_uplink >/dev/null 2>&1 || true
exit 0
