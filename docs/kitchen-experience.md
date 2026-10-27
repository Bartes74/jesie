# Moja kuchnia, zakupy i praca redakcji

## Uruchomienie

`npm run db:migrate` stosuje migracje do wskazanej bazy developerskiej (`.env.local`). Migracja `0024-kitchen-experience` rozszerza anonimowe liczniki i dodaje dobrowolne opinie czytelników; `0025-plan-metrics` dopuszcza anonimowe liczniki nowej strony planu. Przed wdrożeniem aplikacji na produkcję zastosuj te same migracje do właściwej bazy produkcyjnej w standardowym procesie wdrożenia. Nie wystawiaj formularza opinii przed migracją. Dotychczasowe liczniki i treści pozostają zachowane. Runner `scripts/migrate-plan-metrics.ts` korzysta z bezpośredniego połączenia z wybranego pliku środowiska; `--verify-only` sprawdza rejestr i ograniczenia w transakcji tylko do odczytu. Wraz z migracją 0025 zaktualizowano i sprawdzono lokalnie pakiet schematu używany do odtwarzania kopii bazy.

Podgląd: `npm run dev -- --hostname 127.0.0.1`. Gdy Turbopack ma problemy z wolnym dyskiem zewnętrznym: `npm run dev -- --hostname 127.0.0.1 --webpack`.

## Dane czytelnika

Ulubione i preferowane porcje zachowują dotychczasowe klucze. `jesie:kitchen-memory:v1` przechowuje sesje, ostatnio oglądane przepisy i prywatne notatki. Sesja odnosi się do publikacji i zawartości instrukcji. Zmiana kroków lub składników nie przenosi starego postępu na nowy przepis. Stare checklisty i minutniki są odczytywane raz, bez usuwania ich oryginałów.

Lodówka nadal korzysta z `jesie:pantry:v1`; osobny przełącznik zapisuje stosowanie dopasowania. Priorytet „zużyj najpierw” obejmuje do trzech produktów. Plan i zakupy zapisują się w wersjonowanych kluczach lokalnych. Obecność produktu nie oznacza potwierdzonej ilości. Zamienniki są wybierane świadomie; ilości nie są dziedziczone po oryginale bez podstawy. Sumowane są tylko zgodne produkty i jednostki; gramy nie są przeliczane na mililitry.

Plan ma własny adres `/pl/plan` i `/en/plan`. Nawigacja pokazuje liczbę wybranych dań, a strona zaczyna się od zapisanych posiłków i wspólnych zakupów. Poniżej znajduje się katalog z instrukcją wyboru i powrotem do planu, który zachowuje aktywne filtry. Pierwsze danie można dodać z karty lub z panelu przy tytule przepisu. Panel pozwala wcześniej ustawić porcje; szczegóły składników i zakupy korzystają z tego samego wyboru zamienników. Katalog i rekomendacje tylko dodają brakujący przepis — nie nadpisują porcji, zamienników ani odhaczonych zakupów istniejącego dania. Zmiana zapisanego dania wymaga jawnego „Zaktualizuj w planie”. Dotychczasowy klucz `jesie:meal-plan:v1` i starsze odnośniki do `#meal-plan` pozostają obsługiwane. Strona prywatnego planu ma `noindex` i nie trafia do sitemap; dane nadal pozostają wyłącznie w tej przeglądarce.

Notatki i sesje nie są wysyłane do serwera. Formularz opinii wysyła wyłącznie osobno wpisaną wiadomość, rodzaj opinii, przepis, rewizję publikacji, ewentualny krok i losowy klucz pojedynczego zgłoszenia. Nie dołącza cookie, Referer ani identyfikatora sesji gotowania. Baza deduplikuje ponowienia, wiąże krok z konkretną opublikowaną rewizją i ogranicza liczbę zgłoszeń na przepis. Redakcja przegląda i zamyka opinie z pulpitu.

## Publikacja i biblioteka

Od 20.10.2026 radar codziennie wyszukuje propozycję i opracowuje wyłącznie tekst szkicu PL/EN. Panel `/admin/automation` nosi nazwę „Codzienne inspiracje” i pokazuje następne wyszukiwanie, ostatni przebieg oraz szkice do oceny. Każdy szkic wymaga ręcznego sprawdzenia. Administrator akceptuje bieżącą treść, osobno decyduje o fotografiach i na końcu ręcznie publikuje gotowy przepis. Potwierdzony trend również nie uruchamia zdjęć ani publikacji. Włączenie codziennego wyszukiwania nie jest zgodą na te działania. Szczegóły i granice starszych workerów opisuje `docs/trends-runbook.md`.

Końcowa akcja `publish` w `/api/admin/recipes/[id]/preparation` wymaga sześciu jawnych `checks: true`. Podstawowy edytor uzyskuje je z pojedynczego potwierdzenia człowieka, dostępnego po wczytaniu obu podglądów bieżącej rewizji. Zmiana rewizji unieważnia lokalne potwierdzenie. Akceptacja tekstu nadal poprzedza przygotowanie grafik.

Od poprawki z 19.10 podgląd osadzony i pełny podgląd w nowej karcie zgłaszają gotowość tego samego zakresu przepisu, rewizji i losowej sesji przeglądu. Panel rozróżnia stan PL/EN i zachowuje wczytane języki po odświeżeniu bieżącej karty dla tej samej rewizji. Komunikat gotowości nie zaznacza potwierdzenia człowieka i nie publikuje. Pełny podgląd zachowuje `noopener`; zaliczenie wymaga rzeczywistego wyrenderowania poprawnego, zalogowanego podglądu. Otwarta karta starszej rewizji nie odblokowuje nowej. Raport poprawki: `output/publication-preview-fix-2026-10-19/README.md`.

Biblioteka korzysta z zapisanych mediów i katalogu startowego. Zgodność składnika obejmuje produkt, postać i profil zdjęcia; fotografie potrawy i kroku wymagają także zgodnej treści. Podmiana zapisuje szkic z `expectedRevision`, nie generuje nowego zlecenia i nie publikuje. Niepewny zapis wymaga odświeżenia przed kolejną próbą. Historia i publiczne referencje mediów pozostają zachowane.

Raport kosztów pokazuje potwierdzone rozliczenia oraz liczbę zleceń oczekujących na rachunek. Poprawki to kolejne płatne zlecenia tego samego fragmentu, nie czas ręcznej pracy. Zdarzenia analityczne to agregaty; nie są liczbą użytkowników ani retencją D7/D30. Starsze liczniki zaznaczania kroków i składników zawierają także cofnięcia; nowe cofnięcia mają oddzielne zdarzenia. `cooking_start` i `repeat_cook` są rozłącznymi rodzajami rozpoczęcia sesji: sumuj je dla wszystkich startów. „Ponowne” oznacza ponowienie rozpoznane w lokalnej historii przepisu; wyczyszczenie przeglądarki przerywa tę ciągłość.

## Odnawiana kopia publiczna

Kopia jest opcjonalna. Włącz `PUBLIC_RECIPE_SNAPSHOT_ENABLED=true` dopiero po wdrożeniu wszystkich ścieżek zapisu z nowym mechanizmem unieważniania i zakończeniu lub wznowieniu starych workerów publikacji na nowej wersji. Wymaga prywatnego Blob i `DATABASE_URL`. Tokeny nie trafiają do klienta.

Cron `/api/cron/public-snapshot` odnawia katalog co godzinę. Po zmianie publikacji odnowienie wykonuje też trwały outbox SEO. Ręczne odnowienie i stan są dostępne w ustawieniach admina. Odczyt bazy pozostaje nadrzędny; fallback działa tylko dla rozpoznanej niedostępności/limitu bazy. Format v2 obejmuje przepisy i opublikowane definicje kolekcji; stara kopia v1 nie potwierdza zawartości kolekcji. Dwa ograniczone sloty są oddzielone dla każdej bazy. Kopia wygasa po 24h, jest walidowana i odczytywana z origin Blob, z kontrolą SHA oraz ponownym odczytem head po pobraniu treści.

Wycofanie, kosz i każda publikacja unieważniają head w transakcji przed zmianą aktywnej publikacji. Warunkowe zapisy Blob (`ifMatch`/create-only) zapobiegają odtworzeniu starego head przez opóźniony zapis. Niepotwierdzone unieważnienie blokuje zmianę publikacji. Rollback może pozostawić kopię unieważnioną do następnego odnowienia — jest to celowe zachowanie fail-closed. Kopia nie omija osobnych uprawnień i dostępności zdjęć. Dawny pakiet z 13–14.10 pozostaje historycznym narzędziem testowym; publiczne odczyty go nie przedłużają.

## Weryfikacja i wdrożenie

- `npm test`: porcje, lodówka, sesje, zakupy, plan, kolejka i status automatu.
- `npm run test:kitchen-backend`: kopia z CAS i wycofaniem, opinie, zgodność i zapis biblioteki.
- `npm run test:seo`, `npm run test:preparation`, `npm run test:editorial` i test integracyjny opinii sprawdzają granice publikacji i danych.
- `npm run lint`, `npm run typecheck`, `npm run build -- --webpack`.

Przed produkcją: migracja bazy, kod aplikacji i workerów, dopiero potem ewentualne włączenie kopii. Bez kont czytelników; przyszła synchronizacja wymaga osobnej ograniczonej roli.

Test ręczny: wybierz produkt i włącz lodówkę → zwiń panel (wyniki pozostają) → wybierz przepis → zmień porcje (instrukcja i zakupy zgodne) → dodaj trzy dania (czwarte zablokowane) → zmień plan i odhacz zakupy → rozpocznij gotowanie i minutnik → odśwież (postęp i termin zachowane) → wpisz notatkę → Ugotowane → Ugotuj ponownie (nowe postępy, zachowane notatki/porcje) → sprawdź „Moją kuchnię”. Sprawdź także PL/EN, klawiaturę, wąski ekran, druk oraz konflikt rewizji. Testy z pięcioma rzeczywistymi domownikami i pomiar czasu pracy admina są osobnym etapem walidacji produktu.

## Historyczne wyniki kontroli lokalnej — 18.10.2026

- 136 testów podstawowych i 22 testy nowych granic backendu: poprawne.
- 87 testów automatycznej publikacji i 14 integracyjnych testów redakcji: poprawne.
- Testy przygotowania i SEO oraz 8 integracyjnych testów opinii: poprawne.
- Odtworzenie schematu backupu 0024 w prywatnym lokalnym PostgreSQL 18: zgodna struktura i skróty danych, klaster posprzątany. Osobny `test:backup-schema` wymaga narzędzi PG18 w PATH lub `MEDIA_BACKUP_TEST_PG_BIN`; nie wymaga działającego serwera.
- Lint, TypeScript i kompilacja produkcyjna webpack: poprawne.
- Przeglądarka: lodówka po zwinięciu, porcje i zakupy, sesja i minutnik po odświeżeniu, zakończenie i ponowne gotowanie z notatką, plan trzech dań i jego odhaczona lista po odświeżeniu, sugestie wspólnych składników oraz układ planu przy szerokości 449px.
- Panel: odczyt kolejki, kosztów, biblioteki, opinii i kanonicznego automatu na bazie development z wymuszonym trybem tylko do odczytu.

Nie przeprowadzono jeszcze badania z pięcioma domownikami ani pomiaru poprawy czasu pracy właściciela. Do porównania 30% trzeba zmierzyć tę samą serię zadań przed i po wdrożeniu: aktywne minuty, przejścia między ekranami, czas rozwiązania konkretnej blokady. Anonimowe liczniki interakcji nie zastępują tego pomiaru.

## Historyczne wdrożenie produkcyjne — 18/19.10.2026

Poniższy opis zachowuje dowody tamtego wydania. Zegar automatycznej publikacji i wcześniejsza systemowa akceptacja nie opisują modelu obowiązującego od 20.10; aktualna zasada to codzienny tekst, ręczna ocena, osobna decyzja o zdjęciach i ręczna publikacja.

Wersja jest dostępna pod `https://www.jesie.pl`. Wdrożenie Vercel `dpl_CQe73ANsj48YrD5Bot84davdekxq` ma stan READY i zostało promowane na domenę produkcyjną. Zdalna kompilacja produkcyjna Turbopack oraz TypeScript zakończyły się poprawnie. Poprzednie wdrożenie `dpl_4ADNXw6Sctduyg6U2gBJZeR2MiEh` zachowano jako punkt powrotu aplikacji.

Migrację `0024-kitchen-experience` zastosowano transakcyjnie do zweryfikowanej bazy produkcyjnej 18.10 o 21:41 UTC. Skrót SQL: `a55cedd4a13510fc2842007eeec3b9dabc08f26804b31d9942bf13819840a821`. Rejestr migracji i rzeczywistą strukturę sprawdzono osobnym odczytem; fingerprint schematu wynosi `74e71e1bccd6b17bc96b57098ef74023fe0f2552e59c6e9f264aa348f0e75c97`. Zachowano dotychczasowe treści: 24 opublikowane przepisy i 7 zatwierdzonych, nieopublikowanych.

Przed odnowieniem kopii publicznej anulowano stary, oczekujący zegar publikacji przypięty do poprzedniego kodu. Obsługa publikacji uruchomiła nowy zegar `wrun_41M58FSR9450JGRY431Z9XGEFP` na nowym wdrożeniu, generacja 3. Termin pozostał 19.10 o 04:00 UTC (06:00 w Warszawie). `PUBLIC_RECIPE_SNAPSHOT_ENABLED=true` ustawiono dla produkcji. Panel potwierdza gotową, odnowioną kopię publiczną, a istniejący outbox został obsłużony. Wykonanie kolejnego zaplanowanego crona nie jest częścią tego jednorazowego sprawdzenia.

Kontrola działającej produkcji:

- 167 asercji w 58 anonimowych żądaniach GET: strony PL/EN, API, SEO i zasoby — bez błędów.
- 11 kontroli ochrony panelu: przekierowania na logowanie, odpowiedzi 401 i brak prywatnych danych — poprawne.
- Przeglądarka czytelnika: aktywna lodówka po zwinięciu, porcje i zakupy, produkty posiadane, sesja z notatką i minutnikiem po odświeżeniu, jawne zakończenie i ponowne gotowanie z nowym postępem, trzy dania oraz odhaczona lista zachowana po odświeżeniu — poprawne.
- Zalogowana sesja właściciela: kolejka uwagi, koszty, opinie, status automatu, 506 rzeczywistych mediów i ich wyszukiwanie, osobny zapis ręcznego szkicu, podglądy PL/EN bieżącej rewizji i odblokowanie potwierdzenia dopiero po ich wczytaniu — poprawne.

Zakres kontroli produkcyjnej obejmował rzeczywiste odczyty i lokalne interakcje czytelnika oraz obsługę zegara i kopii. Publikowanie/wycofywanie treści, podmiany zdjęć, płatne zlecenia i zapis opinii były sprawdzone testami przed wdrożeniem; podczas kontroli produkcji nie wykonywano tych operacji na materiałach redakcyjnych. Układ przy 449px sprawdzono lokalnie przed wdrożeniem. Zachowanie awaryjnej kopii podczas symulowanej awarii bazy sprawdzono testami backendu, a na produkcji potwierdzono jej poprawny stan.

Raport wdrożenia i dowody: `output/kitchen-production-2026-10-18/RELEASE.md`. Prywatne pliki `.private` i eksport środowiska nie są materiałem do publikacji.

## Koszty od 19.10.2026

Właściciel usunął wszystkie finansowe limity i rezerwacje. Studio, radar i pakiety zdjęć raportują potwierdzone rzeczywiste koszty; brak rachunku oznacza „do rozliczenia”. Zabezpieczenia przed powieleniem płatnego żądania i ograniczenie równoległości pozostają aktywne niezależnie od kwoty. Migracja 0026 nie przepisuje historii kosztów.

## Kolekcje od 27.10.2026

Własny zestaw kolekcji ma dowolną liczbę dań i osobne porcje; zapis PL/EN jest wspólny na urządzeniu. Zakupy sumują zgodne produkty i jednostki, uwzględniają porcje i zamienniki; zwiększenie ilości unieważnia odhaczenie starej ilości. Lodówka nie pomniejsza zakupów po cichu. Niedostępny przepis pozostaje oznaczony w zestawie i nie dostarcza składników. Strona planu odsyła do zapisanych zestawów. Limit trzech dań dotyczy wyłącznie dotychczasowego planu. Migracje 0030/0031 są częścią runnera; stan produkcji i bootstrap nowego klonu opisuje [przekazanie](claude-code-handoff.md).
