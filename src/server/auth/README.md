# Logowanie redakcji jesie.pl

Publiczna rejestracja jest wyłączona. Sesje oraz limity logowania są zapisane w PostgreSQL. Każda operacja redakcji sprawdza aktualne uprawnienia i blokadę konta w bazie, a zmiana hasła unieważnia pozostałe sesje. Better Auth haszuje hasła za pomocą scrypt. Rejestr `auth_event` przechowuje działanie, wynik, identyfikator konta jeżeli dostępny oraz czas; nie zapisuje haseł, tokenów, treści formularza, adresów e-mail ani adresów IP.

## Pierwsze konto

1. Zastosuj migrację: `npx tsx scripts/migrate-auth.ts .env.production.local`.
2. Wydaj link: `npx tsx scripts/issue-owner-activation.ts .env.production.local https://www.jesie.pl`.
3. Otwórz lokalny, ignorowany plik `.env.owner-activation-link` i przekaż dostęp wyłącznie właścicielowi. Hasła nie wpisujemy do rozmowy ani konfiguracji.
4. Właściciel otwiera link i ustawia hasło w formularzu. Link wygasa po 24 godzinach i może zostać użyty tylko raz. Adres właściciela to `bartek@dajer.pl`.
5. Usuń lokalny plik z linkiem po użyciu. Sam token trafia do fragmentu URL, którego przeglądarka nie wysyła w żądaniu strony; baza przechowuje jego hash.

Nowe wydanie linku zastępuje poprzedni token. Komenda odmawia aktywacji, gdy konto właściciela już istnieje.

## Odzyskanie konta właściciela bez wiadomości e-mail

Ta procedura wymaga jawnego zlecenia odzyskania konta i dostępu operatora do sekretów produkcyjnych. Nie uruchamia się automatycznie przy błędzie logowania.

1. Operator uruchamia `npx tsx scripts/issue-owner-activation.ts .env.production.local https://www.jesie.pl --recover`.
2. Link znajduje się w pliku `.env.owner-recovery-link` z uprawnieniami `0600`; komenda nie wypisuje go do logów. Obowiązuje przez jedną godzinę. Każde ponowienie zastępuje poprzedni link.
3. Właściciel ustawia nowe hasło pod tym linkiem. Operacja zużywa token i unieważnia wszystkie istniejące sesje w jednej transakcji.
4. Operator usuwa lokalny plik po użyciu. Zablokowane konto wymaga osobnej, świadomej decyzji operatora; odzyskanie hasła nie usuwa blokady.

Produkcyjny panel działa pod `https://www.jesie.pl/admin`; `jesie.pl` przekierowuje na `www.jesie.pl`. Produkcyjne `BETTER_AUTH_URL` oraz adres przekazywany komendzie muszą wskazywać `https://www.jesie.pl`. Zmiana zmiennej na Vercelu wymaga ponownego wdrożenia. Automatyczny reset przez Resend będzie włączony po konfiguracji zweryfikowanego nadawcy; obecna implementacja nie wysyła wiadomości.
