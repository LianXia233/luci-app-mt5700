#!/usr/bin/env node
/*
 * 看板娘渲染回归测试。
 *
 * 历史故障：api.page() 创建页面节点时还没挂到 document，syncMascots()
 * 却用 document.querySelectorAll('.mt5700-hero-art') 找 hero，结果什么也
 * 找不到，.mt5700-hero-art 永久是空容器，英雄栏头像消失。
 *
 * 这里做静态约束：syncMascots 必须接受 root 作用域，api.page 必须把 node
 * 传进去；同时确认 mascot 图片与 hero-art 容器的实现仍存在。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'htdocs/luci-static/resources/mt5700d/mt5700.js');
const js = fs.readFileSync(file, 'utf8');

assert.match(js, /function syncMascots\(root\)/,
	'syncMascots 必须接受 root 作用域参数');
assert.match(js, /var scope = root \|\| document;/,
	'syncMascots 必须以 root 为作用域、缺省回退 document');
assert.match(js, /scope\.querySelectorAll\('\.mt5700-hero-art'\)/,
	'syncMascots 必须在 scope 内查找 hero-art');
assert.doesNotMatch(js, /function syncMascots\(\)[\s\S]{0,200}document\.querySelectorAll\('\.mt5700-hero-art'\)/,
	'syncMascots 不得再用 document 全局查找 hero-art');

const pageIdx = js.indexOf('api.page = function');
assert.ok(pageIdx >= 0, 'api.page 必须存在');
const pageBody = js.slice(pageIdx, pageIdx + 2000);
assert.match(pageBody, /syncHero\(node\);\s*\n\s*syncMascots\(node\);/,
	'api.page 必须在 syncHero(node) 后调用 syncMascots(node)');

assert.match(js, /hero\.appendChild\(E\('div', \{ 'class': 'mt5700-hero-art' \}\)\);/,
	'buildHero 必须创建 .mt5700-hero-art 容器');
assert.match(js, /'src': '\/luci-static\/resources\/mt5700d\/mascot\.png\?v=' \+ MT5700_CSS_VERSION/,
	'看板娘必须继续使用 mascot.png，并带 CSS 版本戳');

console.log('看板娘渲染回归检查通过：syncMascots(root) / api.page(node) / hero-art / mascot.png 均就位。');
