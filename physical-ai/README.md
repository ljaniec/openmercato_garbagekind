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

**Faza 0 — moduł `edge`** (w `mercato/modules/edge`): tożsamość kryptograficzna
agenta na robocie, sesje łączności i uderzenia serca. Cztery tabele, siedem
komend, trzy endpointy agenta, dwa endpointy panelu, strona backendu, cztery
komendy CLI, 48 testów jednostkowych.

Moduł jest celowo ubogi semantycznie i ma taki zostać. Odpowiada na dwa pytania
i żadne inne: **czy ten, kto się odzywa, jest tym, za kogo się podaje** i
**kiedy odezwał się ostatnio**. Jeśli pojawi się tu potrzeba dołożenia pola
`policy_version_id` albo czegokolwiek o treści pracy robota, modelowanie poszło
złą drogą.

Rozstrzygnięcia warte wypisania, bo każde z nich miało kuszącą i gorszą
alternatywę:

| Decyzja | Odrzucona alternatywa | Dlaczego |
| --- | --- | --- |
| Żywotność liczona z `last_seen_at` przy odczycie | kolumna `online boolean` gaszona zadaniem cyklicznym | zadanie, które padnie, zostawia całą flotę na ekranie jako „online" — pulpit kłamie najgłośniej wtedy, kiedy najbardziej trzeba mu wierzyć |
| Heartbeat podpisany kluczem Ed25519 | deklaracja „jestem agentem X" | bez podpisu każdy, kto zna identyfikator, utrzyma martwego robota przy życiu na pulpicie |
| W bazie tylko skrót biletu wpisowego | bilet w jawnej postaci | bilet odczytywalny z tabeli jest kluczem do floty leżącym obok floty |
| Rotacja z oknem zakładkowym | natychmiastowe odwołanie starego klucza | inaczej każda rotacja jest zaplanowanym zerwaniem łączności z całą flotą naraz |
| Licznik kolejny per **sesja** | licznik globalny per agent | agent po restarcie zaczyna od nowa; licznik globalny odrzucałby każdy legalny restart jako powtórkę |
| `sweep` zwraca listę utraconych, nie kwarantannuje | automatyczna kwarantanna | „cisza znaczy: nie wolno pracować" to wniosek dziedzinowy — zapada w `fleet`, nie w kanale |

Rozdział `edge` od `fleet` nie jest estetyczny: robot trwa dziesięć lat, klucz
rotuje się co kwartał, a komputer pokładowy bywa wymieniany bez zmiany maszyny.
Kierunek zależności jest jednostronny — `edge` zna kolumnę `robot_id`, `fleet`
nie wie o agencie. Pulpit floty składa oba źródła po stronie przeglądarki, więc
rejestr działa również tam, gdzie kanału brzegowego nie ma wcale.

Uruchomienie:

```bash
./mercato/install.sh edge
cd /sciezka/do/open-mercato/apps/mercato
yarn generate && yarn mercato db migrate
yarn mercato auth sync-role-acls
yarn mercato edge issue --robot UR10E-0001    # bilet wpisowy, jawny raz
yarn mercato edge simulate --robot UR10E-0001 # agent z prawdziwą parą kluczy
yarn mercato edge status
yarn mercato edge sweep                       # zamyka sesje po progu ciszy
```

Ekran: `/backend/edge`, uprawnienie `edge.view`. Stan łączności pojawia się też
w rejestrze floty na `/backend/fleet`.

`simulate` nie jest atrapą: generuje prawdziwą parę Ed25519, podpisuje
prawdziwe komunikaty i przechodzi tę samą ścieżkę uwierzytelnienia, co agent na
robocie. Symulacja omijająca podpis dowodziłaby wyłącznie tego, że da się
napisać symulację.

### Dowód fazy 0

Warunek zaliczenia brzmiał: *agent rejestruje się, bije heartbeat, a po
odcięciu zasilania robot znika z pulpitu w zdefiniowanym czasie*. Przebieg na
żywej instancji, progi skrócone do sekund, żeby dało się go obejrzeć:

```
Progi     : odstęp 3s, tolerancja 4s, utrata po 25s
  #1 online  termin 04:52:59
  #2 online  termin 04:53:02
po ~0s ciszy: UR10E-0002  enrolled  online   cisza=6s
po ~6s ciszy: UR10E-0002  enrolled  late     cisza=18s
po ~20s ciszy: UR10E-0002 enrolled  lost     cisza=44s
--- sweep:
Zamknięto sesji po ciszy: 1
  utracony: UR10E-0002 — cisza 51s
```

Między drugim a trzecim odczytem nic nie zostało zapisane — cisza po prostu
upłynęła, a stan wynika z odczytu, nie z czyjegoś zapisu. To jest cała różnica
między tym rozwiązaniem a flagą `online` w tabeli.

Druga połowa dowodu to ścieżka sieciowa: klient bez żadnej sesji platformy,
z własną parą Ed25519, przechodzi wpis i uderzenia serca po HTTP, a trzy próby
nadużycia odbijają się na tym samym poziomie:

```
enroll     : 200  {"agentId":"62204b06…","sessionId":"154cb69f…"}
heartbeat #1: 200 online
heartbeat #2: 200 online
powtórka   : 401  Numer kolejny 2 nie jest większy od ostatniego (2) — powtórka lub klon.
obcy klucz : 401  Podpis nie zgadza się z żadnym ważnym kluczem agenta.
bilet 2x   : 401  Bilet wpisowy nieważny lub już zużyty.
```

Endpointy agenta (`/api/edge/enroll`, `/api/edge/connect`, `/api/edge/heartbeat`)
są jedynymi w systemie bez wymogu sesji użytkownika. To świadome odstępstwo
dotyczące **mechanizmu**, nie rygoru: agent na robocie nie jest człowiekiem
i nie ma się jak zalogować, więc uwierzytelnia się podpisem kluczem, którego
centrala nie posiada. Odpowiedź heartbeatu niesie stan łączności i następny
termin — i nic poza tym; stan pożądany oprogramowania jest osobnym kanałem
i sklejenie go tutaj zrobiłoby z żywotności warunek wdrożenia.

---

**Faza 1 — moduł `policy_registry`** (w `mercato/modules/policy_registry`):
wersjonowany rejestr wyuczonych sterowników. Cztery tabele, trzy komendy,
endpoint panelu, strona backendu, trzy komendy CLI, 41 testów jednostkowych.

Moduł odpowiada na dwa pytania i żadne inne: **co to za polityka** i **na czym
wolno ją uruchomić**. Nie ma tu wdrożenia, stanu pożądanego ani wyników
ewaluacji. Gdyby pojawiło się tu pole `robot_id`, modelowanie poszłoby złą
drogą — polityka wiąże się z kontraktem sprzętu, nie z egzemplarzem.

| Decyzja | Odrzucona alternatywa | Dlaczego |
| --- | --- | --- |
| Tożsamością wersji jest skrót kompletu artefaktów | numer nadawany przy każdym wgraniu | dwa wgrania tych samych wag to jedna polityka; dwa rekordy unieważniają każdą statystykę liczoną per wersja, a na tych statystykach stoi brama fazy 4 |
| Powtórka zwraca istniejącą wersję z flagą `deduplicated` | rzucenie wyjątku | wyjątek zmusiłby każdy potok CI do odróżniania „wgrałem to już" od awarii i skończyłby się połknięciem obu |
| `uri` i rozmiar **nie** wchodzą do skrótu treści | skrót po adresie w magazynie | migracja magazynu obiektów rozmnożyłaby całą historię wersji bez zmiany jednego bitu wag |
| Unikat `(tenant, policy, content_digest)` w bazie | deduplikacja wyłącznie w kodzie komendy | dwa równoległe potoki CI wgrałyby ten sam model dwa razy i nikt by tego nie zauważył |
| Odcisk kontraktu **deklarowany** przez wgrywającego | odczytany z rejestru floty przy rejestracji | odczytana wartość porównywałaby się sama ze sobą i kontrola zawsze by przechodziła; rozjazd wychodzi tylko wtedy, gdy obie strony mówią niezależnie |
| Kopia `spec_digest` zapisana przy wersji | wyłącznie klucz obcy do rewizji | „teoretycznie niezmienna rewizja" to za mało dla zapisu, który ma odpowiedzieć regulatorowi po trzech latach |
| Odczyt rewizji surowym SQL-em | import klasy encji z modułu `fleet` | jedna klasa zarejestrowana pod dwiema ścieżkami to gwarantowane „Metadata for entity X not found" |
| `policy_registry.release` osobno od `manage` | jedno uprawnienie na moduł | wgranie wag jest czynnością techniczną, wypuszczenie ich na flotę — decyzją o dopuszczeniu maszyny do ruchu |
| Brak pola „zatwierdzona" na wersji | globalna flaga dopuszczenia | dopuszczenie jest funkcją pary (wersja, klasa celi) i mieszka w `safety`; flaga globalna każe pisać uzasadnienie dla każdej celi z osobna |
| W tabeli adres i skrót artefaktu | bajty wag w kolumnie | warunek trzeci raportu: żaden artefakt binarny nie przechodzi przez MikroORM ani przez szynę komend |

Uruchomienie:

```bash
./mercato/install.sh policy_registry
cd /sciezka/do/open-mercato/apps/mercato
yarn generate && yarn mercato db migrate
yarn mercato auth sync-role-acls
yarn mercato fleet seed                     # rewizje embodimentu muszą istnieć wcześniej
yarn mercato policy_registry seed
yarn mercato policy_registry status
yarn mercato policy_registry prove          # dowód fazy
```

Ekran: `/backend/policies`, uprawnienie `policy_registry.view`.

### Dowód fazy 1

Warunek zaliczenia brzmiał: *próba zarejestrowania wersji dla embodimentu
o innym `spec_digest` odbija się z nazwanym powodem; powtórne wgranie tych
samych wag nie tworzy drugiej wersji.* Przebieg na żywej instancji:

```
DOWÓD FAZY 1 — rejestr polityk

1) ta sama rewizja, ale polityka uczona pod innym odciskiem kontraktu
   odbite: Nie można zarejestrować wersji [spec_digest_mismatch]: odcisk kontraktu
   embodimentu nie zgadza się: rewizja ur10e-pick@r1 ma demo:ur10e-pick:r1,
   a polityka była uczona pod demo:ur10e-pick:r999-inny-kontrakt.

2) rewizja z innej rodziny sprzętu
   odbite: Nie można zarejestrować wersji [embodiment_key_mismatch]: polityka jest
   dla rodziny ur10e-pick, a wskazana rewizja należy do fr3-assembly.

3) powtórne wgranie tych samych wag pod właściwą rewizję
   zwrócono v1 deduplicated=true; wersji przed 2, po 2
```

Komunikat odmowy niesie **obie** wartości odcisku, nie tylko kod błędu — bez
tego operator nie wie, którą stronę poprawić. Trzeci punkt jest ważniejszy, niż
wygląda: licznik wersji nie drgnął, mimo że komenda wykonała się normalnie
i zwróciła identyfikator. To jest różnica między rejestrem a katalogiem plików.

Druga połowa dowodu to ścieżka sieciowa — konto `employee` ma `policy_registry.view`
i `policy_registry.manage`, ale nie `release`:

```
GET /api/policy_registry/policies  →  200
totals: {"policies": 2, "versions": 3, "released": 0, "deprecated": 0,
         "embodimentDrift": 0, "orphanedEmbodiment": 0}
insert-peg-fr3 fr3-assembly [(1, '50da1b1fe566', 'fr3-assembly@r1', 'registered', ['config','weights'])]
pick-bin-ur10e ur10e-pick   [(2, '137069a4929b', 'ur10e-pick@r1', 'registered', ['config','weights']),
                             (1, '3ebdc0069497', 'ur10e-pick@r1', 'registered', ['config','weights'])]
```

`released: 0` po zasiewie jest zamierzone. Zasiew wgrywa wagi; wypuszczenie
ich na flotę jest osobną decyzją pod osobnym uprawnieniem i nie dzieje się
przy imporcie.
