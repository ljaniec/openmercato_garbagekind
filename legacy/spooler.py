#!/usr/bin/env python3
"""Zrzut plikowy systemu legacy: katalogi w CSV, ksiega ruchow w .xlsx.

Powod istnienia: webERP nie wystawia przez XML-RPC ani katalogu kontrahentow,
ani katalogu frakcji, ani ksiegi ruchow. W prawdziwym wdrozeniu te dane biora
sie skadinad - z innej bazy, z raportu, z excelka podeslanego przez ksiegowosc.
Ten modul odwzorowuje wlasnie taki kanal: cyklicznie przepisuje stan systemu
legacy do katalogu wsad/.

Zrzut zawiera tylko ruchy, ktorych trandate juz minela, wiec plik rosnie
w czasie - stad efekt zywej synchronizacji przyrostowej po stronie klienta.

Uruchomienie:
    python3 legacy/spooler.py --db legacy/sortownia.db --wsad legacy/wsad --once
    python3 legacy/spooler.py --db legacy/sortownia.db --wsad legacy/wsad --interval 5
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import pathlib
import sqlite3
import time

HERE = pathlib.Path(__file__).resolve().parent

try:  # uruchomienie jako modul pakietu (testy)
    from . import xlsx
except ImportError:  # uruchomienie jako skrypt
    import xlsx  # type: ignore

MOVES_FILE = "ruchy.xlsx"
CUSTOMERS_FILE = "kontrahenci.csv"
STOCK_FILE = "frakcje.csv"
ORDERS_FILE = "zamowienia.csv"
PAYMENTS_FILE = "zaplaty.csv"

MOVES_HEADER = ["stkmoveno", "stockid", "type", "loccode", "trandate", "debtorno", "qty", "standardcost", "orderno"]


def _connect(db_path: pathlib.Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def export_catalogs(db_path: pathlib.Path, wsad_dir: pathlib.Path) -> dict:
    """Katalogi: klucze kontrahentow i pelny katalog frakcji.

    Kontrahenci ida jako sama lista kluczy - szczegoly klient dociaga przez
    xmlrpc_GetCustomer, czyli metode, ktora w webERP naprawde istnieje.
    """
    wsad_dir.mkdir(parents=True, exist_ok=True)
    conn = _connect(db_path)
    try:
        customers = conn.execute(
            "SELECT debtorno, debtortype FROM debtorsmaster ORDER BY debtorno").fetchall()
        stocks = conn.execute(
            "SELECT stockid, description, categoryid, units, actualcost, decimalplaces "
            "FROM stockmaster ORDER BY stockid").fetchall()
        # Zamowienia ida tak samo jak kontrahenci: same klucze, szczegoly przez
        # xmlrpc_GetSalesOrderHeader - metode, ktora w webERP naprawde istnieje.
        orders = conn.execute("SELECT orderno FROM salesorders ORDER BY orderno").fetchall()
        # Wplaty ida w calosci plikiem: webERP nie wystawia rozrachunkow przez
        # XML-RPC, a wymyslanie metody, ktorej tam nie ma, jest zabronione.
        payments = conn.execute(
            "SELECT transno, debtorno, orderno, transdate, type, amount "
            "FROM debtortrans ORDER BY transno").fetchall()
    finally:
        conn.close()

    with (wsad_dir / CUSTOMERS_FILE).open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["debtorno", "debtortype"])
        writer.writerows([[row["debtorno"], row["debtortype"]] for row in customers])

    with (wsad_dir / STOCK_FILE).open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["stockid", "description", "categoryid", "units", "actualcost", "decimalplaces"])
        writer.writerows([[row[k] for k in
                           ("stockid", "description", "categoryid", "units", "actualcost", "decimalplaces")]
                          for row in stocks])

    with (wsad_dir / ORDERS_FILE).open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["orderno"])
        writer.writerows([[row["orderno"]] for row in orders])

    with (wsad_dir / PAYMENTS_FILE).open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["transno", "debtorno", "orderno", "transdate", "type", "amount"])
        writer.writerows([[row[k] for k in
                           ("transno", "debtorno", "orderno", "transdate", "type", "amount")]
                          for row in payments])

    return {"kontrahenci": len(customers), "frakcje": len(stocks), "zamowienia": len(orders),
            "zaplaty": len(payments)}


def export_moves(db_path: pathlib.Path, wsad_dir: pathlib.Path, as_of: dt.datetime | None = None) -> int:
    """Ksiega ruchow do .xlsx - tylko ruchy, ktore juz zaszly."""
    wsad_dir.mkdir(parents=True, exist_ok=True)
    moment = (as_of or dt.datetime.now()).replace(microsecond=0).isoformat()
    conn = _connect(db_path)
    try:
        rows = conn.execute(
            "SELECT stkmoveno, stockid, type, loccode, trandate, debtorno, qty, standardcost, orderno "
            "FROM stockmoves WHERE trandate <= ? ORDER BY trandate, stkmoveno", (moment,)
        ).fetchall()
    finally:
        conn.close()

    xlsx.write(
        wsad_dir / MOVES_FILE,
        MOVES_HEADER,
        [[row["stkmoveno"], row["stockid"], row["type"], row["loccode"], row["trandate"],
          row["debtorno"] if row["debtorno"] is not None else "", row["qty"], row["standardcost"],
          row["orderno"] if row["orderno"] is not None else ""]
         for row in rows],
        sheet_name="stockmoves",
    )
    return len(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Zrzut plikowy systemu legacy (katalogi + ksiega ruchow)")
    parser.add_argument("--db", default=str(HERE / "sortownia.db"))
    parser.add_argument("--wsad", default=str(HERE / "wsad"))
    parser.add_argument("--interval", type=float, default=5.0, help="co ile sekund odswiezac zrzut")
    parser.add_argument("--once", action="store_true", help="jeden zrzut zamiast petli")
    args = parser.parse_args()

    db_path = pathlib.Path(args.db)
    wsad_dir = pathlib.Path(args.wsad)
    if not db_path.exists():
        raise SystemExit(f"Brak bazy {db_path}. Uruchom najpierw: python3 legacy/generate.py --db {db_path}")

    counts = export_catalogs(db_path, wsad_dir)
    moves = export_moves(db_path, wsad_dir)
    print(f"Zrzut w {wsad_dir}: kontrahenci {counts['kontrahenci']}, "
          f"frakcje {counts['frakcje']}, zamowienia {counts['zamowienia']}, "
          f"zaplaty {counts['zaplaty']}, ruchy {moves}")
    if args.once:
        return

    print(f"Odswiezam co {args.interval} s (Ctrl+C konczy).")
    try:
        while True:
            time.sleep(args.interval)
            moves = export_moves(db_path, wsad_dir)
            print(f"  {dt.datetime.now().strftime('%H:%M:%S')} ruchy w zrzucie: {moves}")
    except KeyboardInterrupt:
        print("\nZatrzymano.")


if __name__ == "__main__":
    main()
