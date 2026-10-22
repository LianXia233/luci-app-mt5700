# 随包音频内核模块

## 这批模块是干什么的

它们让「把 MT5700M-CN 换成带 USB Audio Class 的模组」变成纯软件操作：
插上新模组 → 检测到 Audio Class 接口 → 自动装载这 11 个模块 →
`/dev/snd` 出现 → 音频桥可以 arecord/aplay。**不需要重编固件。**

## 来源与许可

提取自厂商固件 `H5000M-6.12.112-25.12.5-中lan-password-outside-20261018.bin`
的 `/lib/modules/6.12.112/`。

这些都是上游 Linux 内核的模块（`snd-usb-audio` 等），许可为 **GPL-2.0**，
源码见 kernel.org 的对应版本。本仓库以 MIT 发布插件自身代码，这批二进制
模块仍按其原始许可（GPL-2.0）分发。

vermagic 统一为 `6.12.112 SMP mod_unload aarch64`，与本插件目标固件
（ZJJCKA OpenWrt 25.12.5 / kernel 6.12.112）一致。**换内核版本后这些模块
会 insmod 失败**，装载器会明确报错而不是静默跳过。

## 依赖序（不可乱）

```
soundcore → snd → snd-timer → snd-pcm → snd-hwdep → snd-seq-device
→ snd-rawmidi → snd-usbmidi-lib → mc → input-core → snd-usb-audio
```

取自各模块 `modinfo` 的 `depends` 字段（2026-10-22 提取）。这些文件不在
`/lib/modules` 的搜索路径里，因此不靠 `depmod` 解析，靠装载顺序保证。

`snd-usb-audio.kmod` 是唯一真正注册 USB 驱动的那个 —— dmesg 出现
`usbcore: registered new interface driver snd-usb-audio` 才算成功。

## 为什么后缀是 `.kmod` 而不是 `.ko`

OpenWrt 打包时 `scripts/gen-dependencies.sh` 会把包内每个 `*.ko` 的
`.modinfo` 里 `depends=` 展开成模块依赖，再拿包自身提供的模块名做差集；
差集非空就直接判打包失败。`snd-usb-audio` 与 `snd-usbmidi-lib` 依赖
`usbcore`，而 `usbcore` 在 OpenWrt 各平台都是**内建**的、不存在
`usbcore.ko` 可供，于是差集恒为 `usbcore.ko`，包在任何平台都编不过
（2026-10-22 CI 实测）。

改成 `.kmod` 后上述两处 `*.ko` glob 同时不再命中，问题消失；
`insmod` 认的是 ELF 内容而非文件名，运行期行为完全不变。

## 为什么不在当前这台机器上生效

MT5700M-CN 的 USB 有两个配置，六个接口全列如下，**没有一个是 Audio Class**：

| 接口 | 类/子类 | 驱动 |
|---|---|---|
| 1 | `02/0d` | cdc_ncm（网卡） |
| 2 | `0a/00` | CDC Data |
| 3–6 | `ff/06` | Application / PC UI / SerialC / GPS |

所以在这台机器上 `audio-ko.sh load` 会直接返回 3（无 UAC），一个模块都不装。
这是设计意图：**没有硬件就不占内存、不留假象**。

## 校验值

`6.12.112/SHA256SUMS` 是逐文件 sha256，可用 `sha256sum -c` 核对。
