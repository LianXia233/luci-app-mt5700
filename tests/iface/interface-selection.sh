#!/bin/sh
# Exercise the at-webserver init.d interface selection on a disposable OpenWrt VM.
# Usage (on a disposable OpenWrt test machine, it rewrites network/firewall/at-webserver config):
#   sh tests/iface/interface-selection.sh /etc/init.d/at-webserver

INIT="$1"

# Precondition guard: fail loudly instead of producing silent false results
# (run() sources "$INIT" with stderr/stdout swallowed, so a missing uci or a
# bad init path would otherwise just make every case "pass" or "fail" blindly).
if [ -z "$INIT" ] || [ ! -f "$INIT" ]; then
	echo "usage: $0 /etc/init.d/at-webserver" >&2
	exit 2
fi
if ! command -v uci >/dev/null 2>&1; then
	echo "ERROR: uci not found, run this on a disposable OpenWrt test machine" >&2
	exit 2
fi

fail=0
check() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }
has() { uci -q get "network.$1" >/dev/null; }

reset() {
	for s in MT5700M MT5700Mv6 testwan testwan6 other custom1 custom1v6; do uci -q delete "network.$s"; done
	uci commit network
	for z in $(uci -q show firewall | sed -n 's/^\(firewall\.@zone\[[0-9]*\]\)=zone$/\1/p'); do
		for n in MT5700M MT5700Mv6 testwan testwan6 custom1; do uci -q del_list "$z.network=$n"; done
	done
	uci commit firewall
	for o in manage_interface iface_v4 iface_v6; do uci -q delete "at-webserver.config.$o"; done
	uci commit at-webserver
	rm -f /tmp/ifup.log
}
openfi_like() {
	uci set network.testwan=interface; uci set network.testwan.device=usb0; uci set network.testwan.proto=dhcp
	uci set network.testwan6=interface; uci set network.testwan6.device=@testwan; uci set network.testwan6.proto=dhcpv6
	uci set network.other=interface; uci set network.other.device=eth9; uci set network.other.proto=dhcp
	uci commit network
}
cfg() { uci set "at-webserver.config.$1=$2"; uci commit at-webserver; }

# NETDEV selects what detect_usb_netdev reports (empty = modem port not enumerated yet).
run() {
	(
		. "$INIT"
		detect_usb_netdev() { [ -n "$NETDEV" ] && echo "$NETDEV"; }
		ifup() { echo "$1" >> /tmp/ifup.log; }
		iface_has_address() { return 1; }
		IFUP_RETRY_TIMES=1; IFUP_RETRY_INTERVAL=0
		"$@"
	) >/dev/null 2>&1
}

touch /etc/config/at-webserver
uci -q get at-webserver.config >/dev/null || { uci set at-webserver.config=config; uci commit at-webserver; }
export NETDEV=usb0

# 1. management off, auto scan: only bring up what already sits on the modem port
reset; openfi_like; cfg manage_interface 0
fw_before=$(uci export firewall | md5sum)
run ensure_interfaces; run ensure_modem_interface; run on_uplink
check "1 off/auto: nothing created" "! has MT5700M && ! has MT5700Mv6"
check "1 off/auto: firewall untouched" "[ \"\$(uci export firewall | md5sum)\" = \"$fw_before\" ]"
check "1 off/auto: ifup testwan and testwan6 only" "[ \"\$(sort /tmp/ifup.log | tr '\n' ' ')\" = 'testwan testwan6 ' ]"

# 2. management on, auto scan, firmware already has wan on the modem port (OpenFi)
reset; openfi_like
run ensure_interfaces
check "2 on/auto: reuses testwan, no MT5700M" "! has MT5700M && ! has MT5700Mv6"
check "2 on/auto: testwan set to start at boot" "[ \"\$(uci -q get network.testwan.auto)\" = 1 ]"
check "2 on/auto: other interface untouched" "[ -z \"\$(uci -q get network.other.auto)\" ]"

# 3. management on, auto scan, nothing on the modem port yet: previous behaviour
reset
run ensure_interfaces
check "3 on/auto: MT5700M created on usb0" "[ \"\$(uci -q get network.MT5700M.device)\" = usb0 ]"
check "3 on/auto: MT5700Mv6 created as @MT5700M" "[ \"\$(uci -q get network.MT5700Mv6.device)\" = @MT5700M ]"
check "3 on/auto: wan zone lists MT5700M" "uci -q show firewall | grep -q \"network=.*MT5700M\""

# 4. management on, auto scan, modem port not enumerated: defer creation
reset
NETDEV= run ensure_interfaces
check "4 on/auto: no interface before the modem port exists" "! has MT5700M && ! has MT5700Mv6"
export NETDEV=usb0

# 5. manual names, IPv6 disabled
reset; cfg iface_v4 custom1; cfg iface_v6 none
run ensure_interfaces
check "5 manual: custom1 created on usb0" "[ \"\$(uci -q get network.custom1.device)\" = usb0 ]"
check "5 manual: no IPv6 interface" "! has custom1v6 && ! has MT5700Mv6"
check "5 manual: no MT5700M" "! has MT5700M"

# 6. an unsafe name falls back to auto scan
reset; openfi_like; cfg iface_v4 'bad;name'
run ensure_interfaces
check "6 invalid name: no section built from it" "! uci -q show network | grep -q 'bad'"
check "6 invalid name: auto scan reused testwan" "! has MT5700M"

# 7. management off, manual interface: bring up exactly that one
reset; openfi_like; cfg manage_interface 0; cfg iface_v4 other; cfg iface_v6 none
run on_uplink
check "7 off/manual: ifup other only" "[ \"\$(cat /tmp/ifup.log | tr '\n' ' ')\" = 'other ' ]"

reset
exit $fail
