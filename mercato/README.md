# Moduł `sortownia` dla Open Mercato

Most między systemem legacy sortowni (ten sam repozytorium, gałąź `legacy_erp`)
a Open Mercato. Nie budujemy ERP od zera — mapujemy sortownię na moduły, które
Open Mercato już ma, przede wszystkim na **WMS**.

## Co dokładnie się mapuje

| Legacy (SIMAG / webERP) | Open Mercato | Co z tego wynika |
| --- | --- | --- |
| `locations` (`PRZYJ`, `BOKS1‑4`, `MAGRDF`) | `wms_warehouses` → `wms_warehouse_zones` → `wms_warehouse_locations` | typ lokalizacji (`staging`/`bin`) i **`capacity_weight`** — boks wreszcie ma pojemność |
| `stockmaster` (frakcje) | `catalog_products` + `catalog_product_variants` (SKU = kod odpadu) + `wms_product_inventory_profiles` | próg ponownego zamówienia, jednostka magazynowa |
| `locstock` | `wms_inventory_balances` | `on_hand` / `reserved` / `allocated` i liczona kolumna `available` |
| `stockmoves` `PZ` | komenda `wms.inventory.receive` → ruch `receipt` | |
| `stockmoves` `SORT` (**para** wierszy) | komenda `wms.inventory.move` → **jeden** ruch `transfer` | przesunięcie staje się atomowe |
| `stockmoves` `WZ` | komenda `wms.inventory.adjust` → ruch `adjust` | |
| `stkmoveno` | deterministyczny `referenceId` → `idempotency_key` WMS | powtórzony import odbija się od bazy |

## Dwa kanały źródłowe

* **XML-RPC** (`lib/legacyRpc.ts`) — własny, minimalny klient protokołu z 1998
  roku, bez zależności. Open Mercato rozmawia ze starym systemem bezpośrednio,
  używając wyłącznie metod, które istnieją także w prawdziwym webERP.
* **Zrzut plikowy** (`lib/legacyFiles.ts`) — katalog frakcji i księga ruchów,
  czyli to, czego webERP przez API nie wystawia. Domyślnie katalog `out/`
  z tego repozytorium (`SORTOWNIA_LEGACY_OUT`).

## Instalacja w klonie Open Mercato

Turbopack nie rozwiązuje symlinków poza katalogiem projektu, więc moduł jest
**kopiowany**. Źródłem prawdy zostaje to repozytorium.

```bash
MERCATO_ROOT=/sciezka/do/open-mercato ./mercato/install.sh
cd /sciezka/do/open-mercato/apps/mercato
yarn generate          # rejestruje moduł, ACL, i18n, CLI i adapter
```

Zmienne środowiskowe (`apps/mercato/.env`):

```
SORTOWNIA_LEGACY_OUT=/sciezka/do/openmercato_garbagekind/out
SORTOWNIA_RPC_URL=http://127.0.0.1:8088/api/api_xml-rpc.php
SORTOWNIA_RPC_USER=demo
SORTOWNIA_RPC_PASSWORD=demo
SORTOWNIA_RPC_COMPANY=weberpdemo
```

## Uruchomienie

Po stronie legacy (to repozytorium):

```bash
python3 legacy/generate.py --db legacy/sortownia.db --wsad legacy/wsad
python3 legacy/server.py  --db legacy/sortownia.db --port 8088 &
python3 legacy/spooler.py --db legacy/sortownia.db --wsad legacy/wsad --interval 10 &
python3 client/weberp_sync.py --wsad legacy/wsad --out out --full
```

Po stronie Open Mercato:

```bash
yarn mercato sortownia import          # topologia + frakcje + księga ruchów
yarn mercato sortownia import --limit 50
```

Import jest **idempotentny**: drugie uruchomienie na tym samym zbiorze raportuje
same duplikaty i nie dopisuje ani jednego ruchu.

## Pulpit sortowni

Ekran `/backend/sortownia` (grupa „Sortownia" w nawigacji, uprawnienie
`sortownia.view`) pokazuje to, czego stary system nie umiał powiedzieć:

* cztery kafelki: masa na placu przyjęć, masa w boksach, wysortowane i wydane
  w ostatnich 30 dniach,
* przepływ każdej frakcji przez zakład (przyjęte / wysortowane / wydane),
* listę lokalizacji z **zapełnieniem względem pojemności** — pasek robi się
  pomarańczowy od 70% i czerwony od 90%,
* frakcje z progiem wysyłki i ostrzeżeniem, gdy stan zejdzie poniżej,
* ostatnie ruchy z numerem z systemu legacy, po którym da się wrócić do kwitu;
  para `SORT` pokazuje oba numery obok siebie (`#100240 + 100241`).

Dane liczone są wprost z encji WMS przez `api/dashboard/route.ts`, więc pulpit
i magazyn zawsze mówią to samo. Pulpit odświeża się co 30 sekund.

## Panel Data Sync

`integration.ts` rejestruje system legacy jako konektor w hubie Data Sync, a
`lib/adapter.ts` dostarcza `DataSyncAdapter` z trzema typami encji
(`sortownia.topology`, `sortownia.fractions`, `sortownia.movements`), kursorem po
numerze ruchu i parametrem „przebieg próbny". Dzięki temu synchronizacja ma
kolejkę, wznawianie, historię przebiegów i pasek postępu — zamiast crona i CSV.

## Testy

Moduł korzysta z narzędzi, które Open Mercato ma na pokładzie: Jest do testów
jednostkowych i Playwright do integracyjnych (`__integration__/`, odkrywane
przez `OM_INTEGRATION_MODULES`). Nic własnego nie dokładamy.

Testy jednostkowe — 98 przypadków, 8 zestawów, bez bazy i bez sieci:

```bash
cd apps/mercato
yarn test --testPathPatterns "modules/sortownia"
```

Obejmują klienta XML-RPC (ramka żądania, ciastko sesji, kody 0/3/4/−1/−2,
`<fault>`), czytnik plików (BOM, cudzysłowy, polski przecinek dziesiętny,
determinizm `legacyUuid`), topologię, frakcje, parowanie `SORT`, mapowanie na
komendy WMS, trasę pulpitu i sam komponent pulpitu (jsdom + Testing Library).

Cross-walidacja z legacy — porównuje odpowiedź pulpitu z księgą `out/ruchy.csv`:

```bash
# wymaga działającego stacku (Postgres, Redis, apps/mercato) i zrzutu legacy
OM_INTEGRATION_MODULES=sortownia BASE_URL=http://localhost:3000 \
  npx playwright test --config .ai/qa/tests/playwright.config.ts
```

Obie strony liczą z tej samej księgi, ale inaczej: legacy trzyma płaskie
wiersze w kilogramach, Mercato prowadzi salda w WMS i zwija parę `SORT` w jeden
`transfer`. Test sprawdza salda per lokalizacja i per frakcja, liczbę ruchów
(`reszta + pary/2`), podział plac/boksy, brak ujemnych stanów, zapełnienie
względem pojemności i to, że każdy ruch niesie numer ze starego systemu.
Jeżeli mapowanie gdzieś się przekłamie — zgubiony znak, zgubiona para, pomylona
jednostka — salda się rozjadą i ten test to pokaże.

Strona legacy ma własny zestaw (`python3 tests/test_end_to_end.py`, 11 testów),
który pilnuje m.in. tego, że stan nigdy nie schodzi poniżej zera i że
powierzchnia XML-RPC nie zawiera metod, których webERP nie ma.

## Stan na dziś

Zweryfikowane uruchomieniem na żywej instancji (Postgres + Redis + `apps/mercato`):

* topologia: 6 lokalizacji, 3 strefy, 1 magazyn,
* frakcje: 6 pozycji katalogu z profilami zapasu,
* ruchy: 176 zapisanych (81 `receipt`, 66 `transfer`, 29 `adjust`), 176
  unikalnych kluczy idempotencji, zero duplikatów przy ponownym imporcie,
* stany po imporcie zgodne z legacy co do kilograma (np. `BOKS3` 46 593 kg),
* WMS sam wystawił powiadomienia `wms.inventory.low_stock` dla frakcji poniżej
  progu — czyli reguła, której stary system nie miał gdzie zapisać.

Pulpit sprawdzony w przeglądarce (zalogowanie, render, zrzut ekranu): kafelki,
wykres przepływu, zapełnienie boksów i księga ruchów zasilają się z żywej bazy.

Testy: 98 jednostkowych i 11 po stronie legacy przechodzi, cross-walidacja
(8 przypadków Playwright) przechodzi na żywym stacku bez ponowień.

Nie zrobione jeszcze: uruchamianie importu z panelu Data Sync end‑to‑end
(adapter jest zarejestrowany i waliduje połączenie, ale przebiegi odpalaliśmy
komendą CLI — brakuje utworzenia rekordu integracji z poziomu panelu).
