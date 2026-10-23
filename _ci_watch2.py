#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""等待最新 CI run 完成并输出结论。"""
import json
import os
import time
import urllib.request

TOKEN = os.environ["GH_TOKEN"]


def get(url):
    req = urllib.request.Request(url)
    req.add_header("Authorization", "token " + TOKEN)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


# 取最新 run
runs = get("https://api.github.com/repos/LianXia233/luci-app-mt5700/actions/runs?per_page=3")
run = runs["workflow_runs"][0]
RUN = str(run["id"])
print("watching run", RUN, run["head_sha"][:7], flush=True)

for i in range(70):
    d = get("https://api.github.com/repos/LianXia233/luci-app-mt5700/actions/runs/%s" % RUN)
    if d["status"] == "completed":
        print("CONCLUSION:", d["conclusion"])
        print("HTML:", d["html_url"])
        break
    print("[%d] status=%s" % (i, d["status"]), flush=True)
    time.sleep(60)
else:
    print("TIMEOUT waiting for CI")
