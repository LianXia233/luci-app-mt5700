# 第三方素材与知识产权声明

本文件是 [`README.md`](README.md) 「许可证与开源声明」一节的逐项展开，用于记录 `luci-app-mt5700` 仓库中**不属于项目原创代码**的内容及其权利归属与取证信息。

> 适用对象：仓库 `main` 分支当前状态。新增、替换或移除第三方依赖、素材时，须同步更新本文件及相应的自动化审计配置。

---

## 1. 项目代码与文档

| 项目 | 内容 |
|:--|:--|
| 覆盖范围 | `Makefile`、`src/`（Rust / Tokio 后端）、`root/`、`htdocs/`（`at-webserver/mascot.png` 与 `at-webserver/bg/character-*.webp` 除外）、`po/`、`scripts/`、`tests/`，以及 `docs/` 中的原创文字 |
| 许可证 | GNU General Public License v3.0 only |
| SPDX 标识 | `GPL-3.0-only`（依据：`LICENSE` 为 GPLv3 全文；源码头未声明「or any later version」，按 GPLv3 第 14 条锁定为 v3.0） |
| 版权 | `Copyright (C) 2026 LianXia233` |
| 完整条款 | [`LICENSE`](LICENSE) |

对外分发二进制包或修改版时，须提供完整对应源码、保留版权与许可证声明（第 0 条、第 4–6 条），且不得附加额外限制（第 10 条）。

---

## 2. 角色素材（不在 GPL-3.0-only 范围内）

仓库里的角色形象来自**两部不同作品**，权属各自独立。此前把四张 PC / 移动端背景图一并归入
《异环》薄荷属于**错误归属**，已于 2026-11-12 按画面特征与官方资料重新识别并更正。
两组素材都不适用项目自身的 `GPL-3.0-only`，也都**未取得权利人书面授权**。

### 2.1 权利归属

#### 2.1.1 背景图（四张 WebP）：《蔚蓝档案》阿罗娜 / 普拉娜

| 项目 | 内容 |
|:--|:--|
| 作品 | 《蔚蓝档案》（Blue Archive / ブルーアーカイブ） |
| 角色（浅色 `-light`） | 阿罗娜（Arona / アロナ，A.R.O.N.A；国服译名「阿洛娜」，繁中译名「彩奈」）——「什亭之匣」主操作系统 AI |
| 角色（深色 `-dark`） | 普拉娜（Plana / プラナ）——另一时间线的 A.R.O.N.A，与阿罗娜成对出现 |
| 识别依据 | 浅色：天蓝短发、白色大蝴蝶结头带、刘海遮单眼、鬓侧麻花辫、蓝白水手服、亮蓝瞳、粉色挑染；深色：白色长发带淡红渐变、红色圆环光环、白色兔耳状蝴蝶结、右鬓双螺旋麻花辫、黑色水手服白领巾、异色瞳。两组特征与官方角色设定一致 |
| 开发 / 著作权人 | NEXON Games Co., Ltd. |
| 发行 / 共同权利人 | Yostar, Inc.（日本及全球）；中国大陆版本由上海悠星网络科技有限公司（Shanghai Yostar Co., Ltd.）运营 |
| 官方权利标注 | `© NEXON Games Co., Ltd. & Yostar, Inc.`；国服官网标注 `Copyright © 2023 NEXON Games Co., Ltd. & Shanghai Yostar Co., Ltd. All Rights Reserved.` |
| 图稿性质 | **非官方立绘**：四张为同一组二次创作 / 同人插画（同一姿势、白底、PC 与移动端两套裁切、深浅两套配色），绘师署名、原始出处与授权凭证**未在仓库内留存**，无法核实 |
| 参考来源 | 国服官网 <https://bluearchive-cn.com/> 版权声明；官方角色介绍（普拉娜 NPC Introduction）；角色资料库对阿罗娜 / 普拉娜外观设定的记载 |
| 与本项目的关系 | 无隶属、合作、赞助或授权关系 |

#### 2.1.2 英雄区头像（mascot.png）：《异环》薄荷

| 项目 | 内容 |
|:--|:--|
| 角色 | 薄荷（Mint / ミント），异象管理局收容二组预备骨干 |
| 作品 | 《异环》（NTE, Neverness to Everness） |
| 识别依据 | 蓝绿发、黑色猫形发箍 / 猫耳、颈戴铃铛、深红瞳的像素风头像，与官方「蓝绿发猫耳少女、黑色发箍配猫形装饰、颈戴铃铛」设定一致 |
| 开发 / 著作权人 | 苏州幻塔网络科技有限公司（Hotta Studio，完美世界旗下工作室） |
| 全球发行 | 完美世界游戏 |
| 与本项目的关系 | 无隶属、合作、赞助或授权关系 |

### 2.2 使用清单与文件指纹

四张 WebP 均为**静态单帧**（非动图），`pc` 与 `mobile` 是同一插画的不同裁切，
`dark` / `light` 分别对应普拉娜 / 阿罗娜。以下 SHA-256 取自主分支 `v1.32.9` 的实际文件。

| 文件 | 尺寸 / 格式 | 角色 / 用途 | SHA-256（前 16 位） |
|:--|:--|:--|:--|
| `htdocs/luci-static/resources/at-webserver/bg/character-pc-dark.webp` | 1000×1000，WebP 单帧，98,340 B | 普拉娜 · 普通模式桌面深色背景 | `8c5bd7aa2f53bf52` |
| `htdocs/luci-static/resources/at-webserver/bg/character-pc-light.webp` | 1000×1000，WebP 单帧，106,368 B | 阿罗娜 · 普通模式桌面浅色背景 | `91f5831319570014` |
| `htdocs/luci-static/resources/at-webserver/bg/character-mobile-dark.webp` | 840×1120，WebP 单帧，87,770 B | 普拉娜 · 普通模式移动端深色背景 | `fc4aa644dcf5ab78` |
| `htdocs/luci-static/resources/at-webserver/bg/character-mobile-light.webp` | 840×1120，WebP 单帧，93,070 B | 阿罗娜 · 普通模式移动端浅色背景 | `4d820a655c2cfed2` |
| `htdocs/luci-static/resources/at-webserver/mascot.png` | 320×320，PNG RGBA，162,214 B | 薄荷 · 英雄卡片圆形头像 | `b3b74e811f954d71` |
| `docs/images/mascot.png` | 320×320，PNG RGBA | 上者的文档站副本（同一文件） | `b3b74e811f954d71` |
| `docs/images/*.png` | 界面截图 | README 与 Release 说明中的界面展示（含上述角色形象） | 随截图更新 |

完整 SHA-256（便于权利人核验与去重）：

```
character-pc-dark.webp      8c5bd7aa2f53bf52e020693bba1b5114e6a6b22d173918aa19866bccf7a54360
character-pc-light.webp     91f5831319570014c009919e1e20ddbc0d1014b61cf39ac0ed1d1936fef5f7fa
character-mobile-dark.webp  fc4aa644dcf5ab7821598061298a4a23cb429d94e41ffe5570163b478dd95cae
character-mobile-light.webp 4d820a655c2cfed247e9a5d425ca2e805b255aee4c4207143c4b8c157b701718
mascot.png                  b3b74e811f954d7126c161944348af6653a05136c3bb3f701802417d0fcba935
```

### 2.3 授权状态与来源

- **授权状态**：两组素材均**未取得权利人的书面许可**；本项目不主张对角色形象或图稿的任何权利，亦未将其用于商业目的。
  角色形象著作权分别归 2.1.1 / 2.1.2 所列权利人；四张背景图作为二次创作插画，还可能另有绘师的著作权，该层权利同样未经核实与授权。
- **来源记录**：素材的获取途径、绘师署名、原始发布地址、获取时间与授权凭证**均未在仓库内留存**。
  2.1.1 的「参考来源」仅用于**角色身份识别**，不构成对图稿来源或授权的证明；角色身份系按视觉特征与公开资料比对得出，未经权利人确认。
  建议维护者另行保存素材来源、作者与获取时间，以备权利人问询时举证；如后续取得授权，应在本节补充许可范围、地域与期限。
- **错误归属更正**：本文件 2026-11-12 之前把四张背景图与 `mascot.png` 一并归为《异环》/ 苏州幻塔网络科技有限公司 / 完美世界游戏，
  与画面特征不符。本次更正**不改变「未获授权」这一结论**，也不构成任何权利人的确认或背书。
- **分发性质**：素材与 GPL 代码同包出现，并不自动证明其构成 GPLv3 第 5 条所称的独立聚合（aggregate）；是否适用该规则取决于作品之间的独立性、组合方式及具体事实。无论如何，GPL-3.0-only 均不会自动授权任何一组角色素材。

### 2.4 未解决的授权风险

- 本仓库未取得上述两组角色素材的书面授权，也未留存可核验的官方开放许可；本项目对素材的说明、署名或非商业使用声明均不构成权利人的授权。
- 不应将当前状态理解为已获准进行非商业使用、再分发、二次创作或模型训练。素材是否可继续公开展示及随固件分发，仍存在未解决的权利风险。
- 深色 / 浅色背景分别使用了两个不同角色，且图稿为二次创作，权利链比单一官方素材更复杂：需分别向作品权利人与（如可查明的）绘师核实。
- 在取得可核验授权前，发布者应优先从对外发布产物中移除该素材，或替换为原创素材 / 明确允许相应用途的素材；若保留在仓库中，应明确标记为待处理资产，并在权利人提出异议时及时下架。

---

## 3. 名称与商标

| 名称 | 权利人 | 本仓库中的使用方式 |
|:--|:--|:--|
| OpenWrt、ImmortalWrt、LuCI | 各自项目及其基金会 / 社区 | README 徽章与兼容性说明 |
| MT5700M | 模组厂商及其权利人 | 描述适配的硬件型号与 AT 指令集 |
| `AT^HSCQ`、`^MONSC`、`+CGREG` 等指令 | 模组厂商 AT 指令手册 | 技术说明与实现依据 |
| 《蔚蓝档案》/ Blue Archive、阿罗娜 / 彩奈、普拉娜 | NEXON Games Co., Ltd. 与 Yostar, Inc.（国服含上海悠星网络科技有限公司） | 角色素材权属识别（见第 2 节） |
| 《异环》/ Neverness to Everness、薄荷（Mint） | 苏州幻塔网络科技有限公司（Hotta Studio）/ 完美世界游戏 | 角色素材权属识别（见第 2 节） |

上述名称均用于**指示性描述**（nominative use），不表示官方背书、赞助或合作关系。

---

## 4. 免责

本项目按「现状」提供，适用 GPLv3 第 15–16 条的担保免责与责任限制；本文件不构成法律意见，具体授权事宜以权利人书面许可为准。

---

## 5. 权利主张渠道

如权利人认为本项目的使用超出合理范围，请通过 [GitHub Issues](https://github.com/LianXia233/luci-app-mt5700/issues) 提出，并附：

1. 权利证明（著作权登记、授权链或官方声明）；
2. 具体文件路径与使用位置；
3. 期望处理方式（署名 / 替换 / 移除）。

维护者核实后将及时响应，并按第 3 项所述方式处置。

---

## 6. Rust 与 Node.js 第三方软件依赖

项目自身代码采用 `GPL-3.0-only`。该声明**不代表**将依赖项重新授权为 GPL，也不替代各依赖项目原有的许可证条款。

### 6.1 Rust 依赖

- Rust 后端的直接依赖及精确版本由 [`src/rust/Cargo.toml`](src/rust/Cargo.toml) 和 [`src/rust/Cargo.lock`](src/rust/Cargo.lock) 锁定。
- 依赖条目数量随 `Cargo.toml`、目标平台、功能特性和传递依赖变化；请以当前 `Cargo.lock` 与 CI 生成的许可证报告为准，不在此处维护容易过期的固定数量。锁定图可能包含仅用于特定操作系统、架构或构建条件的依赖，**不等于最终固件实际打包的依赖数量**。
- [`deny.toml`](deny.toml) 是依赖策略的检查入口。CI 执行 cargo-deny 的 `licenses`、`sources` 与 `bans` 检查：仅允许明确列出的许可证表达式和 crates.io registry，未知许可证、未知 registry 或未知 Git 来源会使检查失败；通配符依赖会被拒绝，重复版本会产生审查警告。新增许可证或来源必须先核实再加入策略。
- `webpki-roots` `0.26.11` 与 `1.0.9` 携带 Mozilla CA 根证书数据，锁定元数据声明为 `CDLA-Permissive-2.0`；它们由 `tokio-tungstenite` 与 `ureq` 的 TLS 根证书功能引入。该协议第 2.1 条要求分享数据时一并提供协议文本，因此完整协议已随本包安装到 `/usr/share/licenses/luci-app-mt5700/CDLA-Permissive-2.0.txt`。
- [`src/rust/about.toml`](src/rust/about.toml) 与 [`src/rust/about.hbs`](src/rust/about.hbs) 用于生成逐项依赖许可证报告。检查工作流会将报告写入 GitHub Actions **Summary**；正式构建工作流会在打包前生成 `RUST-DEPENDENCIES.md`，并随 APK/IPK 安装到 `/usr/share/licenses/luci-app-mt5700/RUST-DEPENDENCIES.md`，其中包含 crate、版本、许可证及许可证文本。
- `CDLA-Permissive-2.0` 属于数据许可，不应误记为项目源代码许可证；其完整文本保存在 `root/usr/share/licenses/luci-app-mt5700/CDLA-Permissive-2.0.txt`，并随 OpenWrt 软件包安装。
- 自动化结果是审计辅助依据，不代表已对每个上游项目完成法律审查。分发前仍须核对对应锁定版本的上游许可证、版权声明、NOTICE 文件及再分发义务；不得把项目自身 GPL 声明套用到第三方依赖。

### 6.2 Node.js 测试工具

- `tests/mock-modem/package.json` 是独立测试工具的包清单，其自身声明许可证为 `ISC`。
- 锁文件将 `ws` 固定为 `8.21.3`，其锁定元数据声明许可证为 `MIT`；该许可证属于 `ws` 本身，不能由测试工具的 `ISC` 声明代替。上游版权声明与许可证全文见 [`ws@8.21.3/LICENSE`](https://github.com/websockets/ws/blob/8.21.3/LICENSE)。
- npm tarball 使用官方 `registry.npmjs.org` 地址，并保留锁文件中的完整性校验值。
- `tests/mock-modem/` 不属于 Rust 后端的 Cargo 依赖图，也不应据此改变主项目的 `GPL-3.0-only` 声明。

### 6.3 许可证审计边界

cargo-deny 会依据依赖元数据和配置检查许可证表达式与来源；cargo-about 会生成依赖及许可证文本清单。自动化工具无法穷尽检查每个 crate 的全部源码，也不能替代人工核对上游许可证、NOTICE、素材权利与实际分发方式。不得把「CI 通过」表述为不存在任何版权或授权风险。

---

## 7. 变更记录

| 日期 | 变更 |
|:--|:--|
| 2026-10-20 | 初版：建立代码 / 角色素材 / 商标三段式清单，补充素材指纹与来源说明 |
| 2026-11-12 | 增加 Rust / Node.js 依赖许可证审计入口、自动报告及分发审查边界 |
| 2026-11-12 | 重新识别并更正四张 PC / 移动端角色背景图的归属：《蔚蓝档案》阿罗娜（浅色）/ 普拉娜（深色），权利人 NEXON Games Co., Ltd. 与 Yostar, Inc.；与《异环》薄荷头像拆为两组，补齐逐文件尺寸、SHA-256 与识别依据，并记录更正前的错误归属 |
