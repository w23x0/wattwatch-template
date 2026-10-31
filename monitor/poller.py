#!/usr/bin/env python3
"""WattWatch 轮询器：从 Worker 取「有注册成员的寝室」-> 逐个读电表 -> 分批上报。预测与预警都在 Worker 里完成。

用法:
  poller.py                    # 整点全量（cron 每小时 :10 启动，读数在 :10~:58 之间匀速完成）
  poller.py --new              # 只读还没有任何读数的新寝室（cron 每 10 分钟）
  poller.py --sync-dir         # 同步全校寝室目录（全部购电项）到 Worker
  poller.py --import-state F   # 导入旧版 state.json 的历史读数

对学校接口的访问约束：
  - 只读有注册成员的寝室，每个寝室每小时 1 次请求（目录信息缓存在 Worker，不重复查询）；
  - 请求匀速分布在一小时内，相邻两次至少间隔 request_interval 秒，不做并发；
  - 连续失败 max_consecutive_errors 次即停止本轮，避免接口异常时反复请求。
"""
import argparse
import fcntl
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

from api import Etslink, TokenError, load_config, read_secret

WINDOW_START_MIN = 10  # 本小时内最早 :10 才开始读，避开学校后台 :02~:04 的整点刷新
WINDOW_END_MIN = 58   # 本小时内最晚在 :58 前读完，保证每条读数都落在同一个计量小时
BATCH = 25           # 每批上报的读数条数（Worker 免费计划单次请求 CPU 有限）
FLUSH_SEC = 60       # 至少每 60 秒上报一次，让看板尽快看到新数据


class Worker:
    def __init__(self, cfg: dict):
        self.base = cfg["worker_url"].rstrip("/")
        self.token = read_secret(cfg.get("poller_token_file") or cfg["alert_token_file"])

    def call(self, method: str, path: str, payload=None, tries: int = 3):
        data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
        for i in range(tries):
            req = urllib.request.Request(self.base + path, data=data, method=method, headers={
                "content-type": "application/json", "authorization": f"Bearer {self.token}",
                "user-agent": "wattwatch-poller/2.0"})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    return json.loads(r.read().decode() or "{}")
            except urllib.error.HTTPError as e:
                if e.code < 500 or i == tries - 1:
                    raise RuntimeError(f"{method} {path} -> {e.code} {e.read().decode()[:200]}")
            except (urllib.error.URLError, TimeoutError) as e:
                if i == tries - 1:
                    raise RuntimeError(f"{method} {path} -> {e}")
            time.sleep(2 * (i + 1))


def data_dir(cfg: dict) -> str:
    d = os.path.expanduser(cfg.get("data_dir", "~/.local/share/wattwatch"))
    os.makedirs(d, exist_ok=True)
    return d


def log(cfg: dict, lines: list[str]):
    stamp = time.strftime("%F %T")
    text = "\n".join(f"{stamp}\t{x}" for x in lines)
    with open(os.path.join(data_dir(cfg), "poller.log"), "a", encoding="utf-8") as f:
        f.write(text + "\n")
    print(text)


def lock(cfg: dict, name: str):
    """同类任务同一时间只允许一个进程；拿不到锁返回 None"""
    f = open(os.path.join(data_dir(cfg), f"{name}.lock"), "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return f
    except BlockingIOError:
        f.close()
        return None


def token_age(cfg: dict, token: str) -> tuple[float, str]:
    """token 已使用天数：记录每个 token 第一次被使用的时间（接口只给出有效期 30 天，不给到期日）"""
    fp = hashlib.sha256(token.encode()).hexdigest()[:16]
    p = os.path.join(data_dir(cfg), "token_state.json")
    try:
        with open(p, encoding="utf-8") as f:
            st = json.load(f)
    except Exception:
        st = {}
    if st.get("fp") != fp:
        st = {"fp": fp, "since": time.time()}
        with open(p, "w", encoding="utf-8") as f:
            json.dump(st, f)
    return (time.time() - st["since"]) / 86400, fp


def poll(cfg: dict, only_new: bool) -> int:
    lk = lock(cfg, "new" if only_new else "poll")
    if lk is None:
        if not only_new:
            log(cfg, ["上一轮仍在运行，跳过"])
        return 0
    w = Worker(cfg)
    rooms = w.call("GET", "/api/poller/rooms" + ("?new=1" if only_new else ""))["rooms"]
    ets = Etslink(cfg)
    age, fp = token_age(cfg, ets.token)
    if not rooms:
        if not only_new:
            w.call("POST", "/api/poller/status", {"ok": True, "msg": "无需轮询的寝室", "polled": 0, "failed": 0,
                                                  "tokenAge": age, "tokenFp": fp})
        return 0

    # 匀速：把读数平均分布到本小时剩余时间（新寝室补读不需要）
    start = time.time()
    end = (start // 3600) * 3600 + WINDOW_END_MIN * 60
    spread = cfg.get("spread", True) and not only_new and end > start
    if spread:
        # 起点强制不早于 :WINDOW_START_MIN：cron 若在 :10 前启动，读数会落在学校刷新前后被归错小时。
        # 只对全量读表生效；--new 补读要立即执行，不能等。
        start = max(start, (start // 3600) * 3600 + WINDOW_START_MIN * 60)
        end = (start // 3600) * 3600 + WINDOW_END_MIN * 60  # start 抬到 :10 后仍在同一小时
    step = max(ets.interval, (end - start) / len(rooms)) if spread else ets.interval
    max_err = int(cfg.get("max_consecutive_errors", 10))

    buf_r, buf_e, lines = [], [], []
    ok_n = err_n = consecutive = alerts = 0
    last_flush = time.time()
    fatal = None

    def flush():
        nonlocal buf_r, buf_e, last_flush, alerts
        if buf_r or buf_e:
            res = w.call("POST", "/api/poller/ingest", {"readings": buf_r, "errors": buf_e})
            alerts += res.get("alerts", 0)
        buf_r, buf_e, last_flush = [], [], time.time()

    for i, r in enumerate(rooms):
        wait = start + i * step - time.time()
        if wait > 0:
            time.sleep(wait)
        name = f"{r['build_name']} {r['room_name']}"
        try:
            b = ets.balance(r["ptype"], r["item_id"], r["area_id"], r["build_id"], r["room_ext_id"])
            buf_r.append({"id": r["id"], "t": int(time.time()), "b": b})
            ok_n += 1
            consecutive = 0
        except TokenError as e:
            fatal = f"TOKEN ERROR {e}"
            break
        except Exception as e:  # 单个寝室失败不影响其他寝室
            buf_e.append({"id": r["id"], "msg": str(e)[:200]})
            lines.append(f"{name} ERROR {e}")
            err_n += 1
            consecutive += 1
            if consecutive >= max_err:
                fatal = f"连续 {consecutive} 个寝室读取失败，本轮停止：{e}"
                break
        if len(buf_r) + len(buf_e) >= BATCH or time.time() - last_flush >= FLUSH_SEC:
            flush()
    flush()

    if ets.refresh_count:  # 轮询途中 code=300 被自动续期：指纹变了，token 计时重新起算
        age, fp = token_age(cfg, ets.token)
        lines.append(f"token 已自动续期 {ets.refresh_count} 次")

    ok = fatal is None and ok_n > 0
    if fatal:
        lines.append(fatal)
    if not only_new or fatal:  # 新寝室补读不代表整体健康状况；但 token 失效等致命错误要上报
        w.call("POST", "/api/poller/status", {"ok": ok, "msg": fatal or ("" if ok else (buf_e[0]["msg"] if buf_e else "全部失败")),
                                              "polled": ok_n, "failed": len(rooms) - ok_n, "tokenAge": age, "tokenFp": fp})
    lines.append(f"完成：{ok_n} 成功，{err_n} 失败，共 {len(rooms)} 间，用时 {time.time() - start:.0f}s"
                 f"{f'，触发预警 {alerts} 间' if alerts else ''}{'（仅新寝室）' if only_new else ''}，token 已用 {age:.1f} 天")
    log(cfg, lines)
    return 2 if fatal and fatal.startswith("TOKEN") else 0 if ok or only_new else 1


def sync_dir(cfg: dict) -> int:
    w, ets = Worker(cfg), Etslink(cfg)
    want = {str(x) for x in (cfg.get("item_ids") or [])}
    only_areas = {a.strip() for a in (cfg.get("areas") or [])}
    rows = []
    for it in ets.items():
        cid, ptype, iname = str(it["payment_id"]), str(it["payment_type"]), str(it.get("payment_name") or "").strip()
        if want and cid not in want:
            continue
        if not want and "电" not in iname:  # 默认只要购电项
            continue
        for a in ets.areas(ptype, cid):
            aname = str(a["area_name"]).strip()
            if only_areas and aname not in only_areas:
                continue
            for b in ets.builds(ptype, cid, a["area_id"]):
                for r in ets.rooms(ptype, cid, a["area_id"], b["build_id"]):
                    rows.append({"item_id": cid, "ptype": ptype, "item_name": iname,
                                 "area_id": str(a["area_id"]), "area_name": aname,
                                 "build_id": str(b["build_id"]), "build_name": str(b["build_name"]).strip(),
                                 "room_id": str(r["room_id"]), "room_name": str(r["room_name"]).strip()})
            print(f"{iname} / {aname}: 累计 {len(rows)} 间")
    if not rows:
        print("没有拿到任何寝室，检查 item_ids / areas 配置")
        return 1
    res = {}
    for i in range(0, len(rows), 500):
        res = w.call("POST", "/api/poller/directory", {"rooms": rows[i:i + 500], "done": i + 500 >= len(rows)})
    log(cfg, [f"目录同步完成：{len(rows)} 间寝室，{res.get('areas')} 个校区"])
    return 0


def import_state(cfg: dict, path: str) -> int:
    w = Worker(cfg)
    with open(os.path.expanduser(path), encoding="utf-8") as f:
        state = json.load(f)
    for key, st in state.items():
        build, _, room = key.rpartition(" ")
        hist = sorted(st.get("history", []))
        base = {"build_name": build, "room_name": room}
        if cfg.get("area"):
            base["area_name"] = cfg["area"]
        try:
            res = {}
            for i in range(0, len(hist), 100):  # 分块，单次请求 CPU 有限
                res = w.call("POST", "/api/poller/import", {**base, "readings": hist[i:i + 100]})
            print(f"{key}: 导入 {len(hist)} 条 -> 寝室 #{res.get('room')}")
        except Exception as e:
            print(f"{key}: 失败 {e}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config")
    ap.add_argument("--new", action="store_true", help="只读还没有读数的寝室")
    ap.add_argument("--sync-dir", action="store_true", help="同步寝室目录")
    ap.add_argument("--import-state", metavar="STATE_JSON", help="导入旧版 state.json")
    args = ap.parse_args()
    cfg = load_config(args.config)
    try:
        if args.sync_dir:
            return sync_dir(cfg)
        if args.import_state:
            return import_state(cfg, args.import_state)
        return poll(cfg, args.new)
    except Exception as e:
        log(cfg, [f"FATAL {e}"])
        return 1


if __name__ == "__main__":
    sys.exit(main())
