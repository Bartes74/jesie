> Materiał historyczny z wcześniejszych etapów projektu. Aktualny stan, konfigurację i granice publikacji opisują [przekazanie](docs/claude-code-handoff.md), kod i bieżące runbooki; nie traktuj dawnych planów jako aktywnego zachowania.

# Backend redakcyjny jesie.pl

Pierwszy działający etap redakcji używa prawdziwego PostgreSQL w Neon, Drizzle oraz Better Auth. Publiczny układ aplikacji pozostaje bez zmian; źródłem treści stają się aktywne, niezmienne publikacje w bazie. Projekt produkcyjny i osobny projekt development/preview znajdują się we Frankfurcie. Konta administratorów nie mają publicznej rejestracji.

Panel jest wdrożony pod `https://zgotujsobie.vercel.app/admin`. Funkcje Vercel korzystają z regionu `fra1`. Docelowa nazwa i domena to jesie.pl; DNS nie jest jeszcze podłączony.

## Konto właściciela

Pierwsze konto jest przypisane do `bartek@dajer.pl`. Właściciel ustawia własne hasło przez jednorazowy link aktywacyjny ważny przez 24 godziny. Lokalny plik z linkiem ma uprawnienia `0600` i jest wykluczony z deploymentu. Baza przechowuje hash tokenu. Nie wysłano wiadomości e-mail ani nie ustalono hasła w konfiguracji.

Sesje i limity prób logowania są trwałe. Zmiana hasła unieważnia pozostałe sesje. Odzyskanie konta wymaga jawnego działania operatora i osobnego linku ważnego godzinę; operacja unieważnia wszystkie sesje i nie odblokowuje zablokowanego konta. Procedury oraz komendy znajdują się w `src/server/auth/README.md`. MFA i automatyczne wiadomości resetujące nie są jeszcze wdrożone.

## Zapis i publikacja

`editorial_recipe` przechowuje bieżący szkic, numer rewizji, sześć akceptacji oraz wskaźnik opublikowanej wersji. Szkic dopuszcza puste pola, także składniki i kroki w trakcie pisania. Walidacja wielkości i typów jest obowiązkowa przy każdym zapisie; kompletność treści jest osobną bramką publikacji.

Każda zmiana treści lub workflow otrzymuje nową rewizję. Klient przekazuje `expectedRevision`; transakcja blokuje wiersz i sprawdza rewizję. Drugi równoczesny zapis otrzymuje `409 REVISION_CONFLICT` wraz z aktualnym szkicem. Brak połączenia z bazą nie przełącza redakcji na mock, plik JSON ani pamięć procesu.

Zmiana treści zeruje akceptacje. Zatwierdzenie wymaga aktualnych akceptacji PL, EN, ilości, metody, fotografii i pochodzenia. Publikacja jeszcze raz sprawdza rewizję i bramki, zapisuje cały snapshot i przełącza publiczny wskaźnik w jednej transakcji. Zapis późniejszego szkicu pozostawia dotychczasową publikację dostępną.

`editorial_version`, `editorial_publication` i `editorial_audit` są chronione triggerami PostgreSQL przed aktualizacją i usuwaniem. Przywrócenie historii tworzy nowy, niezatwierdzony szkic. Duplikacja tworzy nowe ID bez akceptacji, publicznego adresu i publikacji. Archiwizacja wycofuje publiczny dostęp; można przywrócić historyczną treść do szkicu.

Adresy PL i EN pozostają przypisane do jednego stałego ID, również po zmianie lub wycofaniu przepisu. Kolizja adresu wycofuje całą transakcję publikacji. Publiczne odczyty zwracają jedynie aktywny snapshot oraz zatwierdzone mapy zdjęć. Nie zawierają oryginału wklejonego tekstu ani historii redakcyjnej. Pusta lista lub wycofanie publikacji nie przywracają statycznych demonstracji.

## Uprawnienia i bramki jakości

Każda chroniona strona i endpoint sprawdza sesję na serwerze. Funkcje modyfikujące dodatkowo odczytują aktualną rolę i blokadę konta w transakcji. Rola i nazwisko przekazane przez klienta nie nadają uprawnień; zapis operacji używa tożsamości z bazy.

Bramki kontrolują m.in. kompletność PL/EN, porcje, dodatnie ilości i zakresy, jednostki, kategorie, czasy, unikalne ID, istniejące odwołania do ilości i ich zgodność językową. Fotografia główna, każdy składnik i każdy krok muszą odwoływać się do istniejącej lokalnej biblioteki. Sprawdzane są siatki atlasów, opisy alternatywne w obu językach i wskazówki przy krokach. Dowolny URL lub nieistniejąca ścieżka nie spełniają bramki. Oznaczenie „sprawdzony w kuchni” jest blokowane do czasu wdrożenia zapisu daty i opisu rzeczywistego testu.

Sześć wcześniejszych przepisów demonstracyjnych zaimportowano jako `legacy_demo_import`. Zachowują pochodzenie AI i brak sprawdzenia w kuchni. Import nie tworzy fikcyjnych ręcznych akceptacji. Skrypt jest idempotentny: nie nadpisuje istniejących szkiców i nie wskrzesza wycofanych demonstracji.

## Migracje, import i testy

Sekrety są w ignorowanych plikach środowiska i Vercel; poniższe komendy nie wypisują connection strings ani kluczy.

```sh
npx tsx scripts/migrate-auth.ts .env.local
npx tsx scripts/migrate-editorial.ts .env.local
NODE_OPTIONS='--conditions=react-server' npx tsx scripts/seed-editorial.ts .env.local
NODE_OPTIONS='--conditions=react-server' npx tsx --test src/server/editorial/store.integration.test.ts
```

Dla produkcji migratorowi i importerowi przekazuje się `.env.production.local`. Migracja redakcyjna ma dziennik i sumę kontrolną; już wykonanej migracji nie należy edytować. Kolejne zmiany wymagają nowej migracji.

Testy korzystają z rzeczywistego deweloperskiego PostgreSQL i bezpośredniego endpointu (`DATABASE_URL_UNPOOLED` lub `EDITORIAL_TEST_DATABASE_URL`). Tworzą izolowany schemat, a po zakończeniu usuwają wyłącznie ten schemat. Przetestowano trwałość po zmianie połączenia, konflikt równoczesnych zapisów, aktualne uprawnienia, bramki i rewizje akceptacji, separację szkicu od publikacji, wycofanie, niezmienność historii w samej bazie, atomowy rollback przy kolizji adresu, restore i duplicate. Wszystkie 10 testów przeszło.

## Zakres następnych etapów

Redakcja i trwałe publikacje są uzupełnione przez Studio AI: adaptery OpenAI/fal.ai, prywatny Blob, trwałe zadania Workflow i rezerwacje kosztów. Szczegóły i stan konfiguracji opisuje `Backend_AI.md`. Płatnych generacji jeszcze nie wykonano. Serwerowy eksport PDF pozostaje kolejnym etapem.

Operacje publiczne zapisują zdarzenie w trwałym `editorial_outbox`. Worker przetwarzający ten outbox nie jest jeszcze wdrożony. Publiczne strony pobierają bieżący snapshot przy żądaniu, więc wycofanie nie czeka na taki worker. Dodanie buforowania będzie wymagało wykonawcy unieważniania cache.

Pełne P0 wymaga także kolejnych funkcji redakcyjnych, pracy na słownikach, zarządzania zasobami, eksportu i odtworzenia kopii. Ten etap nie potwierdza wykonania próby odtworzenia backupu ani kompletnej funkcjonalności AI z pierwotnej specyfikacji.
