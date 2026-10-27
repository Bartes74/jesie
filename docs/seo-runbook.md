# Publikacja i SEO jesie.pl

Kanoniczny adres: `https://www.jesie.pl`. Obecne adresy przepisów pozostają bez zmian. Produkcja Vercel jest indeksowana; development, preview, panel i prywatne podglądy są wyłączone z indeksacji. Poza Vercel indeksację włącza dopiero produkcyjny build z `SEO_INDEXING_ENABLED=true`.

## Codzienna praca

1. W panelu wybierz „Dodaj przepis”, podaj tytuł i opcjonalnie opis lub cały przepis. „Wygeneruj przepis” wykonuje research i uzupełnia szablon.
2. Sprawdź i zaakceptuj treść. Następnie wygeneruj brakujące grafiki: składniki (z wykorzystaniem istniejącej biblioteki), kroki, na końcu gotowe danie.
3. Obejrzyj podgląd dla czytelnika i kliknij „Publikuj”. Ręczne przepisy pozostają szkicami do tego kliknięcia. Dalsze zmiany treści wymagają ponownej akceptacji.
4. W `/admin/automation` właściciel włącza codzienne wyszukiwanie i opracowanie tekstu szkicu. Od 20.10.2026 także potwierdzony trend wymaga ręcznej oceny, osobnego zlecenia zdjęć i ręcznej publikacji; nie działa publisher o 06:00.

Nie utrzymujemy siedmiu ręcznie zatwierdzonych przepisów w zapasie. Dawny harmonogram FIFO i rezerwacje dat pozostają historyczne; nie sterują bieżącym automatem. Trend musi mieć trzy niezależne aktualne źródła, w tym materiał społecznościowy i sprawdzony sygnał zainteresowania. Ranking dowodów nie jest pomiarem wszystkich odsłon czy polubień. Inspiracja bez tych dowodów pozostaje szkicem do ręcznej decyzji.

## Kolekcje, poradniki i promocja

Panel `/admin/collections` obejmuje szkic, teksty PL/EN, wybór i kolejność dań, wersjonowaną generowaną oprawę, podglądy oraz osobną publikację. Cztery przeniesione kolekcje zachowują próg odkrywania pięciu przepisów; nowe można opublikować od jednego. „Obiady do 30 minut” dobierają opublikowane obiady/zupy według pełnego czasu >0 i ≤30 minut, pozostałe kolekcje mają ręczne przypisania. Opublikowane strony działają cały rok; daty pełnych dni Europe/Warsaw dotyczą wyłącznie promocji hero. Katalog, nawigacja, stopka i powiązania przepisów umożliwiają powrót poza sezonem. Nie tworzymy indeksowanych stron dla kombinacji filtrów; filtrowane URL-e wskazują canonical kolekcji i noindex, follow.

Poradniki są opracowane w `src/lib/content-hubs.ts`: pełne wersje PL/EN, stabilne daty, sekcje i powiązania. Dodaj nowy materiał co dwa tygodnie, zapisując rzeczywistą datę pierwszej publikacji. Merytoryczne poprawki zmieniają `dateModified`, nie datę publikacji. Materiały sezonowe przygotuj 4–6 tygodni wcześniej.

Na Pinterest przeznacz trzy materiały tygodniowo. Kadr 1000×1500 jest generowany z głównej ilustracji; kieruj do kanonicznego przepisu lub kolekcji. Oceń wyniki po ośmiu tygodniach. Publikowanie w mediach społecznościowych pozostaje ręcznym działaniem właściciela.

## Odkrywanie i konfiguracja

Publikacje mają dane JSON-LD Recipe zgodne z bazowymi porcjami i widoczną treścią. Składniki oraz instrukcje korzystają z tego samego przelicznika. Nie dodajemy fikcyjnych ocen, wartości odżywczych, osób ani publicznych oznaczeń AI.

`/sitemap.xml` zawiera przepisy, dostępne tłumaczenia, zdjęcia, poradniki i gotowe kolekcje. Daty przepisów wynikają z niezmiennej historii publikacji. Kolekcje mają własną historię publikacji; sprawdzaj aktualne reguły sitemap w `src/app/sitemap.ts`, a nie daty należących do nich przepisów. `/pl/feed.xml` i `/en/feed.xml` udostępniają nowe materiały.

`INDEXNOW_KEY` to publiczny klucz własności (8–128 liter/cyfr/myślników). `/indexnow-key.txt` udostępnia go do weryfikacji. Zgłoszenia są ponawiane z opóźnieniem, a niepowodzenie nie cofa publikacji. Przyjęcie 200/202 nie gwarantuje indeksowania.

`GOOGLE_SITE_VERIFICATION` i `BING_SITE_VERIFICATION` uzupełniają metatagi własności. W panelach wyszukiwarek zgłoś `https://www.jesie.pl/sitemap.xml`. W Search Console pozostaw włączenie treści do funkcji generatywnych. Google Indexing API i `llms.txt` nie są częścią tego wdrożenia.

Obrazy pochodne mają stabilne adresy, pięć rozmiarów i prywatny magazyn. Publiczny endpoint sprawdza aktualny opublikowany przepis. CDN może przechowywać już wydane obrazy do pięciu minut po wycofaniu. Szkice i nieopublikowane media nie otrzymują publicznego cache.

Zdjęcia główne z magazynu mają dodatkowe przezroczyste warianty 320, 640, 960, 1280 i 1600 px używane przez `srcset`. Przeglądarka dobiera rozmiar do ekranu, bez zmiany kadru potrawy. Kadr pionowy i społecznościowy można otworzyć z panelu „Publikacja i SEO”.

## Monitoring i weryfikacja

Panel techniczny SEO pokazuje stan zgłoszeń i anonimowe liczniki działań. Bieżąca publikacja jest opisana w `/admin/automation`. Liczniki są agregatami, nie liczbą użytkowników; nie zapisujemy IP, identyfikatorów, surowych referrerów ani cookies. DNT/GPC i znane boty pomijamy. Dane wyszukiwarek sprawdzaj w Search Console i Bing Webmaster Tools: indeksacja, ruch bez nazwy marki, obrazy oraz dostępne raporty AI.

Każda zmiana publikacji uruchamia osobny Vercel Workflow obsługujący jej zgłoszenie. Trwały outbox i opóźnienia Workflow zapewniają ponowienia po błędach bez ciągłego odpytywania. Istniejące zadania crona odzyskują nieuruchomione zgłoszenia. Zgodnościowy `/api/cron/trends/publish` nie publikuje; godzinowy `/api/cron/public-snapshot` odnawia dane i ponawia odkrywanie kolekcji. Chroniony endpoint `/api/cron/seo` wymaga `CRON_SECRET` i pozwala również ręcznie uruchomić odzyskiwanie po wdrożeniu.

Migracje 0011–0014 wprowadziły kolejkę, agregaty i trwałe zgłoszenia. Historyczna 0013 blokowała automatyczne publikacje. Historyczne migracje 0018–0020 dodawały osobną akceptację treści, wyłączają dawny harmonogram ręcznych szkiców, odgradzają stare workery i dopuszczają wyłącznie nowy potwierdzony trend dnia. Ręczne przejęcie przepisu trwale wyłącza jego automatyczną publikację. Obecny model odgradza dawny publisher migracją 0027, a 0030/0031 dodają kolekcje i oprawy. Nie zmieniaj zastosowanych migracji. Szczegóły uruchomienia i odzyskiwania są w `docs/trends-runbook.md`.

Właściciel może użyć przycisku „Ponów obsługę publikacji” w panelu, aby odzyskać zgłoszenia i zegar bez znajomości `CRON_SECRET`. To działanie nie uruchamia płatnego przygotowywania przepisów.

Po pierwszym wdrożeniu użyj „Zgłoś istniejące publikacje”. Każda aktualna opublikowana wersja otrzyma jedno trwałe zgłoszenie; ponowne kliknięcie nie dubluje go ani nie zmienia dat i historii przepisu.

Przed wdrożeniem: `npm run db:migrate`, `npm test`, `npm run test:seo`, `npm run test:daily-publication`, `npm run test:seo:integration`, `npm run lint`, `npm run typecheck`, `npm run build`. Testy integracyjne używają tymczasowych schematów; dla metryk podaj wyłącznie izolowany `EDITORIAL_TEST_DATABASE_URL`. Migracje produkcji uruchamiaj jawnie z właściwym plikiem środowiska.
