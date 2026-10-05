'use strict';
/*
 * LuCI core 兼容垫片。
 *
 * 背景：
 *   luci.js 的 bootstrap 自身依赖 String.prototype.format，例如
 *
 *     // luci.js: raise()
 *     const msg = fmt ? String.prototype.format.call(fmt, ...args) : null;
 *     // luci.js: require()
 *     url = '%s/%s.js%s'.format(env.base_url, name.replace(/\./g,'/'), ...);
 *
 *   而 luci.js 的启动流程是
 *
 *     Promise.all([domReady, this.require('ui'), this.require('rpc'), this.require('form'), ...])
 *         .then(this.setupDOM.bind(this)).catch(this.error)
 *
 *   其中 this.require('ui') 在 DOMContentLoaded 之前就会执行，也就早于
 *   主题脚本注入 format 定义的时机。在部分 LuCI master 构建里，format 的
 *   定义被拆分/摇树优化掉后（本机 luci.js 全文只出现一次 prototype.format，
 *   且位于调用点内部），第一个 this.require() 就会抛
 *
 *     TypeError: "%s/%s.js%s".format is not a function
 *
 *   异常被 Promise.all 的 .catch(this.error) 吞掉 → setupDOM() 永不执行 →
 *   所有视图的 load()/render() 都不运行 → 页面只显示 HTML 骨架（含表单容器），
 *   表现为「页面能打开但功能全不可用」，例如 AT 调试终端没有任何交互。
 *
 * 处理：
 *   1) 本模块由 rpc.js（所有视图的共同依赖）最先 require，其顶层副作用在
 *      luci.js 完成启动前就补齐 format 定义；
 *   2) 与 luci 自带实现保持一致的语义：
 *        - %s 参数替换，%d 数字替换，%j JSON 序列化
 *        - %% 转义为字面 %
 *        - 参数不足时保留占位符，参数多余时追加到末尾
 *   3) 仅当 String.prototype.format 尚未定义时才写入，不覆盖上游实现。
 *
 * 返回 Class 子类以满足 LuCI 对模块返回值的约定。
 */

'require baseclass';

var AtCompat = (function () {
	var api = {};

	api.install = function () {
		if (typeof String.prototype.format === 'function') return false;

		String.prototype.format = function () {
			var args = arguments;
			var index = 0;
			var str = String(this);

			var out = str.replace(/%(?:%|s|d|j)/g, function (m) {
				if (m === '%%') return '%';
				if (index >= args.length) return m;
				var v = args[index++];
				if (v == null) return '';
				if (m === '%d') {
					var n = parseInt(v, 10);
					return isNaN(n) ? String(v) : String(n);
				}
				if (m === '%j') {
					try { return JSON.stringify(v); } catch (e) { return String(v); }
				}
				return String(v);
			});

			// 多余实参按 luci 惯例追加（便于调试时看到全部上下文）
			for (; index < args.length; index++) {
				out += ' ' + args[index];
			}
			return out;
		};
		return true;
	};

	api.available = function () {
		return typeof String.prototype.format === 'function';
	};

	// 便于自检：按 luci 语义格式化一段模板
	api.format = function (fmt) {
		var args = Array.prototype.slice.call(arguments, 1);
		return String.prototype.format.apply(fmt, args);
	};

	// 模块求值即安装，早于任何视图 load/render。
	api.installed = api.install();

	return api;
})();

var AtCompatClass = L.Class.extend(AtCompat);
if (typeof window !== 'undefined') {
	window.AtCompat = new AtCompatClass();
}
return AtCompatClass;
