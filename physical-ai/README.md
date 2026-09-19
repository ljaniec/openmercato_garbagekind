# Physical AI — wdrażanie robotów uczonych RL

Ten katalog jest miejscem na nowy kierunek: platformę operacyjną dla flot
robotów, których polityki sterowania uczone są metodami RL (oraz IL, offline
RL i modelami VLA).

Pełny raport rozpoznawczy — literatura, dekompozycja produktu i ocena
Open Mercato jako fundamentu — powstał jako dokument:

**https://claude.ai/code/artifact/b4a907ca-74b7-4740-91f0-87a162172da7**

## Teza organizująca

Platforma nie steruje robotem i nie uczy polityki. Jej praca to wiązanie
wersji polityki z populacją robotów pod zatwierdzonym uzasadnieniem
bezpieczeństwa i prowadzenie audytowalnego zapisu tego, co gdzie działało,
co zrobiło i kto interweniował.

## Trzy warunki, pod którymi Open Mercato jest właściwym fundamentem

1. Moduły `catalog` / `sales` / `wms` / `checkout` / `warranty_claims`
   zostają wyłączone i nigdy nie stają się zależnością modułu robotycznego.
2. Kotwicą modelu robota jest `resources` (zależy tylko od `planner`),
   nie `catalog`.
3. Granica control plane / data plane zapisana w ADR w tygodniu pierwszym
   i egzekwowana w code review: żaden przepływ telemetrii, żaden artefakt
   binarny i żaden strumień teleoperacji nie przechodzi przez szynę komend
   ani przez MikroORM.

Upadek któregokolwiek warunku odwraca rekomendację.

## Konsekwencja regulacyjna, która wyprzedza wszystkie architektoniczne

Uczona polityka nie może być funkcją bezpieczeństwa. Umieszczenie jej
w łańcuchu bezpieczeństwa wpycha produkt klienta w Annex I część A
rozporządzenia (UE) 2023/1230 (stosowanego od 20 stycznia 2027), czyli
w obowiązkową ocenę przez jednostkę notyfikowaną — dla której nie istnieje
ustalona metoda wykazania zgodności.

Bezpieczeństwo egzekwuje osobna, deterministyczna, certyfikowalna warstwa.
Platforma ma to wymuszać i dokumentować.

## Rozstrzygnięcia przed fazą 0

| Pytanie | Decyzja | Konsekwencja w kodzie |
| --- | --- | --- |
| Struktura własności | właściciel + integrator | `owner_organization_id` i `operator_organization_id` rozdzielone w `fleet_robots` od pierwszej migracji |
| Klasa robotów | manipulatory stacjonarne | epizod jest naturalnym atomem; ryzyko R1 nie dotyczy tego wdrożenia |
| Opóźnienie halt-to-stop | sekundy, cele ogrodzone | halt może iść z centrali przez bramy; `risk_class = fenced` daje dzierżawę w dniach |

## Stan implementacji

**Faza 0 — moduł `fleet`** (w `mercato/modules/fleet`): rejestr robotów, klas
sprzętowych, obiektów, cel i kalibracji. Sześć tabel, trzy komendy, strona
backendu, dwie komendy CLI, 47 testów jednostkowych.

Uruchomienie:

```bash
./mercato/install.sh fleet
cd /sciezka/do/open-mercato/apps/mercato
yarn generate && yarn mercato db migrate
yarn mercato auth sync-role-acls   # nadaje uprawnienia fleet.* rolom
yarn mercato fleet seed            # flota demonstracyjna
yarn mercato fleet status          # rejestr kontra hala
```

Ekran: `/backend/fleet`, uprawnienie `fleet.view`.
