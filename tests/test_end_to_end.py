#!/usr/bin/env python3
"""Testy kryteriow gotowosci z rozdzialu 6 specyfikacji.

Uruchomienie:
    python3 -m unittest discover -s tests -t . -v
"""

from __future__ import annotations

import csv
import datetime as dt
import pathlib
import sys
import tempfile
import threading
import unittest
import xmlrpc.client

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from client.weberp_sync import CookieTransport, LegacyClient, sync  # noqa: E402
from legacy import generate, server, spooler, xlsx  # noqa: E402

RESERVE_STEP = 3   # sekundy: ruchy zapasowe ujawniaja sie szybko, zeby test byl krotki

# Metody, ktorych w prawdziwym webERP nie ma. Kiedys byly tu zaslepki; zostaly
# usuniete, a ten test pilnuje, zeby nie wrocily tylnymi drzwiami.
INVENTED_METHODS = ["GetCustomerList", "GetStockList", "GetStockMovesSince"]


class EndToEndTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = pathlib.Path(cls.tmp.name)
        cls.db = cls.root / "sortownia.db"
        cls.wsad = cls.root / "wsad"
        # Chwila zamkniecia bazy: ruchy bazowe sa wczesniejsze, zapasowe pozniejsze.
        cls.built_at = dt.datetime.now().replace(microsecond=0).isoformat()
        # Kryterium: generator tworzy baze i zrzut plikowy bez bledu.
        generate.build(cls.db, base_moves_count=200, reserve_moves_count=60,
                       reserve_step=RESERVE_STEP, wsad_dir=cls.wsad)

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

    # --- powierzchnia XML-RPC ------------------------------------------------

    def test_login_sets_session_cookie(self) -> None:
        transport = CookieTransport()
        with xmlrpc.client.ServerProxy(self.url, transport=transport, allow_none=True) as proxy:
            self.assertEqual(0, proxy.weberp.xmlrpc_Login("demo", "demo", "weberpdemo"))
        self.assertTrue(transport.cookie, "Login nie ustawil ciasteczka PHPSESSID")

    def test_bad_credentials_and_company(self) -> None:
        with self.proxy() as proxy:
            self.assertEqual(server.LOGIN_BAD_CREDENTIALS,
                             proxy.weberp.xmlrpc_Login("demo", "zle", "weberpdemo"))
            self.assertEqual(server.LOGIN_BAD_COMPANY,
                             proxy.weberp.xmlrpc_Login("demo", "demo", "inna"))

    def test_calls_without_session_return_minus_one(self) -> None:
        with self.proxy() as proxy:
            self.assertEqual(-1, proxy.weberp.xmlrpc_GetCustomer("D001"))
            self.assertEqual(-1, proxy.weberp.xmlrpc_GetLocationList())
            self.assertEqual(-1, proxy.weberp.xmlrpc_GetLocationDetails("BOKS1"))
            self.assertEqual(-1, proxy.weberp.xmlrpc_GetStockBalance("20 01 01", "BOKS1"))
            self.assertEqual(-1, proxy.weberp.xmlrpc_GetSalesOrderHeader(5001))

    def test_surface_has_only_real_weberp_methods(self) -> None:
        """Metody, ktorych webERP nie ma, nie moga istniec takze tutaj."""
        transport = CookieTransport()
        with xmlrpc.client.ServerProxy(self.url, transport=transport, allow_none=True) as proxy:
            self.assertEqual(0, proxy.weberp.xmlrpc_Login("demo", "demo", "weberpdemo"))
            for name in INVENTED_METHODS:
                with self.subTest(method=name), self.assertRaises(xmlrpc.client.Fault):
                    getattr(proxy.weberp, f"xmlrpc_{name}")()

    def test_unknown_method_is_a_fault(self) -> None:
        with self.proxy() as proxy, self.assertRaises(xmlrpc.client.Fault):
            proxy.weberp.xmlrpc_GetNothing()

    # --- zrzut plikowy -------------------------------------------------------

    def test_file_drop_is_readable(self) -> None:
        moves = xlsx.read(self.wsad / spooler.MOVES_FILE)
        self.assertGreaterEqual(len(moves), 200)
        self.assertEqual(set(spooler.MOVES_HEADER), set(moves[0].keys()))
        now = dt.datetime.now().isoformat()
        for move in moves:
            self.assertLessEqual(move["trandate"], now, "zrzut zawiera ruch z przyszlosci")

    def test_drop_grows_over_time(self) -> None:
        before = len(xlsx.read(self.wsad / spooler.MOVES_FILE))
        later = dt.datetime.now() + dt.timedelta(seconds=RESERVE_STEP * 5)
        spooler.export_moves(self.db, self.wsad, as_of=later)
        after = len(xlsx.read(self.wsad / spooler.MOVES_FILE))
        self.assertGreater(after, before, "kolejny zrzut nie przyniosl nowych ruchow")
        # Przywracamy stan biezacy, zeby inne testy nie zalezaly od kolejnosci.
        spooler.export_moves(self.db, self.wsad)

    # --- sens danych ---------------------------------------------------------

    def test_stock_never_goes_negative(self) -> None:
        """Sortownia nie moze wydac wiecej, niz przyjela."""
        import sqlite3
        conn = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True)
        try:
            negative = conn.execute(
                "SELECT stockid, loccode, quantity FROM locstock WHERE quantity < 0").fetchall()
            self.assertEqual([], negative, f"ujemne stany magazynowe: {negative}")

            # locstock to stan na chwile zamkniecia bazy: suma ruchow bazowych.
            as_of = self.built_at
            ledger: dict[tuple[str, str], float] = {}
            for stockid, loccode, qty in conn.execute(
                    "SELECT stockid, loccode, qty FROM stockmoves WHERE trandate <= ?", (as_of,)):
                key = (stockid, loccode)
                ledger[key] = round(ledger.get(key, 0.0) + qty, 2)
            for stockid, loccode, quantity in conn.execute(
                    "SELECT stockid, loccode, quantity FROM locstock"):
                self.assertAlmostEqual(ledger.get((stockid, loccode), 0.0), quantity, places=1,
                                       msg=f"stan {stockid}/{loccode} nie zgadza sie z ksiega")
        finally:
            conn.close()

    def test_sorting_is_a_transfer(self) -> None:
        """SORT zdejmuje z placu przyjec dokladnie tyle, ile kladzie w boksie."""
        import sqlite3
        conn = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True)
        try:
            out_of_yard = conn.execute(
                "SELECT COALESCE(SUM(qty), 0) FROM stockmoves WHERE type = 'SORT' AND loccode = 'PRZYJ'"
            ).fetchone()[0]
            into_boxes = conn.execute(
                "SELECT COALESCE(SUM(qty), 0) FROM stockmoves WHERE type = 'SORT' AND loccode != 'PRZYJ'"
            ).fetchone()[0]
            self.assertAlmostEqual(-out_of_yard, into_boxes, places=1)
        finally:
            conn.close()

    # --- integracja ----------------------------------------------------------

    def test_full_then_incremental_sync(self) -> None:
        out = self.root / "out"
        spooler.export_moves(self.db, self.wsad)   # zrzut na "teraz"

        first = sync(self.url, out, "demo", "demo", "weberpdemo", self.wsad, full=True, verbose=False)
        for name in ("kontrahenci.csv", "frakcje.csv", "lokalizacje.csv", "stany.csv",
                     "ruchy.csv", ".last_sync"):
            self.assertTrue((out / name).exists(), f"brak pliku {name}")
        self.assertEqual(8, first["kontrahenci"])
        self.assertEqual(6, first["frakcje"])
        self.assertEqual(6, first["lokalizacje"])
        self.assertGreaterEqual(first["ruchy_nowe"], 200)

        rows_first = self._moves(out)
        self.assertEqual(first["ruchy_nowe"], len(rows_first))

        # Legacy dokleja do zrzutu kolejna porcje ruchow...
        spooler.export_moves(self.db, self.wsad,
                             as_of=dt.datetime.now() + dt.timedelta(seconds=RESERVE_STEP * 5))
        # ...a drugie uruchomienie klienta bierze tylko je.
        second = sync(self.url, out, "demo", "demo", "weberpdemo", self.wsad, verbose=False)
        self.assertGreater(second["ruchy_nowe"], 0, "tryb przyrostowy nie znalazl nowych ruchow")
        self.assertLess(second["ruchy_pobrane"], first["ruchy_pobrane"],
                        "tryb przyrostowy pobral tyle samo co pelny")

        rows_second = self._moves(out)
        ids = [row["stkmoveno"] for row in rows_second]
        self.assertEqual(len(ids), len(set(ids)), "import zduplikowal ruchy")
        self.assertEqual(len(rows_first) + second["ruchy_nowe"], len(rows_second), "import zgubil ruchy")

        # Konwersja kg -> Mg jest obecna i spojna.
        for row in rows_second[:20]:
            self.assertAlmostEqual(float(row["ilosc_kg"]) / 1000.0, float(row["ilosc_mg"]), places=2)

        spooler.export_moves(self.db, self.wsad)

    def test_client_uses_only_real_methods(self) -> None:
        """Klient nie ma metody, ktorej nie ma webERP."""
        for name in INVENTED_METHODS:
            attribute = name[0].lower() + name[1:]
            self.assertFalse(hasattr(LegacyClient, attribute),
                             f"klient odwoluje sie do nieistniejacej metody {name}")

    @staticmethod
    def _moves(out: pathlib.Path) -> list[dict]:
        with (out / "ruchy.csv").open(newline="", encoding="utf-8") as handle:
            return list(csv.DictReader(handle))


if __name__ == "__main__":
    unittest.main(verbosity=2)
