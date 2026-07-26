# 项目长期记忆：luci-app-mt5700m

## Git 推送方式（重要，沙箱限制）
- 仓库：`LianXia233/luci-app-mt5700m`（origin 配的是 `ssh://git@ssh.github.com:443/...`）。
- **443 端口 SSH 在沙箱内会被 GitHub 直接断连**（"Connection closed by 20.205.243.166 port 443"）。
- **可用方式**：`GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_ed25519_openwrtci -o StrictHostKeyChecking=no" git push ssh://git@github.com/LianXia233/luci-app-mt5700m.git main --tags`（标准 22 端口）。
- CI（release.yml）在 push tag `v*` 时自动构建并发布 GitHub Release（中文说明）。

## 上游对比经验
- FAN789 上游 `status.js` 与本项目几乎一致；差异仅在本项目的多载波增强。**WebFetch 会对上游文件做不可靠的"重建"，务必用 `curl` 抓真实内容再 diff**（注意 CRLF/LF，先 `sed 's/\r$//'` 再 diff）。
