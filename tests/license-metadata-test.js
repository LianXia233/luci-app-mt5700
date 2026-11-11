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
const agents = read('AGENTS.md');
const notices = read('THIRD-PARTY-NOTICES.md');
const workflow = read('.github/workflows/checks.yml');
const packageJson = JSON.parse(read('tests/mock-modem/package.json'));
const packageLock = JSON.parse(read('tests/mock-modem/package-lock.json'));

assert.match(cargo, /^license\s*=\s*"GPL-3\.0-only"$/m,
  'Rust package license must match the repository license');
assert.match(lock, /name = "at-webserver"\nversion = "1\.32\.8"/,
  'Cargo.lock must retain the workspace package metadata');
assert.match(deny, /^\[licenses\]$/m, 'cargo-deny license policy is required');
assert.match(deny, /confidence-threshold\s*=\s*0\.93/,
  'license text detection must use a conservative confidence threshold');
assert.match(deny, /unknown-registry\s*=\s*"deny"/,
  'unknown Cargo registries must be rejected');
assert.match(deny, /unknown-git\s*=\s*"deny"/,
  'unknown Git sources must be rejected');

const accepted = [
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
  'GPL-3.0-only',
];
for (const license of accepted) {
  assert.ok(deny.includes('"'+license+'"'), 'cargo-deny must explicitly allow '+license);
  assert.ok(about.includes('"'+license+'"'), 'cargo-about must explicitly accept '+license);
}

assert.match(about, /\[ring\.clarify\]/,
  'ring license split must be clarified against its upstream license file');
assert.match(template, /\{\{\{text\}\}\}/,
  'license text must be rendered without HTML escaping');
assert.match(agents, /第三方依赖许可证与来源规则/);
assert.match(workflow, /cargo deny check licenses/);
assert.match(workflow, /cargo deny check sources/);
assert.match(workflow, /cargo about generate about\.hbs/);
assert.match(notices, /cargo-deny/);
assert.match(notices, /cargo-about/);
assert.match(notices, /ws.*8\.21\.3.*MIT/s);
assert.match(notices, /mock-modem.*ISC/s);

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

console.log('许可证元数据检查通过：SPDX、Cargo 策略、自动报告、CI、NOTICE 与 npm 锁定依赖一致。');
