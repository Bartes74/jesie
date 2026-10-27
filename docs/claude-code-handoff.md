# Przejęcie jesie.pl w Claude Code

Stan przekazania: 27.10.2026. Prywatne repozytorium: [Bartes74/jesie](https://github.com/Bartes74/jesie), gałąź main, tag startowy `baseline-2026-10-27-collections`. Katalog właściciela: /Volumes/Projekty/zgotujsobie. Instrukcje: [CLAUDE.md](../CLAUDE.md); [gotowy prompt](claude-code-prompt.md).

## 1. Architektura i zasady

Działający serwis [jesie.pl](https://www.jesie.pl/pl), PL/en-GB, z redakcją wymagającą logowania. Czytelnik korzysta bez konta; ulubione, porcje, notatki, sesje, plan i zestawy kolekcji zapisują się na urządzeniu. Dane publiczne pochodzą z aktywnych publikacji PostgreSQL. Sześć przepisów w kodzie służy importowi demonstracji do świeżej bazy.

| Obszar | Źródła i granice |
| --- | --- |
| Strony i wygląd | src/app, src/components; lokalne Lora/Manrope i licencje w src/fonts |
| Reguły czytelnika | src/lib: decimal.js, ilości, zakupy, plan 3 dań i localStorage; zestawy kolekcji są niezależne |
| Redakcja i dostęp | src/server/editorial, auth, http; szkic, akceptacja, immutable publication i expectedRevision |
| Generowanie | src/server/ai, trends, src/workflows; OpenAI/fal.ai, trwałe identyfikatory zleceń i rachunki |
| Kolekcje | src/lib/collections.ts, src/server/collections, /admin/collections; PL/EN, oprawy, publikacja i promocja |
| Odczyt i SEO | src/server/public, seo; baza jest nadrzędna, kontrolowane snapshoty i outbox |
| Media i kopie | src/server/media*: prywatny Blob, referencje publikacji, szyfrowane kopie i dowody odtworzenia |
| Operacje | migrations, scripts; skróty migracji i wersjonowany pakiet schematu backupu |

Kod i aktualny runbook są nadrzędne wobec dawnych dokumentów koncepcyjnych w głównym katalogu. Codzienna inspiracja tworzy tekst szkicu; człowiek ocenia, osobno zleca fotografie i publikuje. Nie ma finansowych limitów/rezerwacji. Konfigurację dostawców zmieniaj tylko w zakresie zadania.

## 2. Zweryfikowany punkt produkcyjny

Wdrożenie `dpl_3hiicyJATj5qNYHrctBUgDnJWuBL` zbudowano na Node 24.x, uzyskało READY i promowano na www.jesie.pl 27.10.2026. To dowód konkretnego wydania, nie obietnica, że pozostanie najnowszym.

- Migracje 0030-collections i 0031-collection-themes zastosowano transakcyjnie po spójnej kopii bazy. Potwierdzono skróty, członkostwo, historię i zabezpieczenia tabel.
- Ostatni odczyt: 44 opublikowane przepisy i cztery kolekcje. Liczby są historyczne i mogą się zmieniać w redakcji.
- Snapshot v2 odnowiono 27.10.2026 o 23:00:34 czasu Warszawy: 44 przepisy, cztery definicje, zgodny SHA-256, 24h ważności i stabilny head. Nie przedłużaj tej daty ręcznie.
- quick-dinners, one-pot, pantry, seasonal zachowały adresy. Liczby dań 3/4/2/4 były poniżej starego progu odkrywania 5, więc publiczny indeks był pusty; panel i istniejące adresy działały.
- Sprawdzono PL/EN, nawigację, hero, panel właściciela, edytor, historię oprawy, prywatne podglądy i formularz nowej kolekcji bez zapisu testowych treści.
- Przeglądarka: cztery dania, porcje, 29 pozycji zakupów, odhaczanie, kopiowanie, wyszukiwanie, filtry, PL/EN i kontekst przepisu. Plan pozostał 0/3. Szerokości 320–1440 px bez przepełnienia i błędów JS.
- Sprawdzono ochronę API/mediów, canonical/hreflang i brak 5xx podczas kontroli. Płatnego generowania oprawy nie uruchamiano na produkcji. Mocki nie dowodzą jakości rzeczywistych grafik.

## 3. Start na obecnym komputerze

Claude Code jest zainstalowany. Nie nadpisuj istniejących konfiguracji, bazy i prywatnych archiwów. Wersja Node: 24.x, wskazana w .nvmrc. Jeżeli używasz nvm, wykonaj nvm install i nvm use.

```sh
cd /Volumes/Projekty/zgotujsobie
git status --short --branch
git switch -c claude/przejecie-i-audyt
claude
```

Jeśli gałąź istnieje, przejdź do niej zamiast ją odtwarzać. Wklej [prompt audytu](claude-code-prompt.md). Claude odczytuje CLAUDE.md importujący AGENTS.md. Logowanie do Claude jest odrębne od kluczy aplikacji. Dokumentacja Anthropic: [start](https://code.claude.com/docs/en/quickstart), [instrukcje projektu](https://code.claude.com/docs/en/memory).

Pierwszy audyt kończy się wynikami, dowodami, brakami konfiguracji, trzema priorytetami i planem pierwszego zadania. Nie wdraża nowej funkcjonalności.

## 4. Świeży klon i własny development

Wymagania: Git, dostęp do repozytorium, Node 24.x/npm i osobny PostgreSQL. Podstawowe CI nie potrzebuje bazy; strony z danymi i panel jej wymagają.

```sh
gh repo clone Bartes74/jesie
cd jesie
# Dla nvm: nvm install && nvm use
npm ci
cp .env.example .env.local
```

Kopiowanie dotyczy nowego klonu bez .env.local. Skonfiguruj osobną bazę development: DATABASE_URL, opcjonalne połączenie bez poolera, nowy BETTER_AUTH_SECRET (minimum 32 losowe znaki) i BETTER_AUTH_URL=http://127.0.0.1:3000. Wartości wprowadź prywatnie, bez commitowania lub wypisywania w raportach.

Przed zapisem potwierdź host, nazwę bazy i środowisko. Nie używaj produkcyjnego DSN. Starsze skrypty dotenv respektują zmienne powłoki; usuń odziedziczone adresy przed odczytem .env.local.

```sh
env -u DATABASE_URL -u POSTGRES_URL -u DATABASE_URL_UNPOOLED npm run db:migrate -- .env.local
# Seed tylko do świeżej bazy demo, nie istniejącej redakcji.
env -u DATABASE_URL -u POSTGRES_URL -u DATABASE_URL_UNPOOLED npm run db:seed
env -u DATABASE_URL -u POSTGRES_URL -u DATABASE_URL_UNPOOLED node --import tsx scripts/issue-owner-activation.ts .env.local http://127.0.0.1:3000
npm run dev -- --hostname 127.0.0.1
```

Skrypt zapisuje jednorazowy link w ignorowanym lokalnym pliku o ograniczonych uprawnieniach. Otwórz go prywatnie i sam ustaw hasło w przeglądarce. Publiczna rejestracja jest wyłączona. Tożsamość właściciela ma adres z istniejącego skryptu, bez wysyłania poczty. create-admin-test.ts nie jest bootstrapem świeżego klonu.

Adresy: http://127.0.0.1:3000/pl, /en, /admin. Bazowy development działa bez AI/Blob. Pozostaw wyłączone snapshot, backupy, indeksację i automat; nie uruchamiaj crona dla obejrzenia demo. Sześć demonstracji ma publiczne assety. Pełne testy generowania wymagają dodatkowej konfiguracji i konkretnego zlecenia na koszty.

## 5. Testy i CI

GitHub Actions Checks: Ubuntu/Node 24, push main, pull request i ręczne uruchomienie; lockfile, bez sekretów aplikacji, produkcyjnej bazy i wdrażania.

```sh
npm run lint
npm test
npm run test:collections
npm run build
npm run typecheck
```

Build tworzy typy tras potrzebne typecheck na czystym checkout. Na wolnym dysku można użyć npm run build -- --webpack; nazwij alternatywny bundler w raporcie.

test:collections:integration i test:backup-schema wymagają lokalnych narzędzi PostgreSQL 18 i tworzą własne tymczasowe klastry; MEDIA_BACKUP_TEST_PG_BIN wskazuje binaria. Starsze integracje mogą wymagać bazy development i ścieżek Homebrew — sprawdź konkretny test przed uruchomieniem. CI nie deklaruje zaliczenia tych integracji, rzeczywistych dostawców, gotowania ani badań z domownikami.

## 6. Pliki poza Git i wydania

Repo nie jest kopią bazy ani Blob. Wykluczono sekrety, konfigurację Vercel, prywatne archiwa, wyniki, logi i zrzuty. Dwa dołączone JSON-y private-data/public-recovery zawierają przypięty anonimowy capture wymagany przez obecne importy/testy. Historyczny capture wygasł w październiku 2026 i nie zastępuje odnawianego snapshotu v2.

Przed commitem można uruchomić `gitleaks git --pre-commit --staged --redact --no-banner`. `.gitleaksignore` zawiera wyłącznie sprawdzone, dokładne fingerprinty syntetycznych fixture'ów i publicznej etykiety konta Keychain, nie wyklucza całych katalogów testów. Nowe znaleziska wymagają przeglądu; raportów ze źródłowymi sekretami nie zapisuj w repo.

Brak private-media/provider-recovery, published-recovery i quota-public-recovery jest dopuszczalny w bazowym development. Pełna inwentaryzacja backupu wymaga prawdziwych katalogów i manifestów. Przed identycznym wdrożeniem z nowego klonu odtwórz prywatne artefakty z kontrolowanej kopii poza Git i zweryfikuj kompletność. Nie zastępuj ich pustymi manifestami.

Push uruchamia kontrole, a produkcja jest wdrażana ręcznie. Projekt Vercel: zgotujsobie w bartek-dajerpls-projects; konfiguracja połączenia jest lokalna. Samo przejęcie nie zleca wdrożeń, migracji, publikacji ani płatnego AI. Przy osobnym zleceniu wydania: potwierdź cel, wykonaj backup i potrzebne nowe migracje, zbuduj produkcję bez przełączenia domeny, sprawdź, promuj tę samą wersję, odśwież snapshot i zweryfikuj drogę użytkownika.

## 7. Dalsza praca po audycie

1. Napraw potwierdzone usterki wpływające na dane, publikacje i drogę użytkownika; każda potrzebuje dowodu i kryterium akceptacji.
2. Popraw powtarzalność bootstrapu i przenośność integracji PostgreSQL 18 na Linux, zachowując izolację baz.
3. Dodaj testy przeglądarkowe kolekcji PL/EN: ponad trzy dania, porcje, zakupy, trwałość i kontekst przepisu. Rzeczywiste generowanie oprawy jest osobnym kontrolowanym testem z kosztami i prywatną kolekcją.

Każde zadanie: osobna gałąź, spójny zakres, adekwatne testy, wynik i ograniczenia, commit i PR do main. Aktualizuj dowody po wykonanych kontrolach, nie przedstawiaj planów jako ukończonych.
