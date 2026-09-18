#!/usr/bin/env python3
"""Serwer XML-RPC systemu legacy sortowni.

Mowi dialektem XML-RPC prawdziwego webERP:
  * te same nazwy metod (weberp.xmlrpc_*),
  * ta sama mechanika sesji (Login zwraca kod liczbowy, dalsza autoryzacja
    jedzie ciasteczkiem PHPSESSID),
  * te same nazwy pol w danych (debtorno, stockid, loccode, qty),
  * ta sama sciezka endpointu: POST /api/api_xml-rpc.php.

UCZCIWA ETYKIETA: to nie jest webERP. To system legacy mowiacy XML-RPC
(protokolem z 1998 roku), odwzorowany na podstawie rzeczywistego API webERP.

Powierzchnia XML-RPC zawiera WYLACZNIE metody istniejace w webERP:
    xmlrpc_Login, xmlrpc_GetCustomer, xmlrpc_GetLocationList,
    xmlrpc_GetLocationDetails, xmlrpc_GetStockBalance, xmlrpc_GetSalesOrderHeader

Zadnych metod wymyslonych. Dane, ktorych webERP przez XML-RPC nie wystawia
(katalog kontrahentow, katalog frakcji, ksiega ruchow), ida kanalem plikowym:
system legacy zrzuca je do katalogu wsad/ jako CSV i "excelka" - patrz
legacy/generate.py i legacy/spooler.py.

Uruchomienie:
    python3 legacy/server.py --db legacy/sortownia.db --port 8088
"""

from __future__ import annotations

import argparse
import datetime as dt
import http.cookies
import pathlib
import secrets
import sqlite3
import threading
import xmlrpc.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = pathlib.Path(__file__).resolve().parent

ENDPOINT_PATH = "/api/api_xml-rpc.php"   # sciezka jak w webERP
SESSION_COOKIE = "PHPSESSID"
SESSION_TTL_SECONDS = 3600

# Jedno konto testowe - inne uwierzytelnianie jest poza zakresem.
VALID_USER = "demo"
VALID_PASSWORD = "demo"
VALID_COMPANY = "weberpdemo"

# Kody zwrotne w konwencji webERP.
LOGIN_OK = 0
LOGIN_BAD_CREDENTIALS = 3
LOGIN_BAD_COMPANY = 4
NOT_AUTHENTICATED = -1
NOT_FOUND = -2

_sessions: dict[str, float] = {}
_sessions_lock = threading.Lock()


def _now() -> dt.datetime:
    return dt.datetime.now().replace(microsecond=0)


def _new_session() -> str:
    sid = secrets.token_hex(13)          # wyglada jak identyfikator sesji PHP
    with _sessions_lock:
        _sessions[sid] = dt.datetime.now().timestamp() + SESSION_TTL_SECONDS
    return sid


def _session_valid(sid: str | None) -> bool:
    if not sid:
        return False
    with _sessions_lock:
        expires = _sessions.get(sid)
        if expires is None:
            return False
        if expires < dt.datetime.now().timestamp():
            del _sessions[sid]
            return False
    return True


class LegacyDatabase:
    """Dostep do bazy. Tylko odczyt - system legacy nigdy nie jest celem zapisu."""

    def __init__(self, db_path: pathlib.Path) -> None:
        self.db_path = db_path
        self._local = threading.local()

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
        return conn

    def rows(self, sql: str, params: tuple = ()) -> list[dict]:
        cur = self._conn().execute(sql, params)
        return [{k: ("" if v is None else v) for k, v in dict(row).items()} for row in cur.fetchall()]

    def one(self, sql: str, params: tuple = ()):
        found = self.rows(sql, params)
        return found[0] if found else None


class LegacyApi:
    """Powierzchnia XML-RPC. Kazda metoda poza Login wymaga waznej sesji."""

    def __init__(self, db: LegacyDatabase) -> None:
        self.db = db

    # --- odwzorowane z webERP -------------------------------------------------

    def Login(self, user: str, password: str, company: str):
        if company != VALID_COMPANY:
            return LOGIN_BAD_COMPANY, None
        if user != VALID_USER or password != VALID_PASSWORD:
            return LOGIN_BAD_CREDENTIALS, None
        return LOGIN_OK, _new_session()

    def GetCustomer(self, debtorno):
        found = self.db.one("SELECT * FROM debtorsmaster WHERE debtorno = ?", (str(debtorno),))
        return found if found is not None else NOT_FOUND

    def GetLocationList(self):
        return self.db.rows("SELECT loccode, locationname FROM locations ORDER BY loccode")

    def GetLocationDetails(self, loccode):
        found = self.db.one("SELECT * FROM locations WHERE loccode = ?", (str(loccode),))
        return found if found is not None else NOT_FOUND

    def GetStockBalance(self, stockid, loccode):
        found = self.db.one(
            "SELECT stockid, loccode, quantity FROM locstock WHERE stockid = ? AND loccode = ?",
            (str(stockid), str(loccode)),
        )
        if found is None:
            # Brak wiersza w locstock to w webERP po prostu stan zerowy.
            return {"stockid": str(stockid), "loccode": str(loccode), "quantity": 0.0}
        return found

    def GetSalesOrderHeader(self, orderno):
        found = self.db.one("SELECT * FROM salesorders WHERE orderno = ?", (int(orderno),))
        return found if found is not None else NOT_FOUND


# Jawna lista dozwolonych metod: dokladnie to, co wystawia webERP, ani jednej wiecej.
# Dyspozytor nie siega po nic spoza tego zbioru, wiec nazwa metody z zadania nie
# moze trafic w dowolny atrybut obiektu API.
ALLOWED_METHODS = {
    "Login",
    "GetCustomer",
    "GetLocationList",
    "GetLocationDetails",
    "GetStockBalance",
    "GetSalesOrderHeader",
}
PUBLIC_METHODS = {"Login"}


class XmlRpcHandler(BaseHTTPRequestHandler):
    server_version = "LegacySortownia/1.0"
    protocol_version = "HTTP/1.1"
    api: LegacyApi = None            # ustawiane przy starcie serwera
    quiet = False

    def log_message(self, fmt, *args):  # noqa: D102
        if not self.quiet:
            super().log_message(fmt, *args)

    def _send(self, body: bytes, status: int = 200, extra_headers: list[tuple[str, str]] = ()) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "text/xml; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for key, value in extra_headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _session_id(self) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = http.cookies.SimpleCookie()
        try:
            jar.load(raw)
        except http.cookies.CookieError:
            return None
        morsel = jar.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def do_GET(self) -> None:
        body = (
            "Legacy sortownia - endpoint XML-RPC: POST "
            f"{ENDPOINT_PATH}\n"
            "To nie jest webERP: to system legacy mowiacy dialektem XML-RPC webERP.\n"
            "Makieta interfejsu uzytkownika: webui/simag.html\n"
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != ENDPOINT_PATH:
            self._send(xmlrpc.client.dumps(
                xmlrpc.client.Fault(-32300, f"Nieznany endpoint: {self.path}"), methodresponse=True
            ).encode("utf-8"), status=404)
            return

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            params, method_name = xmlrpc.client.loads(raw.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - zla ramka XML-RPC
            self._send(xmlrpc.client.dumps(
                xmlrpc.client.Fault(-32700, f"Nieprawidlowe zadanie XML-RPC: {exc}"), methodresponse=True
            ).encode("utf-8"), status=400)
            return

        short = method_name.split("xmlrpc_")[-1] if "xmlrpc_" in method_name else None
        handler = getattr(self.api, short, None) if short in ALLOWED_METHODS else None
        if handler is None:
            self._send(xmlrpc.client.dumps(
                xmlrpc.client.Fault(-32601, f"Nieznana metoda: {method_name}"), methodresponse=True
            ).encode("utf-8"))
            return

        extra_headers: list[tuple[str, str]] = []
        if short in PUBLIC_METHODS:
            code, sid = handler(*params)
            if sid:
                extra_headers.append(("Set-Cookie", f"{SESSION_COOKIE}={sid}; Path=/; HttpOnly"))
            result = code
        elif not _session_valid(self._session_id()):
            # Ta sciezka bledu jest celowa: w prawdziwym webERP wywroci klienta jako pierwsza.
            result = NOT_AUTHENTICATED
        else:
            try:
                result = handler(*params)
            except TypeError as exc:
                self._send(xmlrpc.client.dumps(
                    xmlrpc.client.Fault(-32602, f"Zle argumenty metody {method_name}: {exc}"),
                    methodresponse=True,
                ).encode("utf-8"))
                return

        body = xmlrpc.client.dumps((result,), methodresponse=True, allow_none=True).encode("utf-8")
        self._send(body, extra_headers=extra_headers)


def serve(db_path: pathlib.Path, host: str, port: int, quiet: bool = False) -> ThreadingHTTPServer:
    if not db_path.exists():
        raise SystemExit(f"Brak bazy {db_path}. Uruchom najpierw: python3 legacy/generate.py --db {db_path}")
    handler = type("BoundHandler", (XmlRpcHandler,), {"api": LegacyApi(LegacyDatabase(db_path)), "quiet": quiet})
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True
    return httpd


def main() -> None:
    parser = argparse.ArgumentParser(description="Serwer XML-RPC systemu legacy sortowni")
    parser.add_argument("--db", default=str(HERE / "sortownia.db"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8088)
    args = parser.parse_args()

    httpd = serve(pathlib.Path(args.db), args.host, args.port)
    url = f"http://{args.host}:{args.port}{ENDPOINT_PATH}"
    print(f"Legacy sortownia slucha na {url}")
    print(f"Konto testowe: {VALID_USER} / {VALID_PASSWORD} / firma {VALID_COMPANY}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nZatrzymano.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
