#!/usr/bin/env python3
"""token 自动续期。

原理：小程序登录走 `POST /wxPay/getOpenid`，
真正决定身份的是 `encrypt_code`（微信加密 code），`js_code` 后端不校验、非空即可。
`encrypt_code` 可长期复用 —— 一旦抓包拿到，之后续期就完全在电脑上完成，不用再动手机。

后端是**单会话**：换新 token 会让旧 token 立即失效。所以只在拿到 `code=300` 时才刷，
不要"提前刷"。

种子文件 `~/.config/wattwatch/refresh.json`（chmod 600）：
    {"school_no": "...", "encrypt_code": "...", "appid": "", "from": 2}

用法:
    python3 token_refresh.py            # 立刻换一个新 token 并写回 token 文件
    python3 token_refresh.py --check    # 只校验当前 token，不刷新
    python3 token_refresh.py --show     # 显示种子文件位置与是否就绪
"""
import json
import os
import sys
import urllib.request

DEFAULT_SEED = "~/.config/wattwatch/refresh.json"


class RefreshError(RuntimeError):
    """换 token 失败（没有种子 / 接口报错 / 返回里没有 token）。"""


def seed_path(cfg: dict | None = None) -> str:
    return os.path.expanduser((cfg or {}).get("refresh_file") or DEFAULT_SEED)


def load_seed(cfg: dict | None = None) -> dict | None:
    """读续期种子；没有种子文件返回 None（不影响主流程）。"""
    try:
        with open(seed_path(cfg), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def _post(base: str, path: str, body: dict) -> dict:
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "user-agent": "wattwatch/2.0"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def refresh(cfg: dict, seed: dict | None = None) -> str:
    """换一个新 token，写回 token_file（0600），返回新 token。"""
    seed = seed or load_seed(cfg)
    if not seed:
        raise RefreshError(f"没有续期种子：{seed_path(cfg)}")
    for k in ("school_no", "encrypt_code"):
        if not seed.get(k):
            raise RefreshError(f"种子缺少字段 {k}：{seed_path(cfg)}")
    body = {
        "appid": seed.get("appid", ""),
        "from": seed.get("from", 2),
        "token": "x",  # 后端要求非空，不校验
        "data": {
            "js_code": seed.get("js_code") or "x",  # 后端不校验，非空即可
            "school_no": seed["school_no"],
            "encrypt_code": seed["encrypt_code"],
        },
    }
    j = _post(seed.get("api_base") or cfg["api_base"], "/wxPay/getOpenid", body)
    if j.get("code") != 200:
        raise RefreshError(f"换 token 失败：code={j.get('code')} msg={j.get('msg')}")
    token = (j.get("data") or {}).get("token")
    if not token:
        raise RefreshError(f"返回里没有 token：{json.dumps(j, ensure_ascii=False)[:200]}")
    path = os.path.expanduser(cfg["token_file"])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(token)
    os.chmod(path, 0o600)
    return token


def check(cfg: dict, token: str | None = None) -> bool:
    """验证 token 是否还有效（getUserInfo 返回 200）。"""
    if token is None:
        with open(os.path.expanduser(cfg["token_file"]), encoding="utf-8") as f:
            token = f.read().strip()
    j = _post(cfg["api_base"], "/user/getUserInfo",
              {"appid": cfg["appid"], "from": "2", "data": {}, "token": token})
    return j.get("code") == 200


def main() -> int:
    from api import load_config

    cfg = load_config()
    if "--show" in sys.argv:
        p = seed_path(cfg)
        seed = load_seed(cfg)
        print(f"种子文件: {p}")
        print("状态:", "就绪" if seed else "缺失")
        if seed:
            print(f"  学校: {seed.get('school_name', '?')}（{seed.get('school_no')}）")
            ec = seed.get("encrypt_code", "")
            print(f"  encrypt_code: {ec[:12]}…{ec[-6:]}（{len(ec)} 字符）")
        return 0 if seed else 1
    if "--check" in sys.argv:
        ok = check(cfg)
        print("当前 token:", "有效" if ok else "已失效")
        return 0 if ok else 1
    try:
        token = refresh(cfg)
    except RefreshError as e:
        print("续期失败:", e)
        return 1
    print("续期成功，新 token:", token[:8] + "…")
    print("已写入:", os.path.expanduser(cfg["token_file"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
