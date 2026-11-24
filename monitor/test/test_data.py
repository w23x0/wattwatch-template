import unittest
from unittest.mock import patch

from api import parse_balance
import poller


class BalanceTests(unittest.TestCase):
    def test_numeric_and_unit_values(self):
        for raw, expected in [(0, 0), (-0.5, -0.5), ("12.34度", 12.34),
                              (" 12.34 kWh ", 12.34), ("剩余电量：+12.34 千瓦时", 12.34),
                              ("-.50度", -0.5), ("0.00", 0)]:
            with self.subTest(raw=raw):
                self.assertEqual(parse_balance(raw), expected)

    def test_invalid_or_ambiguous_values_are_not_reinterpreted(self):
        for raw in [None, True, False, "", "1e3", "1,234", "剩余12度，欠费3元", "12元",
                    "NaN", "Infinity", float("nan"), float("inf"), [], {}, 100001, -1001]:
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    parse_balance(raw)


class PollerTests(unittest.TestCase):
    @patch.object(poller, "log")
    @patch.object(poller, "token_age", return_value=(1, "example"))
    @patch.object(poller, "lock", return_value=object())
    @patch.object(poller, "Etslink")
    @patch.object(poller, "Worker")
    def test_failed_status_keeps_error_after_upload(self, worker_cls, client_cls, *_):
        room = {"id": 1, "ptype": "1", "item_id": "1", "area_id": "1", "build_id": "1",
                "room_ext_id": "101", "build_name": "1 栋", "room_name": "101"}
        worker = worker_cls.return_value
        worker.call.side_effect = lambda method, path, *args: {"rooms": [room]} if method == "GET" else {}
        client = client_cls.return_value
        client.interval = 0
        client.refresh_count = 0
        client.balance.side_effect = RuntimeError("meter response missing")
        result = poller.poll({"spread": False}, only_new=False)
        self.assertEqual(result, 1)
        status = next(c.args[2] for c in worker.call.call_args_list if c.args[1] == "/api/poller/status")
        self.assertFalse(status["ok"])
        self.assertEqual(status["msg"], "meter response missing")
        self.assertEqual(status["failed"], 1)


if __name__ == "__main__":
    unittest.main()
