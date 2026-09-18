#!/usr/bin/env python3
"""Klient XML-RPC: system legacy sortowni -> pliki CSV dla Open Mercato.

Klient jest napisany przeciw dialektowi webERP, wiec przestawienie go na
prawdziwa instancje webERP to zmiana jednego URL-a (--url).

Uruchomienie:
    python3 client/weberp_sync.py --url http://127.0.0.1:8088/api/api_xml-rpc.php --out out
    python3 client/weberp_sync.py --out out            # kolejne uruchomienie = tryb przyrostowy
    python3 client/weberp_sync.py --out out --full     # pelne odswiezenie
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import pathlib
import sys
import xmlrpc.client

DEFAULT_URL = "http://127.0.0.1:8088/api/api_xml-rpc.php"
EPOCH = "1970-01-01T00:00:00"
SESSION_COOKIE = "PHPSESSID"
NOT_AUTHENTICATED = -1
FIRST_ORDER_NO = 5001   # pierwszy numer wydania nadawany przez generator

# Legacy trzyma masy w kilogramach; Open Mercato normalizuje do Mg (ton).
# Konwersja jest swiadomym elementem integracji - klient emituje obie wartosci.
KG_PER_MG = 1000.0


def kg_to_mg(kg: float) -> float:
    return round(float(kg) / KG_PER_MG, 3)


class CookieTransport(xmlrpc.client.Transport):
    """Transport zapamietujacy ciasteczko sesji - dokladnie jak webERP tego wymaga."""

    def __init__(self) -> None:
        super().__init__()
        self.cookie: str | None = None

    def send_headers(self, connection, headers):  # noqa: D102
        if self.cookie:
            connection.putheader("Cookie", f"{SESSION_COOKIE}={self.cookie}")
        super().send_headers(connection, headers)

    def parse_response(self, response):  # noqa: D102
        for header, value in response.getheaders():
            if header.lower() == "set-cookie" and value.startswith(f"{SESSION_COOKIE}="):
                self.cookie = value.split(";", 1)[0].split("=", 1)[1]
        return super().parse_response(response)


class LegacyClient:
    def __init__(self, url: str, verbose: bool = True) -> None:
        self.url = url
        self.verbose = verbose
        self.transport = CookieTransport()
        self.proxy = xmlrpc.client.ServerProxy(url, transport=self.transport, allow_none=True)

    def close(self) -> None:
        self.proxy("close")

    def log(self, message: str) -> None:
        if self.verbose:
            print(message)

    def login(self, user: str, password: str, company: str) -> None:
        code = self.proxy.weberp.xmlrpc_Login(user, password, company)
        if code != 0:
            raise SystemExit(f"Logowanie odrzucone przez system legacy (kod {code}).")
        if not self.transport.cookie:
            raise SystemExit("Logowanie zwrocilo 0, ale serwer nie ustawil ciasteczka sesji.")
        self.log(f"Zalogowano (kod 0), sesja {SESSION_COOKIE}={self.transport.cookie[:8]}...")

    @staticmethod
    def _check(result, method: str):
        if result == NOT_AUTHENTICATED:
            raise SystemExit(f"{method}: brak waznej sesji (-1).")
        return result

    def customers(self):
        return self._check(self.proxy.weberp.xmlrpc_GetCustomerList(), "GetCustomerList")

    def customer(self, debtorno: str):
        return self._check(self.proxy.weberp.xmlrpc_GetCustomer(debtorno), "GetCustomer")

    def locations(self):
        return self._check(self.proxy.weberp.xmlrpc_GetLocationList(), "GetLocationList")

    def location_details(self, loccode: str):
        return self._check(self.proxy.weberp.xmlrpc_GetLocationDetails(loccode), "GetLocationDetails")

    def stock_list(self):
        return self._check(self.proxy.weberp.xmlrpc_GetStockList(), "GetStockList")

    def stock_balance(self, stockid: str, loccode: str):
        return self._check(self.proxy.weberp.xmlrpc_GetStockBalance(stockid, loccode), "GetStockBalance")

    def moves_since(self, iso_timestamp: str):
        return self._check(self.proxy.weberp.xmlrpc_GetStockMovesSince(iso_timestamp), "GetStockMovesSince")

    def sales_order_header(self, orderno: int):
        return self._check(self.proxy.weberp.xmlrpc_GetSalesOrderHeader(orderno), "GetSalesOrderHeader")


def write_csv(path: pathlib.Path, header: list[str], rows: list[list]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


MOVES_HEADER = ["stkmoveno", "stockid", "typ", "loccode", "data", "debtorno", "ilosc_kg", "ilosc_mg"]


def existing_move_ids(path: pathlib.Path) -> set[str]:
    if not path.exists():
        return set()
    with path.open(newline="", encoding="utf-8") as handle:
        return {row["stkmoveno"] for row in csv.DictReader(handle) if row.get("stkmoveno")}


def append_moves(path: pathlib.Path, rows: list[list]) -> None:
    new_file = not path.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        if new_file:
            writer.writerow(MOVES_HEADER)
        writer.writerows(rows)


def sync(url: str, out_dir: pathlib.Path, user: str, password: str, company: str,
         full: bool = False, since_override: str | None = None, verbose: bool = True) -> dict:
    client = LegacyClient(url, verbose=verbose)
    client.log(f"Zrodlo: {url}")
    client.login(user, password, company)

    last_sync_file = out_dir / ".last_sync"
    moves_file = out_dir / "ruchy.csv"

    if since_override is not None:
        since = since_override
    elif full or not last_sync_file.exists():
        since = EPOCH
    else:
        since = last_sync_file.read_text(encoding="utf-8").strip() or EPOCH

    if full and moves_file.exists():
        moves_file.unlink()

    # --- slowniki: zawsze pelny snapshot -------------------------------------
    customers = client.customers()
    write_csv(out_dir / "kontrahenci.csv",
              ["debtorno", "name", "typ", "miasto", "waluta", "klient_od"],
              [[c["debtorno"], c["name"], c["debtortype"], c["address2"], c["currcode"], c["clientsince"]]
               for c in customers])

    stocks = client.stock_list()
    write_csv(out_dir / "frakcje.csv",
              ["stockid", "nazwa", "kategoria", "jednostka", "koszt"],
              [[s["stockid"], s["description"], s["categoryid"], s["units"], s["actualcost"]] for s in stocks])

    # GetLocationList zwraca skrocony rekord - adres dociagamy per lokalizacja,
    # dokladnie jak w prawdziwym webERP.
    locations = client.locations()
    location_rows = []
    for loc in locations:
        details = client.location_details(loc["loccode"])
        location_rows.append([loc["loccode"], loc["locationname"], details.get("deladd1", "")])
    write_csv(out_dir / "lokalizacje.csv", ["loccode", "nazwa", "adres"], location_rows)

    balance_rows = []
    for stock in stocks:
        for loc in locations:
            balance = client.stock_balance(stock["stockid"], loc["loccode"])
            qty = float(balance["quantity"])
            if qty == 0.0:
                continue
            balance_rows.append([stock["stockid"], loc["loccode"], round(qty, 2), kg_to_mg(qty)])
    write_csv(out_dir / "stany.csv", ["stockid", "loccode", "ilosc_kg", "ilosc_mg"], balance_rows)

    # --- kontrola pozostalych metod powierzchni -------------------------------
    # GetCustomer i GetSalesOrderHeader nie zasilaja CSV, ale sa czescia kontraktu
    # webERP - odpytujemy je, zeby rozjazd API ujawnil sie tutaj, a nie na scenie.
    if customers:
        probe = client.customer(customers[0]["debtorno"])
        client.log(f"GetCustomer({customers[0]['debtorno']}) -> {probe['name']}")
    order = client.sales_order_header(FIRST_ORDER_NO)
    if isinstance(order, dict):
        client.log(f"GetSalesOrderHeader({FIRST_ORDER_NO}) -> {order['debtorno']} / {order['stockid']}")
    else:
        client.log(f"GetSalesOrderHeader({FIRST_ORDER_NO}) -> brak zamowienia (kod {order})")

    # --- ruchy: tryb przyrostowy ---------------------------------------------
    client.log(f"Ruchy od: {since}")
    moves = client.moves_since(since)
    known = existing_move_ids(moves_file)
    fresh = [m for m in moves if str(m["stkmoveno"]) not in known]
    append_moves(moves_file, [
        [m["stkmoveno"], m["stockid"], m["type"], m["loccode"], m["trandate"], m["debtorno"],
         round(float(m["qty"]), 2), kg_to_mg(m["qty"])]
        for m in fresh
    ])

    if moves:
        newest = max(m["trandate"] for m in moves)
        # Cofamy znacznik o sekunde: serwer filtruje ostro (>), a ruchy moga
        # dzielic te sama sekunde. Duplikaty odsiewa kontrola po stkmoveno.
        watermark = (dt.datetime.fromisoformat(newest) - dt.timedelta(seconds=1)).isoformat()
    else:
        watermark = since
    last_sync_file.write_text(watermark, encoding="utf-8")

    stats = {
        "kontrahenci": len(customers),
        "frakcje": len(stocks),
        "lokalizacje": len(location_rows),
        "stany": len(balance_rows),
        "ruchy_pobrane": len(moves),
        "ruchy_nowe": len(fresh),
        "ruchy_pominiete_jako_duplikaty": len(moves) - len(fresh),
        "last_sync": watermark,
    }
    client.close()
    client.log("Zapisano do " + str(out_dir) + ":")
    for key, value in stats.items():
        client.log(f"  {key:<30} {value}")
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Klient XML-RPC legacy -> CSV dla Open Mercato")
    parser.add_argument("--url", default=DEFAULT_URL,
                        help="endpoint XML-RPC; zmiana tego jednego argumentu przestawia klienta "
                             "na prawdziwa instancje webERP")
    parser.add_argument("--out", default="out", help="katalog wyjsciowy CSV")
    parser.add_argument("--user", default="demo")
    parser.add_argument("--password", default="demo")
    parser.add_argument("--company", default="weberpdemo")
    parser.add_argument("--full", action="store_true", help="pelne odswiezenie zamiast trybu przyrostowego")
    parser.add_argument("--since", help="wymus punkt startowy dla ruchow (ISO 8601)")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    try:
        sync(args.url, pathlib.Path(args.out), args.user, args.password, args.company,
             full=args.full, since_override=args.since, verbose=not args.quiet)
    except ConnectionError as exc:
        raise SystemExit(f"Brak polaczenia z {args.url}: {exc}") from exc
    except xmlrpc.client.Fault as exc:
        raise SystemExit(f"Blad XML-RPC: {exc}") from exc


if __name__ == "__main__":
    main()
