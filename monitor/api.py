"""校园卡接口客户端（生活缴费-电费余量）。仅标准库。

接口是第三方小程序用的，非本项目提供；只读自己寝室的余量。
"""
import json
import os
import ssl
import time
import urllib.error
import urllib.request

from token_refresh import RefreshError, refresh as refresh_token

DEFAULT_CONFIG = "~/.config/wattwatch/config.json"


class TokenError(RuntimeError):
    """token 无效或过期（code=300）：整轮轮询都应停止。"""


def load_config(path: str | None = None) -> dict:
    path = path or os.environ.get("WATTWATCH_CONFIG") or DEFAULT_CONFIG
    with open(os.path.expanduser(path), encoding="utf-8") as f:
        return json.load(f)


def read_secret(path: str) -> str:
    with open(os.path.expanduser(path), encoding="utf-8") as f:
        return f.read().strip()


class Etslink:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.token = os.environ.get("WATTWATCH_TOKEN", "").strip() or read_secret(cfg["token_file"])
        self.interval = float(cfg.get("request_interval", 0.4))
        self._last = 0.0
        # 拿到 code=300 时用抓包种子自动续期并重试一次（见 token_refresh.py）。
        # 后端单会话，换新会让旧 token 立即失效，所以只在报错时才刷，不提前刷。
        self.auto_refresh = bool(cfg.get("auto_refresh_token", True))
        self.refresh_count = 0

    def _post(self, path: str, data: dict, _retry: bool = True, net_tries: int = 1) -> dict:
        # 两次请求之间至少间隔 interval 秒，避免给学校接口造成压力
        wait = self._last + self.interval - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        body = {"appid": self.cfg["appid"], "from": "2", "data": data, "token": self.token}
        req = urllib.request.Request(
            self.cfg["api_base"] + path,
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json", "user-agent": "wattwatch/2.0"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                j = json.loads(r.read().decode())
        except (urllib.error.URLError, TimeoutError, ssl.SSLError):
            # 校园接口偶发 TLS EOF / 超时：读余量是只读请求，重试一次，避免单个寝室抖动拖垮整轮
            if net_tries > 0:
                time.sleep(2)
                return self._post(path, data, _retry=_retry, net_tries=net_tries - 1)
            raise
        finally:
            self._last = time.monotonic()
        if j.get("code") == 300:
            if self.auto_refresh and _retry:
                try:
                    self.token = refresh_token(self.cfg)
                except RefreshError as e:
                    raise TokenError(f"{path} -> code=300 且续期失败：{e}")
                self.refresh_count += 1
                return self._post(path, data, _retry=False)
            raise TokenError(f"{path} -> code=300 {j.get('msg') or 'token 无效'}")
        if j.get("code") != 200:
            raise RuntimeError(f"{path} -> code={j.get('code')} msg={j.get('msg')}")
        return j["data"]

    def items(self) -> list[dict]:
        """全部购电项：[{payment_id, payment_type, payment_name}]（全校分属多个购电项）"""
        return self._post("/elecWater/getCardPaymentList", {"payment_type": ""})["list"]

    def areas(self, ptype: str, cid: str) -> list[dict]:
        return self._post("/elecWater/getAreaList", {"payment_type": ptype, "configId": cid})["list"]

    def builds(self, ptype: str, cid: str, area_id: str) -> list[dict]:
        return self._post("/elecWater/getBuildList", {"payment_type": ptype, "area_id": area_id, "configId": cid})["list"]

    def rooms(self, ptype: str, cid: str, area_id: str, build_id: str) -> list[dict]:
        return self._post("/elecWater/getRoomList", {"payment_type": ptype, "area_id": area_id,
                                                     "build_id": build_id, "source": None, "configId": cid})["list"]

    def balance(self, ptype: str, cid: str, area_id: str, build_id: str, room_id: str) -> float:
        info = self._post("/elecWater/getBalance", {
            "payment_type": int(ptype) if ptype.isdigit() else ptype, "area_id": area_id, "build_id": build_id,
            "room_id": room_id, "item_id": cid, "source": None, "configId": cid})
        text = str(info.get("balance", ""))
        num = "".join(c for c in text if c.isdigit() or c in ".-")
        if not num:
            raise RuntimeError(f"无法解析余量: {text!r}")
        return float(num)
