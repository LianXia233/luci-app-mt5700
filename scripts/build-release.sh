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
# CRLF prevention: .gitattributes mandates eol=lf for htdocs/5700 text files.
# Removing the pre-compile `sed -i 's/\r$//'` step — it was empirically proven to
# corrupt large single-line JS bundles (umi bundle) on CI runners, causing both
# build failures (node --check) and runtime SyntaxErrors (exposed `xmlns` from
# truncated JS strings in network.js / status.js).
# The post-compile `cp -a` of pristine repo htdocs into staging_dir is the safety
# net for any SDK copy/tar artifacts, and `node --check` validates the result.

make package/h5000m-custom/luci-app-mt5700m/compile -j"$(nproc)" V=s

# Re-copy the PRISTINE htdocs/5700 from the repo source into the freshly staged
# www tree, AFTER `make compile` and BEFORE the node --check guard below.
#
# This is the step that ACTUALLY fixes the truncation — empirically proven:
#   - v2.3.22: this step PRESENT  -> build SUCCEEDED
#   - v2.3.26: this step REMOVED  -> build FAILED (node --check caught truncated umi.js)
#   - v2.3.27: still absent (only a pre-compile sed was added) -> build FAILED
#
# The OpenWrt SDK's staging/copy step truncates the large JS bundle (the umi bundle
# has 34000+ char lines; the SDK copy/tar mangles CRLF/long-line files).  Crucially,
# the .apk is assembled FROM staging_dir, so overwriting staging_dir here DOES reach
# the package.  The repo source (repo_dir) is the clean, intact copy, so re-copying it
# guarantees the staged tree — and thus the shipped package — contains uncorrupted files.
# (Our earlier v2.3.26 analysis wrongly judged this "too late"; the evidence above
#  shows it is the effective fix.  Keep it.)
cp -a "${repo_dir}/luci-app-mt5700m/htdocs/5700/." staging_dir/target-*/root-*/www/5700/.
echo "INFO: re-copied pristine htdocs/5700 into staging_dir after compile"

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
