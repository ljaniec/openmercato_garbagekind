# Prymitywny system legacy sortowni

Wiarygodne źródło danych „sprzed epoki”, z którego Open Mercato zasysa dane przez
XML-RPC — bez instalowania prawdziwego webERP w środku hackatonu.

## Uczciwa etykieta

Ten system **nie jest webERP**. Mówi dialektem XML-RPC prawdziwego webERP: te same
nazwy metod (`weberp.xmlrpc_*`), ta sama mechanika sesji (logowanie zwraca kod
liczbowy, autoryzacja jedzie dalej ciasteczkiem `PHPSESSID`), te same nazwy pól
w danych (`debtorno`, `stockid`, `loccode`, `qty`) i ta sama ścieżka endpointu.
Dzięki temu klient napisany przeciw temu systemowi zadziała przeciw prawdziwej
instancji webERP po zmianie jednego URL-a.

Zdanie, które wolno powiedzieć ze sceny:

> Po drugiej stronie stoi system legacy mówiący XML-RPC, protokołem z 1998 roku,
> odwzorowany na podstawie rzeczywistego API webERP.

Zdanie, którego powiedzieć **nie wolno**: „zintegrowaliśmy się z webERP”.

Podział metod jest oznaczony w kodzie (`legacy/server.py`):

| Odwzorowane z webERP | Dodane na potrzeby tego systemu (nie ma ich w webERP) |
| --- | --- |
| `xmlrpc_Login`, `xmlrpc_GetCustomer`, `xmlrpc_GetLocationList`, `xmlrpc_GetLocationDetails`, `xmlrpc_GetStockBalance`, `xmlrpc_GetSalesOrderHeader` | `xmlrpc_GetCustomerList`, `xmlrpc_GetStockList`, `xmlrpc_GetStockMovesSince` |

## Szybki start

Wymagania: Python 3.11+, wyłącznie biblioteka standardowa. Żadnych zależności.

```bash
./run_demo.sh                 # generator -> serwer -> klient pełny -> klient przyrostowy
PAUSE=5 ./run_demo.sh --reserve-step 3   # szybsza wersja na próbę
```

Albo krok po kroku:

```bash
python3 legacy/generate.py --db legacy/sortownia.db
python3 legacy/server.py   --db legacy/sortownia.db --port 8088
python3 client/weberp_sync.py --url http://127.0.0.1:8088/api/api_xml-rpc.php --out out --full
python3 client/weberp_sync.py --out out        # kolejne uruchomienia: tryb przyrostowy
```

Konto testowe: `demo` / `demo`, firma `weberpdemo`. Inne uwierzytelnianie jest poza zakresem.

## Model danych

Nazwy tabel i pól celowo z webERP, łącznie z jego dziwactwami (kontrahent to `debtor`).

| Tabela | Zawartość | Kluczowe pola |
| --- | --- | --- |
| `debtorsmaster` | kontrahenci: dostawcy i odbiorcy razem | `debtorno, name, address1, address2, debtortype, currcode, clientsince, creditlimit` |
| `stockmaster` | frakcje jako pozycje magazynowe | `stockid, description, categoryid, units, actualcost, decimalplaces` |
| `locations` | boksy i magazyny | `loccode, locationname, deladd1` |
| `locstock` | stany magazynowe | `stockid, loccode, quantity` |
| `stockmoves` | księga ruchów, serce systemu | `stkmoveno, stockid, type, loccode, trandate, debtorno, qty, standardcost` |
| `salesorders` | wydania do odbiorcy | `orderno, debtorno, orddate, deliverydate, stockid, qty, unitprice` |

**Jednostki.** Legacy trzyma masy w kilogramach, bo tak robią stare systemy.
Open Mercato normalizuje do Mg. Konwersja jest świadomym elementem demo:
pokazuje realny problem migracyjny, a nie tylko przepisanie wierszy — klient
emituje obie wartości (`ilosc_kg`, `ilosc_mg`).

**Typy ruchu** (`stockmoves.type`): `PZ` przyjęcie odpadu, `SORT` wysortowanie
frakcji, `WZ` wydanie do odbiorcy (ilość ujemna, konwencja webERP).
Prawdziwy webERP używa w tym miejscu numerycznych `systypes`. To uproszczenie
jest świadome i oznaczone w schemacie, żeby nikt nie budował na nim fałszywej precyzji.

## Zbiory danych

* **Zbiór bazowy (historia)** — stan, który „od lat siedzi w starym systemie”:
  8 kontrahentów, 6 frakcji, 6 lokalizacji, stany magazynowe i ok. 200 ruchów
  z ostatnich 30 dni. To migrujecie na scenie w akcie pierwszym.
* **Zbiór zapasowy (input testowy)** — ok. 60 dodatkowych ruchów ze znacznikami
  czasu ustawionymi do przodu (domyślnie co 20 s od chwili generowania).
  Serwer pokazuje wyłącznie ruchy, których `trandate` już minęła, więc kolejne
  wywołania `GetStockMovesSince` znajdują nowe rekordy. Na scenie daje to efekt
  żywej synchronizacji przyrostowej; poza sceną służy jako input testowy do
  sprawdzania, czy import nie duplikuje i nie gubi rekordów.

Tempo ujawniania: `python3 legacy/generate.py --reserve-step 5`.
Ziarno generatora jest stałe — ta sama baza przy każdym uruchomieniu.

## Powierzchnia XML-RPC

Endpoint: `POST /api/api_xml-rpc.php` (ścieżka celowo taka jak w webERP).

| Metoda | Argumenty | Zwraca |
| --- | --- | --- |
| `weberp.xmlrpc_Login` | `user, password, company` | `int`, `0` = sukces, plus `Set-Cookie: PHPSESSID` |
| `weberp.xmlrpc_GetCustomerList` | brak | lista kontrahentów |
| `weberp.xmlrpc_GetCustomer` | `debtorno` | jeden kontrahent |
| `weberp.xmlrpc_GetLocationList` | brak | lista lokalizacji |
| `weberp.xmlrpc_GetLocationDetails` | `loccode` | jedna lokalizacja |
| `weberp.xmlrpc_GetStockList` | brak | lista frakcji |
| `weberp.xmlrpc_GetStockBalance` | `stockid, loccode` | stan magazynowy |
| `weberp.xmlrpc_GetStockMovesSince` | `iso_timestamp` | ruchy nowsze niż podany czas |
| `weberp.xmlrpc_GetSalesOrderHeader` | `orderno` | nagłówek wydania |

Kody zwrotne: `0` logowanie OK, `3` złe dane logowania, `4` zła firma,
`-1` brak ważnej sesji, `-2` brak rekordu. Każda metoda poza `Login` zwraca `-1`
bez ważnej sesji — to celowe, bo w prawdziwym webERP ta ścieżka wywróci klienta
jako pierwsza, i jest pokryta testem.

## Kontrakt wyjściowy dla Open Mercato

Klient zapisuje pliki CSV gotowe pod import w hubie `data_sync` albo `sync_excel`:

| Plik | Kolumny |
| --- | --- |
| `out/kontrahenci.csv` | `debtorno, name, typ, miasto, waluta, klient_od` |
| `out/frakcje.csv` | `stockid, nazwa, kategoria, jednostka, koszt` |
| `out/lokalizacje.csv` | `loccode, nazwa, adres` |
| `out/stany.csv` | `stockid, loccode, ilosc_kg, ilosc_mg` |
| `out/ruchy.csv` | `stkmoveno, stockid, typ, loccode, data, debtorno, ilosc_kg, ilosc_mg` |
| `out/.last_sync` | znacznik czasu ostatniej synchronizacji (tryb przyrostowy) |

Słowniki i stany są nadpisywane pełnym snapshotem; `ruchy.csv` jest dopisywany
przyrostowo z kontrolą duplikatów po `stkmoveno`.

**Znacznik `.last_sync`** jest zapisywany jako najnowsza `trandate` minus jedna
sekunda. Serwer filtruje ostro (`trandate > since`), a ruchy mogą dzielić tę samą
sekundę — cofnięcie o sekundę chroni przed zgubieniem rekordu z granicy,
a powstałe nakładanie odsiewa kontrola po `stkmoveno`. Świadomie wybrano
„powtórzyć i odsiać” zamiast „pominąć i zgubić”.

## Przestawienie na prawdziwy webERP

```bash
python3 client/weberp_sync.py \
  --url https://twoj-weberp.example/api/api_xml-rpc.php \
  --user <user> --password <haslo> --company <firma> --out out --full
```

Zadziała cała ścieżka logowania, sesji i metod odwzorowanych. Trzy metody dodane
(`GetCustomerList`, `GetStockList`, `GetStockMovesSince`) w prawdziwym webERP nie
istnieją — tam trzeba je zastąpić odpowiednio listą klientów z bazy, listą pozycji
magazynowych i zapytaniem o `stockmoves`. To jedyny, znany i nazwany dług tej integracji.

## Testy

```bash
python3 -m unittest discover -s tests -t . -v
```

Pokrywają kryteria gotowości z rozdziału 6 specyfikacji: generator, logowanie
z ciasteczkiem, ścieżka `-1` bez sesji, komplet plików CSV, tryb przyrostowy bez
duplikatów i bez gubienia rekordów, brak wycieku ruchów z przyszłości.

## Poza zakresem

Księgowość, plan kont, podatki, uwierzytelnianie inne niż jedno konto testowe,
jakiekolwiek zapisy z powrotem do legacy. System jest tylko źródłem danych, nigdy
celem zapisu. Robot pisze do Open Mercato, nie tutaj — serwer otwiera bazę SQLite
w trybie tylko do odczytu (`mode=ro`) i nie wystawia żadnej metody zapisującej.
