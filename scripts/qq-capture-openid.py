#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""QQ 机器人 openid 绑定辅助脚本（一次性运行，获取可粘贴的 UCI 配置）。

为什么需要本脚本：QQ 开放平台出于隐私设计，开放接口不提供「QQ 号 -> openid」
的转换，openid 只能从机器人 WebSocket 事件中获得（事件里同样只有 openid）。
本脚本监听网关事件，把收到的第一条单聊/群消息事件换算成 UCI 配置输出。

用法（在本机任意装有 Python 3 的环境）：
    pip install websocket-client
    python3 scripts/qq-capture-openid.py --app-id 123456 --app-secret XXXX
    # 或经环境变量：QQ_BOT_APP_ID / QQ_BOT_APP_SECRET

然后在 QQ 里给机器人发一条消息（单聊任意内容，或群里 @机器人），
脚本会打印 group/c2c 两种 openid 与对应的 UCI 配置命令。

安全约定：凭据仅经命令行参数或环境变量传入，脚本不会写入任何文件。
"""
import argparse
import json
import sys
import time
import urllib.request

try:
    import websocket
except ImportError:
    sys.exit("缺少依赖：请先执行 pip install websocket-client")

API = "https://api.bot.qq.com"
DEFAULT_TIMEOUT = 300


def get_app_access_token(app_id, secret):
    req = urllib.request.Request(
        API + "/app/getAppAccessToken",
        data=json.dumps({"appId": app_id, "clientSecret": secret}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
    if "access_token" not in data:
        raise RuntimeError("鉴权失败（检查 AppID/AppSecret）: %s" % data)
    return data["access_token"]


def main():
    ap = argparse.ArgumentParser(description="获取 QQ 机器人 openid 并生成 UCI 配置")
    ap.add_argument("--app-id", default=os_env("QQ_BOT_APP_ID"), help="AppID（或环境变量 QQ_BOT_APP_ID）")
    ap.add_argument("--app-secret", default=os_env("QQ_BOT_APP_SECRET"), help="AppSecret（或环境变量 QQ_BOT_APP_SECRET）")
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="监听秒数（默认 %d）" % DEFAULT_TIMEOUT)
    args = ap.parse_args()
    if not args.app_id or not args.app_secret:
        ap.error("必须提供 --app-id/--app-secret 或环境变量 QQ_BOT_APP_ID/QQ_BOT_APP_SECRET")

    token = get_app_access_token(args.app_id, args.app_secret)
    gw = urllib.request.Request(API + "/gateway", headers={"Authorization": "QQBot " + token})
    with urllib.request.urlopen(gw, timeout=15) as resp:
        ws_url = json.loads(resp.read())["url"]

    ws = websocket.create_connection(ws_url + "?v=2&encoding=json", timeout=15)
    hb = json.loads(ws.recv())["d"]["heartbeat_interval"] / 1000.0
    ws.send(json.dumps({
        "op": 2,
        "d": {"token": "QQBot " + token, "intents": (1 << 0) | (1 << 12) | (1 << 25), "shard": [0, 1]},
    }))
    print("[*] 机器人已上线监听（心跳 %.0fs）。请在 QQ 里给机器人发一条消息：" % hb)
    print("    单聊绑定：直接给机器人发任意内容")
    print("    群聊绑定：把机器人拉进群，在群里 @机器人 发言")
    sys.stdout.flush()

    deadline = time.time() + args.timeout
    c2c = group = None
    last_seq = None
    last_hb = time.time()
    while time.time() < deadline and (c2c is None or group is None):
        ws.settimeout(5.0)
        try:
            frame = json.loads(ws.recv())
            if isinstance(frame.get("s"), int):
                last_seq = frame["s"]
        except websocket.WebSocketTimeoutException:
            frame = None
        except websocket.WebSocketConnectionClosedException:
            print("[!] 连接被断开，重连中…")
            sys.stdout.flush()
            return main() if time.time() < deadline else 1
        now = time.time()
        if now - last_hb >= hb * 0.85:
            ws.send(json.dumps({"op": 1, "d": last_seq}))
            last_hb = now
        if not frame or frame.get("op") in (10, 11):
            continue
        t, d = frame.get("t"), frame.get("d") or {}
        if t == "READY":
            print("[*] READY，等待你的消息…")
        elif t == "C2C_MESSAGE_CREATE" and c2c is None:
            c2c = (d.get("author") or {}).get("user_openid")
            print("[+] 单聊 openid（来自 %r）：%s" % (d.get("content", ""), c2c))
        elif t == "GROUP_AT_MESSAGE_CREATE" and group is None:
            group = d.get("group_openid")
            print("[+] 群 group_openid：%s（发送者 openid：%s）"
                  % (group, (d.get("author") or {}).get("user_openid", "?")))
        sys.stdout.flush()

    print("\n===== 把下面的命令贴到路由器（或用 LuCI 表单填写）=====")
    if c2c:
        print("单聊：uci set at-webserver.config.qq_target_type='c2c'")
        print("      uci set at-webserver.config.qq_target_id='%s'" % c2c)
    if group:
        print("群聊：uci set at-webserver.config.qq_target_type='group'")
        print("      uci set at-webserver.config.qq_target_id='%s'" % group)
    print("      uci commit at-webserver && /etc/init.d/at-webserver restart")
    print("提示：QQ 号本身无法直接用作 openid（平台隐私设计），每个用户只需绑定一次。")
    return 0 if (c2c or group) else 1


def os_env(key):
    import os
    return os.environ.get(key, "")


if __name__ == "__main__":
    sys.exit(main())
