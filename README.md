# jesie.pl

Publiczny serwis: **https://www.jesie.pl**. Domena bez `www` przekierowuje na ten host. Pozostałe adresy wdrożeń nie są kanonicznymi adresami treści.

Treści przepisów w PL i EN są samodzielne: bez linków, cytowań i odwołań do zewnętrznych serwisów. Research i bibliografia pozostają prywatnymi danymi redakcji. Wspólna polityka `src/lib/recipe-content-policy.ts` sprawdza publiczne pola, w tym opisy, kroki, Tips, Storage, SEO, zamienniki i podpisy fotografii; obowiązuje przy generowaniu i naprawie wyniku AI, zapisie, przywracaniu wersji, publikacji oraz odczycie aktywnych publikacji i kopii awaryjnych. Techniczne adresy mediów i własna domena pozostają dozwolone. Regresje polityki sprawdza `npm test`.

Repozytorium: [Bartes74/jesie](https://github.com/Bartes74/jesie) (prywatne). Punkt startowy: `baseline-2026-10-27-collections`. [Przekazanie do Claude Code](docs/claude-code-handoff.md) · [Gotowy prompt pierwszej sesji](docs/claude-code-prompt.md).

Serwis obejmuje katalog PL/en-GB, panel redakcyjny, generowanie, kolekcje, fotograficzne składniki i kroki, porcje Metric/UK Imperial, ulubione, sesje, timery i druk. Ostatnia kontrola produkcji 27.10.2026 potwierdziła 44 opublikowane przepisy i cztery kolekcje; sześć przepisów w kodzie to osobny zestaw startowy developmentu.

## Moja kuchnia i usprawniona redakcja

Sesje gotowania z notatkami, plan trzech posiłków, wspólna lista zakupów i lodówka z priorytetem „zużyj najpierw” działają bez konta, na urządzeniu czytelnika. Panel ma kolejkę uwagi, spójny automat, ręczne korekty, rzeczywistą bibliotekę zdjęć, opinie czytelników i raport kosztów. Konfiguracja, migracja, testy i opcjonalna odnawiana kopia publiczna: [instrukcja wdrożenia](docs/kitchen-experience.md).

## Uruchomienie

Node.js **24.x** zgodnie z `.nvmrc`. Zachowaj istniejące pliki środowiska. Dla świeżego klonu przygotuj osobną bazę deweloperską i `.env.local` z przykładu; przed zapisem potwierdź środowisko bez ujawniania DSN. Szczegółowy bootstrap, aktywacja administratora i ograniczenia klonu są w [instrukcji przekazania](docs/claude-code-handoff.md).

```sh
npm ci
# Wyłącznie potwierdzona, świeża baza development; bez odziedziczonych adresów produkcji.
env -u DATABASE_URL -u POSTGRES_URL -u DATABASE_URL_UNPOOLED npm run db:migrate -- .env.local
env -u DATABASE_URL -u POSTGRES_URL -u DATABASE_URL_UNPOOLED npm run db:seed
npm run dev -- --hostname 127.0.0.1
```

Aplikacja uruchamia się pod `http://127.0.0.1:3000/pl`; panel redakcyjny: `/admin`. Wersja angielska: `/en`. `BETTER_AUTH_URL` musi odpowiadać adresowi serwera. Wymagane są prawdziwy PostgreSQL i `BETTER_AUTH_SECRET`; klucze AI nie są potrzebne do ręcznej redakcji.

```sh
npm run lint
npm test
npm run test:collections
npm run build
npm run typecheck
```

## Zakres i dane

Codzienna praca w panelu: **Dodaj przepis → tytuł i opcjonalne notatki lub pełny przepis → Wygeneruj przepis → Akceptuję treść → Wygeneruj brakujące grafiki → Podgląd → Publikuj**. Opracowanie zawsze korzysta z researchu; źródła pozostają w redakcji. Gotowe zdjęcia składników są ponownie wykorzystywane, a nowe powstają kolejno: składniki, kroki, zdjęcie nagłówkowe. Zmiana receptury wymaga ponownej akceptacji treści; samo dołączenie grafik jej nie unieważnia.

Od 20.10.2026 `/admin/automation` („Codzienne inspiracje”) codziennie wyszukuje propozycję i przygotowuje wyłącznie tekst szkicu PL/EN. Administrator ocenia i akceptuje treść, osobno zleca fotografie i ręcznie publikuje po podglądach. Potwierdzony trend również nie uruchamia zdjęć ani publikacji. Starsze harmonogramy i zegary są historyczne; szczegóły: [runbook inspiracji](docs/trends-runbook.md).

To pierwszy publiczny prototyp, a nie pełne P0 ze specyfikacji. Publiczny serwis pobiera aktywne snapshoty z PostgreSQL. `src/lib/recipes.ts` zawiera sześć demonstracji używanych wyłącznie przy pierwszym, idempotentnym imporcie. Przepisy i grafiki powstały z pomocą AI; przepisy nie są jeszcze przetestowane w kuchni. Tagi dietetyczne są robocze i wymagają weryfikacji. Nie podajemy niezweryfikowanych wartości odżywczych ani ocen.

Ilości bazowe są dziesiętnymi stringami. `src/lib/quantities.ts` wykonuje obliczenia przez decimal.js, stosuje dokładne stałe UK Imperial i renderuje ilości w składnikach oraz tokenach kroków z tego samego źródła. Ustawienia i postęp mają wersjonowane klucze localStorage. Timer zapisuje termin zakończenia; odliczanie po powrocie do karty wynika z aktualnego czasu.

Druk wykorzystuje aktualne porcje i jednostki. Zapis PDF odbywa się przez systemowy dialog drukowania. Konta redaktorów, automatyczny zapis, historia, kontrola publikacji i PostgreSQL działają. Studio AI ma adaptery OpenAI/fal.ai, prywatny Blob, trwałe zadania Workflow i potwierdzone rzeczywiste koszty bez finansowych limitów i rezerwacji. Uruchomienie generacji wymaga skonfigurowania kluczy dostawców. Serwerowy eksport PDF pozostaje kolejnym etapem.

## Grafika i fonty

Grafiki demonstracyjne wygenerowano wbudowanym narzędziem `image_gen`. W aplikacji docelowej rekomendowanym dostawcą grafik jest fal.ai. Historyczne materiały projektowe w lokalnym `artifacts/design/` nie są częścią repozytorium; aktualny wygląd i reguły znajdują się w kodzie oraz dokumentacji przekazania. Gotowe potrawy i biblioteki fotografii: `public/images/`. PNG przekonwertowano do WebP bez zmian kompozycji, z zachowaniem przezroczystości tam, gdzie występuje. Fotografie składników i kroków w demo są zapisane w uporządkowanych atlasach; komponent pokazuje właściwe zdjęcie przez viewport CSS. Nie używa fragmentów screenshotu interfejsu. `recipe-media.ts` wiąże zdjęcia i podpisy z identyfikatorami składników/kroków. Ilości pozostają tekstem HTML i przeliczają się niezależnie od ilustracji. Projekt używa lokalnych fontów Lora i Manrope, dystrybuowanych na licencji SIL Open Font License przez Fontsource. Treści licencji: `src/fonts/licenses/`.

## Wdrożenie

GitHub Actions `Checks` wykonuje lint, testy podstawowe, testy kolekcji, build i typecheck na Ubuntu/Node 24 bez sekretów aplikacji. Push nie wdraża produkcji. Nowy klon nie zawiera prywatnych archiwów odzyskiwania mediów; przed pełnym wydaniem odtwórz je poza Git zgodnie z [instrukcją przekazania](docs/claude-code-handoff.md).

Projekt Vercel: `zgotujsobie`, scope: `bartek-dajerpls-projects`. Produkcyjne publikacje są indeksowane; panel, podglądy i wdrożenia preview pozostają `noindex`. `.vercelignore` wyklucza specyfikację, prywatne obrazy, dokumenty analityczne, sekrety i artefakty z wysyłania do Vercel.

## Panel redakcyjny

Codzienne inspiracje, zatwierdzane zamienniki i lodówka są opisane w [runbooku](docs/trends-runbook.md). Przełącznik w `/admin/automation` dotyczy wyszukiwania i opracowania tekstu; fotografie i publikacja są osobnymi decyzjami redakcji. Dawne harmonogramy i zapas siedmiu zatwierdzonych wersji pozostają historyczne.

SEO obejmuje metadane, JSON-LD Recipe, sitemap, RSS, IndexNow, kolekcje, poradniki, warianty ilustracji i anonimowe agregaty użycia. Procedury publikacji, konfiguracji i monitoringu: [SEO runbook](docs/seo-runbook.md). Daty wynikają z historii publikacji; prywatne notatki i testy kuchenne nie trafiają do czytelników.

Panel działa pod `/admin`: przegląd, lista, dodawanie, edytor PL/EN, fotograficzna biblioteka i ustawienia konta. Publikacja wymaga przeglądu bieżącej wersji i ręcznego kliknięcia „Publikuj”; automatyczne przygotowanie nie zastępuje akceptacji człowieka. Zmiana szkicu nie zmienia publicznego przepisu; konflikt równoczesnej edycji jest pokazany, a historia pozostaje niezmienna. Aktywacja konta właściciela `bartek@dajer.pl` odbywa się jednorazowym prywatnym linkiem, a hasło ustawia właściciel w przeglądarce. Procedura aktywacji i odzyskania: `src/server/auth/README.md`. Architektura oraz zakres: `Backend_redakcyjny.md`.

Bazy produkcji i development/preview są oddzielne, w regionie Frankfurt. Funkcje Vercel są przypisane do `fra1`. Testy integracyjne bazy uruchamia `npm run test:editorial` w tymczasowym schemacie development; nie dotyczą produkcyjnych danych. Sekrety i lokalne pliki aktywacji są wykluczone z deploymentu.

## Kolekcje i wydarzenia

`/admin/collections` zarządza dwujęzycznymi kolekcjami, ich kolejnością przepisów, wyglądem i promocją w hero. Opublikowana kolekcja jest dostępna cały rok. Okres promocji obejmuje pełne dni w strefie `Europe/Warsaw`, z dniem końcowym włącznie; nakładające się promocje są blokowane. Daty ustawia się na każdy sezon.

Opis wyglądu i opcjonalna prywatna inspiracja tworzą wersjonowaną propozycję palety, dedykowanej grafiki wydarzenia i tła. Administrator sprawdza podgląd PL/EN na komputerze i telefonie, akceptuje propozycję do szkicu, a następnie osobno publikuje zmiany. Generowanie korzysta ze skonfigurowanych usług treści i obrazów; niepewne przyjęcie płatnego zlecenia nie wywołuje automatycznej ponownej generacji. Inspiracje i niezaakceptowane propozycje nie są publicznymi mediami.

Czytelnik zaznacza w kolekcji dowolną liczbę potraw, ustawia porcje i przygotowuje wspólną listę zakupów z odhaczaniem, kopiowaniem i drukiem. Zestaw jest zapisywany lokalnie na urządzeniu, wspólnie dla PL/EN, niezależnie od trzydaniowego planu. Odnośniki do zapisanych zestawów znajdują się także na stronie „Plan i zakupy”. Wycofane przepisy są oznaczane jako niedostępne i nie dodają składników do zakupów.

Na nowej bazie uruchom pełny runner migracji; na produkcji migracje 0030/0031 wykonano już 27.10.2026. Migracja `0030-collections` przenosi obecne nazwy, adresy i przypisania, a `0031-collection-themes` dodaje generowanie, media i zdarzenia odkrywania. Migracja zachowuje regułę automatycznego doboru „do 30 minut” oraz próg pięciu przepisów dla dawnych kolekcji; nowe wymagają jednego. Po zmianach publikacji lub osobno zleconym wdrożeniu odśwież publiczną kopię danych w panelu. Przy awarii bazy stare kopie v1 nadal obsługują przepisy; dopiero kopia v2 potwierdza zawartość kolekcji. Testy bez wywołań płatnych usług: `npm run test:collections`.

## Studio AI — przepisy

`/admin/ai` tworzy propozycje treści PL/en-GB oraz fotografie główne, przezroczyste składniki i zbliżenia kroków. Wynik ma osobny adres, przegląd i ręczne zastosowanie do szkicu. Zastosowanie zeruje akceptacje i nigdy samo nie publikuje przepisu. Oryginał, autor i bibliografia pozostają pod kontrolą redakcji.

Nowe zlecenia treści zapisują w prywatnym `ai_job.input.aiPhotography` kontrakt `recipeTimingVersion: dependency-timing-v1`. Wymaga on strukturalnego `timingPlan`, sprawdzanego przed przyjęciem odpowiedzi: pełny czas prowadzi od przygotowania do podania, uwzględnia obowiązkowe oczekiwanie i rzeczywiste zależności prac równoległych. Ten sam kontrakt obejmuje Studio, edytor prowadzony oraz nowe zlecenia trendów. Znacznik jest utrwalany przy przyjęciu zadania; odczyt istniejącej odpowiedzi i jej naprawa zachowują kontrakt rodzica. Starsze i już rozpoczęte zadania bez tego znacznika nie dostają wstecznie obowiązku zwrócenia planu. Harmonogram jest dowodem walidacji wyniku AI, nie nowym obowiązkowym polem ręcznie edytowanego przepisu; nie zastępuje ręcznej akceptacji treści.

Każdy gotowy przepis ma jeden rodzaj `diet`: `meat`, `vegetarian` lub `vegan`, ustalany z podstawowych składników, bez opcjonalnych zamienników. Grupa niewegetariańska obejmuje także ryby, owoce morza, żelatynę i sery na tradycyjnej podpuszczce zwierzęcej. Nowe zadania zapisują kontrakt `recipeDietVersion: ingredient-diet-v1`; niejednoznaczny skład wymaga doprecyzowania przed przyjęciem propozycji. Zapis ręczny przelicza rodzaj, a publikacja sprawdza zgodność oznaczenia ze składnikami. Sam wyliczony indeks nie zmienia skrótu akceptacji kulinarnej; rzeczywista zmiana składników lub ich wymagań nadal wymaga ponownego przeglądu.

Filtr `diet` jest niezależny od kategorii posiłku, czasu, trudności i wyszukiwania. Codzienny dobór dąży do około 50% dań niewegetariańskich, 25% wegetariańskich i 25% wegańskich. Liczy aktualne publikacje, a w krótkim oknie również gotowe, zachowane szkice; korekty starego przepisu nie stają się nową publikacją. Brak właściwej propozycji nie powoduje dodatkowego płatnego wyszukiwania ani fałszowania kategorii. Operator `scripts/assign-recipe-diets.ts` wymaga dokładnego planu i kopii zapasowej, zachowując historyczne publikacje oraz istniejące potwierdzenia przeglądu.

Rekomendowany profil to `gpt-6-astra` dla treści i `openai/gpt-image-2.5/sunburst/text-to-image` przez fal.ai dla fotografii. Składniki i kroki korzystają z głównej fotografii jako referencji stylu, gdy jest dostępna. Źródła i szczegóły: `Backend_AI.md`.

Płatny POST jest wysyłany jeden raz. Niepewne przyjęcie blokuje automatyczne ponowienie. Zadania przepisów i kolekcji współdzielą limit dwóch aktywnych generowań. Aplikacja raportuje rzeczywiste koszty; nie stosuje finansowych rezerwacji ani limitów wydatków. Brak potwierdzonego rachunku fal.ai pozostawia koszt oznaczony jako oczekujący na potwierdzenie. `npm run test:ai` sprawdza trwałość w izolowanym PostgreSQL; `npm run test:providers` weryfikuje adaptery bez płatnych wywołań.

Zdjęcia składników są współdzielone między przepisami według produktu, jego postaci i profilu fotografii. Pasujące fotografie demonstracyjne oraz zweryfikowane zdjęcia z prywatnego Blob są wykorzystywane bez kosztu generowania. Jednoczesne zlecenia tego samego produktu korzystają z jednego producenta; pozostałe czekają na jego wynik. Niepewny wynik lub niedostępne wcześniejsze zdjęcie nie uruchamia nowego płatnego zlecenia. Pakiet fotografii trendów rezerwuje budżet tylko na brakujące unikalne produkty. Migracja `0006-ingredient-reuse` dodaje trwały katalog i blokadę duplikatów.
