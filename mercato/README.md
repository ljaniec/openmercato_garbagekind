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

## Panel Data Sync

`integration.ts` rejestruje system legacy jako konektor w hubie Data Sync, a
`lib/adapter.ts` dostarcza `DataSyncAdapter` z trzema typami encji
(`sortownia.topology`, `sortownia.fractions`, `sortownia.movements`), kursorem po
numerze ruchu i parametrem „przebieg próbny". Dzięki temu synchronizacja ma
kolejkę, wznawianie, historię przebiegów i pasek postępu — zamiast crona i CSV.

## Stan na dziś

Zweryfikowane uruchomieniem na żywej instancji (Postgres + Redis + `apps/mercato`):

* topologia: 6 lokalizacji, 3 strefy, 1 magazyn,
* frakcje: 6 pozycji katalogu z profilami zapasu,
* ruchy: 176 zapisanych (81 `receipt`, 66 `transfer`, 29 `adjust`), 176
  unikalnych kluczy idempotencji, zero duplikatów przy ponownym imporcie,
* stany po imporcie zgodne z legacy co do kilograma (np. `BOKS3` 46 593 kg),
* WMS sam wystawił powiadomienia `wms.inventory.low_stock` dla frakcji poniżej
  progu — czyli reguła, której stary system nie miał gdzie zapisać.

Nie zrobione jeszcze: dedykowany pulpit sortowni (ekran backendu) i uruchamianie
importu z panelu Data Sync end‑to‑end (adapter jest zarejestrowany, ale przebieg
odpalaliśmy komendą CLI).
