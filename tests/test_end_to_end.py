#!/usr/bin/env python3
"""Testy kryteriow gotowosci z rozdzialu 6 specyfikacji.

Uruchomienie:
    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import csv
import pathlib
import sys
import tempfile
import threading
import time
import unittest
import xmlrpc.client

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from client.weberp_sync import sync  # noqa: E402
from legacy import generate, server  # noqa: E402

RESERVE_STEP = 2   # sekundy: ruchy zapasowe ujawniaja sie szybko, zeby test byl krotki


class EndToEndTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = pathlib.Path(cls.tmp.name)
        cls.db = cls.root / "sortownia.db"
        # Kryterium: generator tworzy baze bez bledu.
        generate.build(cls.db, base_moves_count=200, reserve_moves_count=60, reserve_step=RESERVE_STEP)

        cls.httpd = server.serve(cls.db, "127.0.0.1", 0, quiet=True)
        cls.port = cls.httpd.server_address[1]
        cls.url = f"http://127.0.0.1:{cls.port}{server.ENDPOINT_PATH}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def proxy(self) -> xmlrpc.client.ServerProxy:
        return xmlrpc.client.ServerProxy(self.url, allow_none=True)

    def test_login_sets_session_cookie(self) -> None:
        from client.weberp_sync import CookieTransport
        transport = CookieTransport()
        with xmlrpc.client.ServerProxy(self.url, transport=transport, allow_none=True) as proxy:
            self.assertEqual(0, proxy.weberp.xmlrpc_Login("demo", "demo", "weberpdemo"))
        self.assertTrue(transport.cookie, "Login nie ustawil ciasteczka PHPSESSID")

    def test_bad_credentials_and_company(self) -> None:
        with self.proxy() as proxy:
            self.assertEqual(server.LOGIN_BAD_CREDENTIALS,
                             proxy.weberp.xmlrpc_Login("demo", "zle", "weberpdemo"))
            self.assertEqual(server.LOGIN_BAD_COMPANY, proxy.weberp.xmlrpc_Login("demo", "demo", "inna"))

    def test_calls_without_session_return_minus_one(self) -> None:
        with self.proxy() as proxy:
            self.assertEqual(-1, proxy.weberp.xmlrpc_GetCustomerList())
            self.assertEqual(-1, proxy.weberp.xmlrpc_GetCustomer("D001"))
            self.assertEqual(-1, proxy.weberp.xmlrpc_GetLocationList())
            self.assertEqual(-1, proxy.weberp.xmlrpc_GetLocationDetails("BOKS1"))
            self.assertEqual(-1, proxy.weberp.xmlrpc_GetStockList())
            self.assertEqual(-1, proxy.weberp.xmlrpc_GetStockBalance("20 01 01", "BOKS1"))
            self.assertEqual(-1, proxy.weberp.xmlrpc_GetStockMovesSince("1970-01-01T00:00:00"))
            self.assertEqual(-1, proxy.weberp.xmlrpc_GetSalesOrderHeader(5001))

    def test_unknown_method_is_a_fault(self) -> None:
        with self.proxy() as proxy, self.assertRaises(xmlrpc.client.Fault):
            proxy.weberp.xmlrpc_GetNothing()

    def test_full_then_incremental_sync(self) -> None:
        out = self.root / "out"

        first = sync(self.url, out, "demo", "demo", "weberpdemo", full=True, verbose=False)
        for name in ("kontrahenci.csv", "frakcje.csv", "lokalizacje.csv", "stany.csv", "ruchy.csv", ".last_sync"):
            self.assertTrue((out / name).exists(), f"brak pliku {name}")
        self.assertEqual(8, first["kontrahenci"])
        self.assertEqual(6, first["frakcje"])
        self.assertEqual(6, first["lokalizacje"])
        self.assertGreaterEqual(first["ruchy_nowe"], 200)

        rows_first = self._moves(out)
        self.assertEqual(first["ruchy_nowe"], len(rows_first))

        # Kryterium: drugie uruchomienie pobiera tylko nowe ruchy.
        time.sleep(RESERVE_STEP * 2 + 1)
        second = sync(self.url, out, "demo", "demo", "weberpdemo", verbose=False)
        self.assertGreater(second["ruchy_nowe"], 0, "tryb przyrostowy nie znalazl nowych ruchow")
        self.assertLess(second["ruchy_pobrane"], first["ruchy_pobrane"],
                        "tryb przyrostowy pobral tyle samo co pelny")

        rows_second = self._moves(out)
        ids = [r["stkmoveno"] for r in rows_second]
        self.assertEqual(len(ids), len(set(ids)), "import zduplikowal ruchy")
        self.assertEqual(len(rows_first) + second["ruchy_nowe"], len(rows_second), "import zgubil ruchy")

        # Konwersja kg -> Mg jest obecna i spojna.
        for row in rows_second[:20]:
            self.assertAlmostEqual(float(row["ilosc_kg"]) / 1000.0, float(row["ilosc_mg"]), places=2)

    def test_no_future_moves_are_leaked(self) -> None:
        from client.weberp_sync import LegacyClient
        client = LegacyClient(self.url, verbose=False)
        client.login("demo", "demo", "weberpdemo")
        import datetime as dt
        now = dt.datetime.now().isoformat()
        for move in client.moves_since("1970-01-01T00:00:00"):
            self.assertLessEqual(move["trandate"], now, "serwer ujawnil ruch z przyszlosci")
        client.close()

    @staticmethod
    def _moves(out: pathlib.Path) -> list[dict]:
        with (out / "ruchy.csv").open(newline="", encoding="utf-8") as handle:
            return list(csv.DictReader(handle))


if __name__ == "__main__":
    unittest.main(verbosity=2)
