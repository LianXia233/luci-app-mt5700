include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for mt5700d (MT5700M 5G modem)
# 后端 Rust 二进制已随本包一起编译安装（见 src/Makefile），不再依赖独立后端包。
# 不在 LUCI_DEPENDS 里声明 rpcd/ucode/usbutils：luci-base 已依赖 rpcd+ucode；
# usbutils 仅 init.d 可选探测，SDK 内硬依赖会拖 libusb 编译失败。
#
# 关于 nc：前端到后端的 RPC 由 rpcd ucode 插件 mt5700.uc 经 `nc 127.0.0.1 <port>`
# 打通（ucode 的 fs 无 socket 能力）。nc 由 busybox 提供，是否编译进固件取决于
# 各固件的 busybox 配置，无法用一个包依赖强行保证——因此这里不声明 netcat
# （它与 busybox 的 /usr/bin/nc 会冲突），改由 mt5700.uc 运行时探测并给出可诊断的报错。
LUCI_DEPENDS:=
# 包内含架构相关二进制，不能是 all；置空让 package.mk 按板级架构打包
LUCI_PKGARCH:=

PKG_NAME:=luci-app-mt5700
PKG_VERSION:=2.1.3
PKG_RELEASE:=1

# Rust 后端版本号单一来源：把 PKG_VERSION 以环境变量导出，子 make
# （luci.mk Build/Compile → src/Makefile）会继承它，再由 src/Makefile
# 传给 cargo（见 src/Makefile）。发版只需改上面一行。
export MT5700_VERSION:=$(PKG_VERSION)

# 打包前强制 init.d / uci-defaults 可执行（防止部分 checkout 丢失 +x 导致
# post-install 报 Permission denied）
define Build/Prepare
	$(call Build/Prepare/Default)
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/init.d/mt5700d 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/uci-defaults/mt5700d 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/hotplug.d/iface/99-mt5700d 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/etc/hotplug.d/usb/99-mt5700d 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/mt5700d/on-uplink.sh 2>/dev/null || true
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/mt5700d/migrate-legacy.sh 2>/dev/null || true
endef

# 升级时保留迁移后的配置文件。preinst 会在新文件解包前把旧路径的用户配置
# 搬到这个路径；没有 conffiles 声明时，opkg/apk 升级会用包内默认文件覆盖它。
define Package/luci-app-mt5700/conffiles
/etc/config/mt5700d
endef

# 旧 UCI 配置必须在包文件解包前抢救。
#
# 原因：postinst 在解包之后才执行，那时新版 /etc/config/mt5700d 默认文件已经
# 落地，脚本会因目标存在而跳过迁移；也不能指望包管理器清理受保护路径下的
# 旧文件。preinst 是本包唯一能在旧文件仍完整、新文件尚未落地时介入的钩子。
#
# 这里只做「复制到临时位置」：此刻新包尚未解包，migrate-legacy.sh 还不存在，
# 调不到脚本；sed 与落盘统一放在脚本的 postinst 阶段，规则只保留一份。
# 临时目录放在 overlay 而不是 /tmp：解包后若断电，tmpfs 清空会让旧配置彻底丢失。
#
# 复制前必须先清掉上一次安装可能残留的备份目录：备份只在「本次安装的
# preinst → postinst」窗口内有效，带着陈旧备份进入下一次安装，脚本会拿
# 旧备份覆盖用户后来在新版本里改过的配置。
define Package/luci-app-mt5700/preinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -rf /etc/mt5700d-migrate
	if [ -f /etc/config/at-webserver ]; then
		if [ -f /etc/config/mt5700d ]; then
			# 异常升级态：两份并存时保留较新的目标，旧文件留档供人工恢复。
			cp -f /etc/config/mt5700d /etc/config/mt5700d.pre-migration 2>/dev/null || true
			mv -f /etc/config/at-webserver /etc/config/at-webserver.pre-migration 2>/dev/null || true
			logger -t mt5700d "UCI 新旧配置并存，已保留 mt5700d 并备份旧配置" 2>/dev/null || true
		else
			mkdir -p /etc/mt5700d-migrate
			cp -f /etc/config/at-webserver /etc/mt5700d-migrate/legacy-config
			logger -t mt5700d "已在解包前保存旧 UCI 配置" 2>/dev/null || true
		fi
	fi
}
exit 0
endef

# 安装/升级完成后强制注册开机自启并拉起服务。
#
# 背景：本包的 root/etc/init.d/mt5700d 执行位曾两次静默回退
# （100755 → 100644），安装阶段的 enable 会以 Permission denied 失败，
# /etc/rc.d/S99mt5700d 从此缺失，服务永远不开机自启——LuCI 上就表现为
# 「未注册 / 进程未运行 / procd 无实例」。uci-defaults 只在首次启动时执行一次，
# 已装好的设备不会再走，所以这里再兜一道：装包或升包时补权限 + enable + 启动。
#
# 严重注意（本包自定义 postinst 的代价）：luci.mk 的默认 postinst 是用
# `ifndef Package/$(PKG_NAME)/postinst` 保护的，一旦本文件在 include luci.mk 之前
# 定义了同名目标，默认实现会被**整段跳过**。而默认实现里有三件必须做的事：
#     rm -f /tmp/luci-indexcache.*
#     rm -rf /tmp/luci-modulecache/
#     /etc/init.d/rpcd reload
# 缺了 rpcd reload，rpcd 不会重新扫描 /usr/share/rpcd/ucode/ 与 acl.d/，新装的
# mt5700.uc 与权限文件不生效，页面上所有 RPC 调用报 Access denied / Method not
# found——表现为「装完就能用的插件，重启前一直报错」，这正是全新安装的必踩故障。
# 因此下面把这三条显式搬进来。
#
# IPKG_INSTROOT 非空表示在为镜像根目录（SDK/ImageBuilder）打包，
# 此时不能真的去 enable/启动，否则会污染宿主机。
define Package/luci-app-mt5700/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	# ---------------------------------------------------------------------
	# 旧版本遗留数据迁移（一次性）
	#
	# UCI 配置已在 preinst 阶段复制到 /etc/mt5700d-migrate/；脚本会用它恢复
	# /etc/config/mt5700d 并替换旧路径，再处理短信归档、用量、防火墙规则与
	# 旧进程清理。脚本头的注释写了完整删除步骤。
	# ---------------------------------------------------------------------
	[ -x /usr/libexec/mt5700d/migrate-legacy.sh ] && /usr/libexec/mt5700d/migrate-legacy.sh

	# ---------------------------------------------------------------------
	# 合并 apk/opkg 因「受保护路径」留下的 .apk-new
	#
	# OpenWrt 的 apk 把 /etc/init.d 视为受保护路径（与 /etc/config 同等对待）：
	# 升级时若判定目标文件被本地修改过，就把新版写成 <file>.apk-new 而**不覆盖**。
	# 后果是服务脚本永远停在上一个版本 —— 本插件的关键修复（接口自动创建、
	# 拨号对齐对账、hotplug 协同）全在 init.d 里，不合并等于没升级。
	#
	# 实测（Hiveton H5000M，1.12.3 → 1.12.5）：升级后 /etc/init.d/mt5700d
	# 仍是 11250 字节的旧版，新版 21753 字节躺在 /etc/init.d/mt5700d.apk-new。
	#
	# 这里只合并服务脚本与 uci-defaults；/etc/config 下的 .apk-new 一律不动——
	# 那是用户配置，应由用户决定是否采用新版默认值。
	# ---------------------------------------------------------------------
	for f in /etc/init.d/mt5700d /etc/uci-defaults/mt5700d; do
		for suf in .apk-new .opkg-new; do
			if [ -f "$$f$$suf" ]; then
				mv -f "$$f$$suf" "$$f" && logger -t mt5700d "已用新版覆盖 $$f（来自 $${suf}）"
			fi
		done
		if [ -f "$$f-opkg" ]; then
			mv -f "$$f-opkg" "$$f" && logger -t mt5700d "已用新版覆盖 $$f（来自 -opkg）"
		fi
		chmod 0755 "$$f" 2>/dev/null
	done

	chmod 0755 /etc/init.d/mt5700d 2>/dev/null
	/etc/init.d/mt5700d enable
	/etc/init.d/mt5700d restart 2>/dev/null || /etc/init.d/mt5700d start
	# 安装/升级后立即核对一次模组接口：不存在就创建（V4 必建并取址，V6 也建、
	# 按实际网络状况取址）。服务里的同类检查是在后台跑的，装完这一刻还没跑到。
	# 只建接口、不做 ifup，避免被 DHCP 等待拖住安装进程。
	/etc/init.d/mt5700d ensure_interfaces 2>/dev/null || true
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd reload 2>/dev/null
}
exit 0
endef

# 关闭前端 JS 压缩：luci.mk 在 Package/install 阶段默认用 jsmin 把 htdocs 下
# 所有 .js 压成单行（受 CONFIG_LUCI_JSMIN 与 LUCI_MINIFY_JS 双重控制）。
# 设为 0 后 JsMin 变为空操作宏，产物保留未压缩源码，便于线上排查与对比。
# 另由 scripts/sdk-build.sh 在 .config 中显式关闭 CONFIG_LUCI_JSMIN（双保险）。
LUCI_MINIFY_JS:=0

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
