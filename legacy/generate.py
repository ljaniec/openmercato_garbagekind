#!/usr/bin/env python3
"""Generator bazy 'legacy' sortowni.

Tworzy plik SQLite ze zbiorem bazowym (historia, ktora "od lat siedzi
w starym systemie") oraz ze zbiorem zapasowym ruchow, ktore ujawniaja sie
stopniowo w czasie dzialania demo.

Przy okazji zaklada poczatkowy zrzut plikowy w katalogu wsad/ (katalogi w CSV,
ksiega ruchow w .xlsx) - bo czesci danych webERP przez XML-RPC nie wystawia
i w prawdziwym wdrozeniu przychodza one z innej bazy albo z excelka.

Uruchomienie:
    python3 legacy/generate.py --db legacy/sortownia.db --wsad legacy/wsad
"""

from __future__ import annotations

import argparse
import datetime as dt
import pathlib
import random
import sqlite3

try:  # uruchomienie jako modul pakietu (testy)
    from . import spooler
except ImportError:  # uruchomienie jako skrypt
    import spooler  # type: ignore

HERE = pathlib.Path(__file__).resolve().parent
SCHEMA = HERE / "schema.sql"

# Ziarno stale: ta sama baza przy kazdym uruchomieniu, zeby demo bylo powtarzalne.
SEED = 20250918

DEBTORS = [
    # debtorno, name, address1, address2 (miasto), debtortype, currcode, clientsince, creditlimit
    ("D001", "Gmina Wieliszew",              "ul. Modlinska 12",     "Wieliszew",  "DOS", "PLN", "2011-03-14", 0.0),
    ("D002", "Spoldzielnia Mieszkaniowa Zorza", "ul. Sloneczna 4",   "Legionowo",  "DOS", "PLN", "2013-09-01", 0.0),
    ("D003", "PPHU Transbud",                "ul. Przemyslowa 88",   "Nowy Dwor",  "DOS", "PLN", "2016-06-20", 0.0),
    ("D004", "Zaklad Komunalny Serock",      "ul. Nadrzeczna 3",     "Serock",     "DOS", "PLN", "2009-01-08", 0.0),
    ("D005", "Stora Papier Recykling",       "ul. Fabryczna 21",     "Ostroleka",  "ODB", "PLN", "2012-04-02", 250000.0),
    ("D006", "PlastMet Sp. z o.o.",          "ul. Tworzywowa 7",     "Plock",      "ODB", "PLN", "2014-11-17", 180000.0),
    ("D007", "Huta Szkla Jaroslaw",          "ul. Hutnicza 1",       "Jaroslaw",   "ODB", "EUR", "2018-02-05", 120000.0),
    ("D008", "Cementownia Odolanow RDF",     "ul. Wapienna 40",      "Odolanow",   "ODB", "PLN", "2019-08-22", 300000.0),
]

STOCKS = [
    # stockid, description, categoryid, units, actualcost (PLN/kg), decimalplaces
    ("20 01 01", "Papier i tektura",            "SUR", "kg", 0.32, 2),
    ("15 01 02", "Tworzywa sztuczne PET",       "SUR", "kg", 1.15, 2),
    ("20 01 02", "Szklo opakowaniowe",          "SUR", "kg", 0.08, 2),
    ("20 01 40", "Metale (zlom mieszany)",      "SUR", "kg", 1.85, 2),
    ("19 12 10", "RDF - paliwo alternatywne",   "PAL", "kg", 0.05, 2),
    ("20 02 01", "Odpady ulegajace biodegradacji", "BIO", "kg", 0.02, 2),
]

LOCATIONS = [
    ("PRZYJ", "Plac przyjec",       "ul. Skladowa 2, Wieliszew"),
    ("BOKS1", "Boks 1 - papier",    "ul. Skladowa 2, Wieliszew"),
    ("BOKS2", "Boks 2 - tworzywa",  "ul. Skladowa 2, Wieliszew"),
    ("BOKS3", "Boks 3 - szklo",     "ul. Skladowa 2, Wieliszew"),
    ("BOKS4", "Boks 4 - metale",    "ul. Skladowa 2, Wieliszew"),
    ("MAGRDF", "Magazyn RDF",       "ul. Skladowa 6, Wieliszew"),
]

# Do ktorego boksu trafia wysortowana frakcja i z ktorego jest wydawana.
FRACTION_LOC = {
    "20 01 01": "BOKS1",
    "15 01 02": "BOKS2",
    "20 01 02": "BOKS3",
    "20 01 40": "BOKS4",
    "19 12 10": "MAGRDF",
    "20 02 01": "PRZYJ",
}

# Ktory odbiorca bierze ktora frakcje.
FRACTION_BUYER = {
    "20 01 01": "D005",
    "15 01 02": "D006",
    "20 01 02": "D007",
    "20 01 40": "D006",
    "19 12 10": "D008",
    "20 02 01": "D008",
}

SUPPLIERS = [d[0] for d in DEBTORS if d[4] == "DOS"]
COST = {s[0]: s[4] for s in STOCKS}


def iso(moment: dt.datetime) -> str:
    return moment.replace(microsecond=0).isoformat()


def make_base_moves(rng: random.Random, now: dt.datetime, count: int, start_no: int):
    """Zbior bazowy: ~`count` ruchow z ostatnich 30 dni."""
    moves = []
    no = start_no
    for _ in range(count):
        offset = rng.uniform(0.5, 30.0)           # dni wstecz
        when = now - dt.timedelta(days=offset)
        roll = rng.random()
        if roll < 0.40:                            # PZ - przyjecie odpadu zmieszanego
            stockid = rng.choice(list(FRACTION_LOC))
            qty = round(rng.uniform(800, 9000), 2)
            move = (no, stockid, "PZ", "PRZYJ", iso(when), rng.choice(SUPPLIERS), qty, COST[stockid])
        elif roll < 0.80:                          # SORT - wysortowanie frakcji
            stockid = rng.choice(list(FRACTION_LOC))
            qty = round(rng.uniform(300, 4500), 2)
            move = (no, stockid, "SORT", FRACTION_LOC[stockid], iso(when), None, qty, COST[stockid])
        else:                                      # WZ - wydanie do odbiorcy (qty ujemne)
            stockid = rng.choice(list(FRACTION_BUYER))
            qty = -round(rng.uniform(500, 12000), 2)
            move = (no, stockid, "WZ", FRACTION_LOC[stockid], iso(when), FRACTION_BUYER[stockid], qty, COST[stockid])
        moves.append(move)
        no += 1
    moves.sort(key=lambda m: m[4])
    # Numery ruchow rosna razem z data, jak w ksiedze prowadzonej chronologicznie.
    return [(start_no + i,) + m[1:] for i, m in enumerate(moves)]


def make_reserve_moves(rng: random.Random, now: dt.datetime, count: int, start_no: int, step_seconds: int):
    """Zbior zapasowy: ruchy ze znacznikami czasu w przyszlosci.

    Spooler zrzuca do wsad/ tylko te ruchy, ktorych trandate juz minela, wiec
    plik rosnie w czasie, a kolejne uruchomienia klienta znajduja nowe rekordy
    - to daje efekt zywej synchronizacji przyrostowej.
    """
    moves = []
    for i in range(count):
        when = now + dt.timedelta(seconds=step_seconds * (i + 1))
        roll = rng.random()
        if roll < 0.45:
            stockid = rng.choice(list(FRACTION_LOC))
            qty = round(rng.uniform(900, 7000), 2)
            move = (start_no + i, stockid, "PZ", "PRZYJ", iso(when), rng.choice(SUPPLIERS), qty, COST[stockid])
        elif roll < 0.85:
            stockid = rng.choice(list(FRACTION_LOC))
            qty = round(rng.uniform(400, 3800), 2)
            move = (start_no + i, stockid, "SORT", FRACTION_LOC[stockid], iso(when), None, qty, COST[stockid])
        else:
            stockid = rng.choice(list(FRACTION_BUYER))
            qty = -round(rng.uniform(600, 9000), 2)
            move = (start_no + i, stockid, "WZ", FRACTION_LOC[stockid], iso(when), FRACTION_BUYER[stockid], qty, COST[stockid])
        moves.append(move)
    return moves


def make_sales_orders(base_moves, start_no: int):
    """Naglowki wydan zbudowane z ruchow WZ ze zbioru bazowego."""
    orders = []
    no = start_no
    for move in base_moves:
        if move[2] != "WZ":
            continue
        stkmoveno, stockid, _type, _loc, trandate, debtorno, qty, cost = move
        orddate = (dt.datetime.fromisoformat(trandate) - dt.timedelta(days=2)).date().isoformat()
        deliverydate = dt.datetime.fromisoformat(trandate).date().isoformat()
        orders.append((no, debtorno, orddate, deliverydate, stockid, abs(qty), round(cost * 1.35, 4)))
        no += 1
    return orders


def build(db_path: pathlib.Path, base_moves_count: int, reserve_moves_count: int, reserve_step: int,
          wsad_dir: pathlib.Path | None = None) -> None:
    rng = random.Random(SEED)
    now = dt.datetime.now().replace(microsecond=0)

    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()

    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA.read_text(encoding="utf-8"))

    conn.executemany("INSERT INTO debtorsmaster VALUES (?,?,?,?,?,?,?,?)", DEBTORS)
    conn.executemany("INSERT INTO stockmaster VALUES (?,?,?,?,?,?)", STOCKS)
    conn.executemany("INSERT INTO locations VALUES (?,?,?)", LOCATIONS)

    base_moves = make_base_moves(rng, now, base_moves_count, start_no=100001)
    reserve_moves = make_reserve_moves(
        rng, now, reserve_moves_count, start_no=100001 + len(base_moves), step_seconds=reserve_step
    )
    conn.executemany("INSERT INTO stockmoves VALUES (?,?,?,?,?,?,?,?)", base_moves + reserve_moves)

    # Stany magazynowe wynikaja ze zbioru bazowego (ruchy zapasowe jeszcze "nie zaszly").
    balances: dict[tuple[str, str], float] = {}
    for _no, stockid, _type, loccode, _trandate, _debtorno, qty, _cost in base_moves:
        key = (stockid, loccode)
        balances[key] = round(balances.get(key, 0.0) + qty, 2)
    for (stockid, loccode), qty in balances.items():
        conn.execute("INSERT INTO locstock VALUES (?,?,?)", (stockid, loccode, qty))

    conn.executemany(
        "INSERT INTO salesorders VALUES (?,?,?,?,?,?,?)", make_sales_orders(base_moves, start_no=5001)
    )

    conn.commit()
    counts = {
        table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in ("debtorsmaster", "stockmaster", "locations", "locstock", "stockmoves", "salesorders")
    }
    conn.close()

    print(f"Baza: {db_path}")
    for table, n in counts.items():
        print(f"  {table:<14} {n}")
    print(f"  w tym ruchy zapasowe: {len(reserve_moves)} (co {reserve_step} s od teraz)")

    if wsad_dir is not None:
        spooler.export_catalogs(db_path, wsad_dir)
        exported = spooler.export_moves(db_path, wsad_dir)
        print(f"Zrzut plikowy: {wsad_dir} (ruchy w excelku: {exported})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generator bazy legacy sortowni")
    parser.add_argument("--db", default=str(HERE / "sortownia.db"), help="sciezka pliku SQLite")
    parser.add_argument("--base-moves", type=int, default=200, help="liczba ruchow zbioru bazowego")
    parser.add_argument("--reserve-moves", type=int, default=60, help="liczba ruchow zbioru zapasowego")
    parser.add_argument("--reserve-step", type=int, default=20,
                        help="co ile sekund ujawnia sie kolejny ruch zapasowy")
    parser.add_argument("--wsad", default=str(HERE / "wsad"),
                        help="katalog zrzutu plikowego (katalogi CSV + ksiega ruchow .xlsx)")
    args = parser.parse_args()
    build(pathlib.Path(args.db), args.base_moves, args.reserve_moves, args.reserve_step,
          pathlib.Path(args.wsad))


if __name__ == "__main__":
    main()
