#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
MANAGER="${ROOT}/root/usr/sbin/mt5700m-manager"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT INT TERM

FAKE_AT="${TMP}/mt5700m-at"
printf '%s\n' \
	'#!/bin/sh' \
	'[ "$1" = "temperature" ] || exit 64' \
	'echo temp_modem1=42.1' \
	'echo temp_modem2=43.6' \
	'echo temperature=43.6' \
	'echo temperature_sensor=modem2' > "${FAKE_AT}"
chmod 0755 "${FAKE_AT}"

MT5700M_MANAGER_STATE="${TMP}/state" \
MT5700M_AT_HELPER="${FAKE_AT}" \
	sh "${MANAGER}" refresh-temperature

CACHE="${TMP}/state/temperature"
grep -qx 'temperature=43.6' "${CACHE}"
grep -qx 'temperature_sensor=modem2' "${CACHE}"
updated="$(sed -n 's/^updated=//p' "${CACHE}")"
case "${updated}" in ''|*[!0-9]*) exit 1 ;; esac

cp "${CACHE}" "${TMP}/before"
printf '%s\n' '#!/bin/sh' 'echo temperature=invalid' > "${FAKE_AT}"
chmod 0755 "${FAKE_AT}"
if MT5700M_MANAGER_STATE="${TMP}/state" MT5700M_AT_HELPER="${FAKE_AT}" \
	sh "${MANAGER}" refresh-temperature; then
	exit 1
fi
cmp "${TMP}/before" "${CACHE}"

echo 'temperature cache tests passed'
