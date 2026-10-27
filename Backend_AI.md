> Materiał historyczny z wcześniejszych etapów projektu. Aktualny stan, konfigurację i granice publikacji opisują [przekazanie](docs/claude-code-handoff.md), kod i bieżące runbooki; nie traktuj dawnych planów jako aktywnego zachowania.

# Studio AI — jesie.pl

## Zakres

Panel `/admin/ai` pozwala wybrać zapisany szkic, rodzaj materiału i instrukcję. Treść obejmuje cały przepis po polsku i w angielskim UK. Fotografie obejmują potrawę, wybrany składnik z przezroczystym tłem oraz makro detalu wybranego kroku. Zdjęcie główne stanowi referencję światła i stylistyki składników oraz kroków. Każda generacja ma adres `/admin/ai/<id>`, trwały status i wynik do ręcznego przeglądu.

Zastosowanie sprawdza bieżącą wersję szkicu. Starsza propozycja wymaga dodatkowej akceptacji. Zachowuje oryginał, autora, źródła i pasujące fotografie; czyści listę akceptacji redakcyjnych. Publikacja nadal jest oddzielną, ręczną czynnością. Treści AI są oznaczone jako nieprzetestowane w kuchni.

## Modele i wykonanie

Domyślnie treść: **gpt-6-astra** przez OpenAI Responses z tłem, ścisłym JSON Schema i rozumowaniem `medium`. Alternatywny zatwierdzony profil kosztów: **gpt-6.1-sol**. Fotografie: **openai/gpt-image-2.5/sunburst**, jakość `xhigh`, jeden obraz, PNG; wersja `/edit` dla istniejącej referencji. Wymiary: potrawa 2560×1920, składnik 1024×1024, krok 2240×960 (21:9). Potrawa i składnik mają przezroczyste tło; zapis sprawdza rzeczywistą alfę, a kroki mają także fizyczny kadr 21:9.

Dokumentacja modeli: [OpenAI](https://developers.openai.com/api/docs/models/gpt-6-astra), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [background](https://developers.openai.com/api/docs/guides/background), [fal model](https://fal.ai/models/openai/gpt-image-2.5/sunburst/text-to-image/api).

Vercel Workflow wykonuje pojedyncze wysłanie i bezpieczne odczyty stanu z regionu Frankfurt. Rezerwacja i deduplikacja powstają atomowo w PostgreSQL. Wznowienie dotyczy wyłącznie odczytu istniejącego identyfikatora dostawcy. Niepewne przyjęcie bez identyfikatora wymaga sprawdzenia u dostawcy — nie powoduje automatycznej nowej płatnej generacji. Aktualna wersja używa odpytywania; webhooki nie są wymagane ani skonfigurowane.

Prywatny Blob przechowuje oryginał i WebP. Pobranie pliku wymaga logowania do panelu albo odniesienia z aktywnej publikacji. Wycofanie publikacji usuwa publiczny dostęp. Tymczasowe adresy fal.ai nie są publikowane. Wyniki przechodzą kontrolę domeny CDN, braku przekierowań, rozmiaru, typu pliku, wymiarów oraz użytecznej przezroczystości dania i składnika. Publiczna dostępność współdzielonego pliku zależy od wszystkich aktywnych publikacji, które go używają.

## Koszty i konfiguracja

Produkcja domyślnie dopuszcza USD 10 dziennie, USD 50 miesięcznie i USD 50 łącznie w pilotażu; development/preview USD 5 / 20 / 20. Równocześnie maksymalnie dwa niezakończone żądania. Nowe treści i fotografie rezerwują USD 2. Wycięcie obecnego zdjęcia dania (`fal-ai/sam-3/image`) rezerwuje USD 0,10; maska zachowuje piksele potrawy i naczynia. Przycięcie istniejącego zdjęcia kroku (`jesie/step-photo-21-9`) działa lokalnie i kosztuje USD 0, również po wyczerpaniu budżetu. Panelowe zużycie już uwzględnia rezerwacje — nie należy dodawać ich drugi raz.

Treść ma limit 60 000 bajtów całego żądania i 24 000 tokenów wyjścia, obejmujący rozumowanie. Koszt jest obliczany według zwróconego wykorzystania i zatwierdzonego [cennika OpenAI](https://developers.openai.com/api/docs/pricing), w tym odrębnych tokenów odczytu i zapisu cache. Rezerwacja zdjęcia jest oszacowaniem; tokenowy cennik fal.ai nie daje twardego pułapu USD 2. Aplikacyjne limity nie zastępują limitów kont dostawców.

Aktywny właściciel lub administrator zarządza budżetem Studio w `/admin/settings`. Dzienny, miesięczny i łączny limit USD są zapisywane w bazie i obowiązują wszystkich administratorów bez kolejnego wdrożenia. Limit łączny obejmuje historię Studio od początku; okna dzienne i miesięczne są liczone według UTC. Wartość 0 blokuje nowe płatne rezerwacje, ale pozwala używać biblioteki zdjęć i bezpłatnych korekt. Dopóki administrator nie zapisze limitów, obowiązują dotychczasowe wartości `AI_DAILY_LIMIT_USD`, `AI_MONTHLY_LIMIT_USD` i `AI_PILOT_LIMIT_USD` lub powyższe wartości domyślne.

Blokadę budżetową można wyłączyć na 1, 4 lub 24 godziny i wcześniej przywrócić przyciskiem „Włącz limity teraz”. Serwer przy każdej nowej rezerwacji sprawdza termin według zegara PostgreSQL, także po oczekiwaniu na wspólną blokadę budżetu. Po upływie terminu ograniczenia wracają automatycznie bez zadania cyklicznego. Przyjęte zadania i zarezerwowane paczki kończą się normalnie; nowe rezerwacje oraz wejście paczki w nowy okres UTC podlegają aktualnym limitom. Wyłączenie nie zmienia naliczania kosztów, limitu dwóch równoległych żądań ani ochrony przed podwójnym wysłaniem. Radar zachowuje osobny budżet.

`GET/PATCH /api/admin/ai/budget` wymaga aktywnego konta właściciela lub administratora. Zmiany używają numeru wersji i wspólnej blokady rezerwacji, a historia zapisuje autora, czas oraz stan przed i po zmianie. Migracja `0009-ai-budget-settings` dodaje prywatne tabele z RLS i bez dostępu ról publicznych; `scripts/migrate-ai-budget-settings.ts` zachowuje idempotentny rejestr migracji aplikacji. Instalacja zachowuje dotychczasowe limity i nie aktywuje ich wyłączenia.

Weryfikowany rachunek fal.ai jest odczytywany z [billing events](https://fal.ai/docs/platform-apis/v1/models/billing-events). Wymaga uprawnień Admin API; można użyć osobnego `FAL_BILLING_KEY`. Przy braku uprawnień albo opóźnionym rachunku aplikacja zachowuje pełną rezerwację. Księga jest dopisywana, nie nadpisywana; późniejszy rachunek rozlicza różnicę.

Klucze `OPENAI_API_KEY`, `FAL_KEY` i ewentualny `FAL_BILLING_KEY` należy skonfigurować jako sekrety serwerowe Vercel, osobno dla środowisk. `BLOB_READ_WRITE_TOKEN` dostarczają osobne prywatne magazyny produkcji i testów. Nie używać `NEXT_PUBLIC_`. Klucze nigdy nie trafiają do formularza redakcyjnego, odpowiedzi API ani plików deploymentu.

## Weryfikacja i ograniczenia

Testy PostgreSQL tworzą własny schemat i go usuwają; providerzy są zastąpieni wynikami testowymi. Testy adapterów nie wykonują płatnych wywołań. Chroniony `POST /api/admin/ai/health` sprawdza prawdziwe wykonanie Workflow i odczyt bazy, bez generowania treści ani fotografii.

Bez skonfigurowanych kluczy przyciski generowania pozostają nieaktywne, a API zwraca `PROVIDER_NOT_CONFIGURED`. Pełna próba rzeczywistej treści i obrazu pozostaje do wykonania po połączeniu kont. Bibliografia wymaga dostarczenia przez redakcję; adapter nie prowadzi automatycznej kwerendy źródeł. Masowy import, automatyczne publikowanie, testy kuchenne i serwerowy eksport PDF nie są częścią tej wersji.

## Wspólna biblioteka składników

Fotografie dopasowujemy po produkcie, postaci (także opisanej w uwagach) i wspólnym profilu stylu. Gotowy wynik jest ponownie używany za USD 0 i pozostaje do ręcznego zastosowania. Zgodne zdjęcia z dawnych przepisów wchodzą do biblioteki po odczycie prywatnego pliku i sprawdzeniu alfy; niedostępny dawny plik blokuje płatny fallback. Poprawne kadry statycznych atlasów również są dostępne bez generowania.

Unikalny producent i blokada transakcyjna dopuszczają tylko jedno płatne zlecenie dla brakującego produktu w danej postaci. Odbiorcy współdzielonego zlecenia nie wysyłają własnego POST; niepotwierdzone pierwsze zlecenie wymaga wyjaśnienia. Pakiet radaru rezerwuje fotografie tylko dla unikalnych, rzeczywiście brakujących produktów. Migracja: `scripts/migrate-ingredient-reuse.ts` / `0006-ingredient-reuse`.

Tożsamość produktu pozostaje zablokowana również pomiędzy zakończeniem pracy dostawcy a zapisaniem sprawdzonego obrazu. Migracja `0007-local-photo-corrections` rozdziela ten stan od zwolnienia slotu dostawcy. Ten sam etap dodaje bezpłatną korektę `jesie/hero-cutout-filled`: przywraca jedzenie z oryginału wyłącznie wewnątrz zamkniętego obrysu naczynia. Wymaga gotowego wycięcia SAM tego samego przepisu i zgodnej treści potrawy; wynik jest oddzielnym, niezmiennym plikiem do podglądu. Nie wysyła nowego zlecenia do fal.ai. Zewnętrzna maska oraz piksele oryginalnej potrawy pozostają zachowane. Narzędzie nie zamyka szczelin połączonych z tłem.
