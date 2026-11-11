// Copyright (C) 2026 LianXia233
// SPDX-License-Identifier: GPL-3.0-only

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const cargo = read('src/rust/Cargo.toml');
const lock = read('src/rust/Cargo.lock');
const deny = read('deny.toml');
const about = read('src/rust/about.toml');
const template = read('src/rust/about.hbs');
const license = read('LICENSE');
const cdlaLicense = read('root/usr/share/licenses/luci-app-mt5700/CDLA-Permissive-2.0.txt');
const readme = read('README.md');
const agents = read('AGENTS.md');
const notices = read('THIRD-PARTY-NOTICES.md');
const workflow = read('.github/workflows/checks.yml');
const buildWorkflow = read('.github/workflows/build-openwrt.yml');
const packageJson = JSON.parse(read('tests/mock-modem/package.json'));
const packageLock = JSON.parse(read('tests/mock-modem/package-lock.json'));

function readStringArray(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, label + ' must be declared');
  return [...match[1].matchAll(/"([^"]+)"/g)]
    .map((item) => item[1])
    .sort();
}

assert.match(cargo, /^license\s*=\s*"GPL-3\.0-only"$/m,
  'Rust package license must match the repository license');
assert.match(license, /GNU GENERAL PUBLIC LICENSE\s+Version 3/,
  'root LICENSE must contain the complete GPLv3 text');
assert.match(lock, /^version = 4$/m,
  'Cargo.lock must use the expected lockfile format');

const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"$/m);
const lockedPackage = lock.match(/\[\[package\]\]\nname = "at-webserver"\nversion = "([^"]+)"/);
assert.ok(cargoVersion, 'Cargo.toml package version must exist');
assert.ok(lockedPackage, 'Cargo.lock must contain the at-webserver package');
assert.equal(lockedPackage[1], cargoVersion[1],
  'Cargo.lock package version must match Cargo.toml without hard-coded release versions');

assert.match(deny, /^\[licenses\]$/m, 'cargo-deny license policy is required');
assert.match(deny, /confidence-threshold\s*=\s*0\.93/,
  'license text detection must use a conservative confidence threshold');
assert.match(deny, /unknown-registry\s*=\s*"deny"/,
  'unknown Cargo registries must be rejected');
assert.match(deny, /unknown-git\s*=\s*"deny"/,
  'unknown Git sources must be rejected');
assert.match(deny, /wildcards\s*=\s*"deny"/,
  'wildcard dependency versions must be rejected');
assert.match(deny, /multiple-versions\s*=\s*"warn"/,
  'duplicate dependency versions must remain visible in the audit');

const expectedLicenses = [
  'Apache-2.0',
  'Apache-2.0 WITH LLVM-exception',
  'MIT',
  'ISC',
  'OpenSSL',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Zlib',
  'Unicode-3.0',
  'BSL-1.0',
  'CC0-1.0',
  'CDLA-Permissive-2.0',
  'GPL-3.0-only',
].sort();
const denyAllowed = readStringArray(deny, /^allow\s*=\s*\[([\s\S]*?)\]/m,
  'cargo-deny license allowlist');
const aboutAccepted = readStringArray(about, /^accepted\s*=\s*\[([\s\S]*?)\]/m,
  'cargo-about accepted license list');
assert.deepEqual(denyAllowed, expectedLicenses,
  'cargo-deny allowlist must stay explicit and minimal');
assert.deepEqual(aboutAccepted, expectedLicenses,
  'cargo-about and cargo-deny must use the same approved license set');

assert.match(about, /\[ring\.clarify\]/,
  'ring license split must be clarified against its upstream license file');
assert.match(about, /license\s*=\s*"ISC AND MIT AND OpenSSL"/,
  'ring clarification must retain its complete license expression');
assert.match(about, /checksum\s*=\s*["'][a-f0-9]{64}["']/,
  'ring clarification must pin the SHA-256 of the upstream license file');
assert.match(cdlaLicense, /Community Data License Agreement - Permissive - Version 2\.0/,
  'the complete CDLA-Permissive-2.0 text must ship with the package');
assert.match(cdlaLicense, /2\.1\. A Data Recipient may share Data[\s\S]*makes available the text of this agreement/,
  'the packaged CDLA license must retain its data-sharing condition');
assert.match(lock, /name = "webpki-roots"\nversion = "0\.26\.11"/,
  'the legacy webpki-roots data package must remain auditable');
assert.match(lock, /name = "webpki-roots"\nversion = "1\.0\.9"/,
  'the current webpki-roots data package must remain auditable');
assert.match(template, /\{\{\{text\}\}\}/,
  'license text must be rendered without HTML escaping');

assert.match(agents, /第三方依赖许可证与来源规则/);
assert.match(agents, /cargo deny check licenses/);
assert.match(agents, /cargo deny check sources/);
assert.match(agents, /cargo deny check bans/);
assert.match(agents, /CDLA-Permissive-2\.0/);
assert.match(agents, /root\/usr\/share\/licenses\/luci-app-mt5700/);
assert.match(workflow, /cargo deny check licenses/);
assert.match(workflow, /cargo deny check sources/);
assert.match(workflow, /cargo deny check bans/);
assert.match(workflow, /cargo about generate about\.hbs/);
assert.match(workflow, /GITHUB_STEP_SUMMARY/);
assert.match(workflow, /--version 0\.20\.2 cargo-deny/);
assert.match(workflow, /--version 0\.9\.3 --features cli cargo-about/);
assert.match(buildWorkflow, /license-report:/);
assert.match(buildWorkflow, /needs: license-report/);
assert.ok(buildWorkflow.includes('cargo deny check licenses'));
assert.ok(buildWorkflow.includes('cargo deny check sources'));
assert.ok(buildWorkflow.includes('cargo deny check bans'));
assert.ok(buildWorkflow.includes('cargo about generate about.hbs'));
assert.ok(buildWorkflow.includes('third-party-license-report'));
assert.ok(buildWorkflow.includes('RUST-DEPENDENCIES.md'));
assert.ok(buildWorkflow.includes('root/usr/share/licenses/luci-app-mt5700'));

assert.doesNotMatch(readme, /仅以聚合形式用于非商业个人开源项目/,
  'README must not imply that non-commercial use or aggregation grants permission');
assert.match(readme, /尚未取得权利人的书面许可/);
assert.ok(readme.includes('RUST-DEPENDENCIES.md'));
assert.ok(notices.includes('character-pc-dark.webp'));
assert.ok(notices.includes('character-pc-light.webp'));
assert.ok(notices.includes('character-mobile-dark.webp'));
assert.ok(notices.includes('character-mobile-light.webp'));
assert.match(readme, /^## 📄 许可证与开源声明$/m,
  'THIRD-PARTY-NOTICES must point to the current README section title');
assert.match(notices, /cargo-deny/);
assert.match(notices, /cargo-about/);
assert.match(notices, /webpki-roots.*0\.26\.11.*1\.0\.9.*CDLA-Permissive-2\.0/s);
assert.match(notices, /CDLA-Permissive-2\.0\.txt/);
assert.match(notices, /ws.*8\.21\.3.*MIT/s);
assert.match(notices, /mock-modem.*ISC/s);
assert.match(notices, /不构成.*授权/);
assert.doesNotMatch(notices, /131 个 package 条目/,
  'dependency counts must not be hard-coded because Cargo.lock changes over time');

assert.equal(packageJson.license, 'ISC',
  'mock-modem package license must remain independently declared');
assert.equal(packageLock.lockfileVersion, 3,
  'mock-modem lockfile must use a supported lockfile format');
assert.equal(packageLock.packages[''].license, 'ISC',
  'mock-modem root lock entry must retain ISC');
assert.equal(packageLock.packages['node_modules/ws'].version, '8.21.3',
  'ws must be pinned by the npm lockfile');
assert.equal(packageLock.packages['node_modules/ws'].license, 'MIT',
  'ws license must be recorded from the locked package metadata');
assert.match(packageLock.packages['node_modules/ws'].resolved,
  /^https:\/\/registry\.npmjs\.org\//,
  'npm lockfile must use the canonical public npm registry');
assert.match(packageLock.packages['node_modules/ws'].integrity,
  /^sha512-[A-Za-z0-9+/]+=*$/,
  'npm lockfile must retain the package integrity hash');

console.log('许可证元数据检查通过：SPDX、Cargo 锁定版本、许可证策略、CI、NOTICE 与 npm 锁定依赖一致。');
