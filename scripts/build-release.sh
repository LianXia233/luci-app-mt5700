#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="${RUNNER_TEMP:-/tmp}/mt5700m-sdk"
output_dir="${repo_dir}/dist-release"
base_url="https://downloads.openwrt.org/snapshots/targets/mediatek/filogic"
qmodem_commit="6f84b7935921cce6a215171af5e93cad62f8a5a5"

mkdir -p "${work_dir}" "${output_dir}"
find "${output_dir}" -mindepth 1 -maxdepth 1 -delete
cd "${work_dir}"
curl -fsSLO "${base_url}/sha256sums"
archive="$(awk '/openwrt-sdk-.*Linux-x86_64\.tar\.zst$/ { print $2; exit }' sha256sums | sed 's/^\*//')"
test -n "${archive}"
curl -fL --retry 5 "${base_url}/${archive}" -o "${archive}"
grep "[ *]${archive}$" sha256sums | sha256sum -c -
tar --zstd -xf "${archive}"
sdk_dir="$(find "${work_dir}" -maxdepth 1 -type d -name 'openwrt-sdk-*' | head -n 1)"
test -n "${sdk_dir}"

cd "${sdk_dir}"
printf '\nsrc-git qmodem https://github.com/FUjr/QModem.git^%s\n' "${qmodem_commit}" >> feeds.conf.default
./scripts/feeds update -a
./scripts/feeds install luci-base
./scripts/feeds install -p qmodem ubus-at-daemon sms-tool_q

perl -0pi -e 's/(config ALL\n\s+bool "Select all userspace packages by default"\n\s+default )y/${1}n/' Config.in
perl -0pi -e 's/(config TARGET_MULTI_PROFILE\n\s+bool\n\s+default )y/${1}n/; s/(config TARGET_ALL_PROFILES\n\s+bool\n\s+default )y/${1}n/; s/(config TARGET_DEVICE_mediatek_filogic_DEVICE_[^\n]+\n\s+bool\n\s+default )y/${1}n/g' Config-build.in
sed -i 's/^[[:space:]]*default m$/\tdefault n/' Config-build.in

mkdir -p package/h5000m-custom
cp -a "${repo_dir}/luci-app-mt5700m" package/h5000m-custom/
cat > .config <<'EOF'
CONFIG_TARGET_mediatek=y
CONFIG_TARGET_mediatek_filogic=y
# CONFIG_ALL is not set
# CONFIG_ALL_KMODS is not set
# CONFIG_ALL_NONSHARED is not set
CONFIG_PACKAGE_luci-app-mt5700m=m
CONFIG_LUCI_LANG_zh_Hans=y
CONFIG_PACKAGE_ubus-at-daemon=m
CONFIG_PACKAGE_sms-tool_q=m
# CONFIG_PACKAGE_luci-app-qmodem is not set
# CONFIG_PACKAGE_luci-app-qmodem-next is not set
# CONFIG_PACKAGE_qmodem is not set
# CONFIG_PACKAGE_modem_scan is not set
# CONFIG_PACKAGE_tom_modem is not set
EOF
make defconfig
make package/feeds/qmodem/ubus_at_daemon/compile package/feeds/qmodem/sms-tool_q/compile -j"$(nproc)" V=s
# Force a clean rebuild so the SDK re-copies the updated htdocs (network.js/status.js)
# instead of reusing a cached build_dir / staging copy from the previous version.
make package/h5000m-custom/luci-app-mt5700m/clean >/dev/null 2>&1 || true
rm -rf build_dir/target-*/luci-app-mt5700m \
       staging_dir/target-*/root-*/www/luci-static/resources/view/mt5700m \
       staging_dir/target-*/root-*/www/5700 \
       bin/packages/*/custom/luci-app-mt5700m*.apk 2>/dev/null || true
# Force LF line endings on ALL files under htdocs/5700 BEFORE the SDK touches them.
# .gitattributes eol=lf is the root-cause fix, but CI runners may check out with
# CRLF anyway (e.g. git config core.autocrlf=true on the runner).  This explicit
# conversion is the belt-and-suspenders guarantee that no CRLF large file ever
# reaches the OpenWrt staging/copy/tar pipeline — which is what truncates them.
if [ -d "package/h5000m-custom/luci-app-mt5700m/htdocs/5700" ]; then
  find "package/h5000m-custom/luci-app-mt5700m/htdocs/5700" -type f \
    -exec sed -i 's/\r$//' {} +
  echo "INFO: forced LF on htdocs/5700 ($(find 'package/h5000m-custom/luci-app-mt5700m/htdocs/5700' -type f | wc -l) files)"
fi

make package/h5000m-custom/luci-app-mt5700m/compile -j"$(nproc)" V=s

# NOTE: We deliberately do NOT re-copy htdocs/5700 into staging_dir AFTER `make compile`.
# In OpenWrt, `make package/X/compile` includes the install+packaging step, so by the
# time it returns the .apk is already assembled from staging_dir — a post-compile
# overwrite would be too late and silently ineffective.
# The clean-package guarantee comes from TWO correct mechanisms instead:
#   1. Root cause fixed at source: .gitattributes forces eol=lf on htdocs/**, so the
#      SDK's staging/copy never mangles CRLF large JS bundles in the first place.
#   2. The node --check guard below validates EVERY .js under /www/5700/ and aborts
#      the build if any file is truncated/corrupted — so a bad package can never ship.
# (An earlier post-compile re-copy block was removed because it looked protective but
#  did nothing; see issue analysis for v2.3.26.)

# Sanity check: the freshly staged www tree must contain the WebUI integration.
# If this fails, the SDK reused a cached htdocs copy and the package would be broken.
# We check for the homepage entry-button class (a JS string literal that survives
# any minification, unlike a // comment) and for the bundled WebUI SPA entry.
if ! grep -rq "mt5700m-webui-cta" staging_dir/target-*/root-*/www/luci-static/resources/view/mt5700m/ 2>/dev/null; then
  echo "ERROR: built www tree is missing the WebUI entry button (SDK caching?)" >&2
  exit 1
fi
if ! ls staging_dir/target-*/root-*/www/5700/index.html >/dev/null 2>&1; then
  echo "ERROR: built www tree is missing the WebUI SPA at /www/5700/index.html" >&2
  exit 1
fi
# Guard rail: catch truncated/garbled JS bundles (e.g. broken regex) before packaging.
# IMPORTANT: validate EVERY .js under /www/5700/, not just the main umi bundle.
# A truncated per-route async chunk (e.g. p__CPE__Network__Info__index.*.async.js)
# parses with a SyntaxError and white-screens ONLY that route while the rest of the
# app loads fine — exactly the symptom reported for /network/info. The earlier guard
# only checked umi.ec9b4b52.js and let broken route chunks through.
while IFS= read -r js; do
  [ -f "$js" ] || continue
  if ! node --check "$js" 2>/dev/null; then
    echo "ERROR: $js has syntax errors (likely truncated by SDK build)" >&2
    exit 1
  fi
done < <(find staging_dir/target-*/root-*/www/5700 -name '*.js' -type f 2>/dev/null)

find bin -type f \( -name 'luci-app-mt5700m-*.apk' -o -name 'luci-app-mt5700m_*.ipk' -o -name 'luci-i18n-mt5700m-zh-cn-*.apk' -o -name 'luci-i18n-mt5700m-zh-cn_*.ipk' -o -name 'ubus-at-daemon-*.apk' -o -name 'ubus-at-daemon_*.ipk' -o -name 'sms-tool_q-*.apk' -o -name 'sms-tool_q_*.ipk' \) -exec cp -f {} "${output_dir}/" \;
test "$(find "${output_dir}" -type f \( -name '*.apk' -o -name '*.ipk' \) | wc -l)" -ge 4
cp -f public-key.pem "${output_dir}/openwrt-sdk-build.pem" 2>/dev/null || true
(cd "${output_dir}" && find . -maxdepth 1 -type f \( -name '*.apk' -o -name '*.ipk' -o -name 'openwrt-sdk-build.pem' \) -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
