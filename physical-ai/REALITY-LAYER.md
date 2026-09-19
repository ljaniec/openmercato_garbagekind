# Reality Layer — zaufana granica ERP ↔ świat fizyczny

Ten dokument opisuje, gdzie `reality_layer` siedzi w architekturze gałęzi
`physical_ai` i czego nie wolno z nim utożsamiać.

## Pozycja w obecnym projekcie

Istniejące moduły robotyczne mają wyraźny podział odpowiedzialności:

- `fleet` — co fizycznie istnieje i jaki ma kontrakt sprzętowy;
- `edge` — tożsamość kryptograficzna i żywotność agenta;
- `policy_registry` / `deployment` / `rollout` — co wolno uruchomić i gdzie;
- `safety` — deterministyczne dopuszczenie i incydenty;
- `episodes` / `vision` — deklaracje robota i obserwacje;
- `work_orders` — konkretny most produkcyjny: zlecenie, pojemnik, waga i masa.

`reality_layer` dodaje inną rzecz: ogólny semantyczny kontrakt dla operacji,
które zaczynają się jako zamiar biznesowy, dzieją się poza bazą danych, a potem
muszą zostać bezpiecznie uzgodnione z ERP.

> Intent nie jest autoryzacją. Wykonanie nie jest dowodem. Dowód nie jest prawdą ERP.

## Zgodność z granicą control plane / data plane

Reality Layer nie steruje przegubami, nie przenosi telemetrii i nie jest kanałem
wideo. W tabelach i szynie komend zapisuje wyłącznie stan semantyczny:

```text
PhysicalIntent
  -> AuthorizationGrant
  -> ExecutionRecord
  -> EvidenceEnvelope[]
  -> RealityDiff
  -> jawna decyzja reconciliation
  -> istniejąca komenda domenowa ERP
```

ROS 2, MQTT, HTTP, vendor SDK, MoveIt, Nav2 czy LeRobot są szczegółem adaptera
`PhysicalExecutor`, a nie częścią kontraktu biznesowego.

## To nie jest kolejny moduł sterowania robotem

W `physical-ai/README.md` obowiązuje zasada, że moduły robotycznego control
plane nie zależą od `catalog`, `sales` ani `wms`. Reality Layer tej zasady nie
łamie, ponieważ jest warstwą graniczną ERP ↔ fizyka, a nie modułem sterowania.

Rdzeń `reality_layer` ma `requires: []`. Gdy później zaakceptowany `RealityDiff`
ma zmienić stan WMS, robi to adapter efektu przez istniejącą komendę CommandBus.
Executor robota nadal nie zna WMS.

## Stan implementacji — M1

Na gałęzi `reality-layer-physical-ai`:

- pięć trwałych encji: `PhysicalIntent`, `AuthorizationGrant`, `ExecutionRecord`,
  `EvidenceEnvelope`, `RealityDiff`;
- migracja modułu z indeksami i granicami idempotencji;
- ACL i domyślne role;
- trzy jawne maszyny stanów: intent / execution / diff;
- komendy `reality_layer.intent.create`, `reality_layer.intent.cancel`,
  `reality_layer.authorization.grant`;
- fail-closed scope tenant/organization;
- rodzaj principal rozpoznawany przez Query Engine `auth:user`, bez importu
  encji ORM z modułu `auth`;
- human-only grant i zakaz self-authorization;
- scope grantu wyliczany z danych intentu załadowanych po stronie serwera;
- idempotent replay intentu związany także z pierwotnym aktorem.

Sam grant nie przełącza intentu na `AUTHORIZED`. To zrobi dopiero M2 Reality
Gate po niezależnym sprawdzeniu wszystkich warunków.

## M2 — Reality Gate

Na gałęzi `reality-layer-m2` działa deterministyczna brama przed dispatch:

```text
business_precondition
AND executor_capability
AND executor_credential
AND authorization_grant
AND deterministic_policy
```

Każdy warunek zwraca `pass`, `block` albo `unknown`. Tylko pięć `pass` daje
`AUTHORIZED`; `unknown` jest fail-closed i daje `BLOCKED`.

Dwa backendy wykonawcy są rozpoznawane już na tym etapie:

- `mock:<id>` — samodzielna ścieżka referencyjna bez zależności od modułów robotycznych;
- `robot:<uuid>` — odczytuje bieżące fakty z `fleet`, `edge`, `deployment` i `safety` bez importowania ich encji ORM.

Dla WMS gate potrafi sprawdzić bieżące `quantity_available`, a nie tylko
`quantity_on_hand`. Dla prawdziwego robota wymaga ważnego klucza Edge,
heartbeat w oknie `online`, aktywnego deploymentu w stanie `running` i
ponownego przejścia `safety.clearance.check`.

Najważniejsza własność czasowa: `AUTHORIZED` nie jest przywilejem na zawsze.
Ponowna ewaluacja przed dispatch może cofnąć intent do `BLOCKED`, jeśli grant
wygasł lub został odwołany, robot stracił łączność, stan magazynu się zmienił,
deployment został zatrzymany albo Safety przestało dopuszczać politykę.

Komenda M2:

```text
reality_layer.gate.evaluate
```

zapisuje pełny wektor werdyktów w `latestGateJson`, wybranego executora i
przejście stanu. Nie uruchamia sprzętu — dispatch pozostaje zadaniem M3.

## MVP speedrun — M3–M5

Gałąź `reality-layer-mvp-speedrun` domyka minimalny pion demonstracyjny:

- M3: kolejka `reality-layer-execution`, `ExecutionRecord`, normatywny `MockExecutor`;
- M4: append-only `EvidenceEnvelope` i deterministyczny `RealityDiff`;
- M5: jawna decyzja człowieka i merge do `wms.inventory.move` z
  `referenceId = RealityDiff.id` jako granicą idempotencji;
- cienkie endpointy HTTP do sterowania MVP i odczytu całego łańcucha provenance.

Worker ponownie sprawdza Reality Gate bezpośrednio przed pierwszym wykonaniem.
`success` tworzy evidence i diff, ale nie zmienia ERP. `failure` kończy execution
bez bezpiecznego efektu ERP. `unexpected_result` zapisuje rzeczywisty wynik i
ustawia `effectAdapterKey = manual_review`, więc automatyczny merge jest odrzucony.

Pełny runbook: [`REALITY-LAYER-MVP.md`](REALITY-LAYER-MVP.md).

## Po hackathonie

## Lokalna weryfikacja po instalacji

```bash
./mercato/install.sh reality_layer
cd /sciezka/do/open-mercato/apps/mercato
yarn generate
yarn mercato db migrate
yarn mercato auth sync-role-acls
yarn test --testPathPatterns "modules/reality_layer"
```

Po M2 test ścieżki referencyjnej powinien kończyć się na `AUTHORIZED` bez uruchamiania sprzętu. M3 rozszerzy tę samą ścieżkę o kolejkę i `ExecutionRecord`.
