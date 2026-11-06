# Ponowne sprawdzanie zachowanego przepisu

## Ręczne odblokowanie etapu sprawdzania

Przy zatrzymanym zadaniu użyj **Popraw zachowany wynik i wznów**. Ekran jest dostępny zarówno ze szkicu, jak i ze szczegółów zadania. Pozwala rozstrzygnąć tożsamość i kategorię dokładnie wskazanego składnika oraz poprawić pozostałe pola zachowanego przepisu. Wymaga opisu wykonanej korekty. **Zapisz korektę i wznów od sprawdzania** zachowuje podpis administratora i uruchamia wyłącznie odczyt/walidację tego samego wyniku; nie kupuje przepisu, badań składników ani kolejnej automatycznej poprawki.

Od migracji `0034-recipe-checkpoints` zakończona odpowiedź jest zapisywana w `ai_recipe_response` przed walidacją i badaniem składników. Ponowne sprawdzanie korzysta najpierw z lokalnej kopii, także gdy dostęp do generatora wygasł. Oryginał, potwierdzenie dostawcy i suma kontrolna są niezmienne. Starsze odpowiedzi są zachowywane podczas pierwszego odczytu ekranu korekty lub wznowienia.

Ręczne korekty tworzą niezmienne wersje `ai_recipe_manual_repair`. Decyzja o składniku obowiązuje tylko w tym przepisie, dla identycznej pary nazw PL/EN i identyfikatora składnika; nie rozszerza globalnego słownika. Nie może zmienić rozpoznanego mięsa lub nabiału w produkt wegański. Zmieniona rewizja szkicu, nowszy etap poprawki, wyłączone konto i równoczesny zapis są odrzucane. Pozostałe walidacje, w tym czasy, źródła i samodzielność treści, nadal obowiązują. Awaria uruchomienia procesu nie usuwa zapisanej korekty — można ponowić wznowienie.

Dotychczasowy limit dwóch płatnych poprawek nie ogranicza lokalnych korekt administratora. Ręczna korekta nie zastępuje późniejszego przeczytania i akceptacji treści, decyzji o fotografiach ani publikacji.

Testy: `npm run test:result-recovery:unit`, `npm run test:ingredient-verification` oraz `npm run test:recipe-checkpoints` na jawnie wskazanym, odizolowanym lokalnym PostgreSQL w `AI_TEST_DATABASE_URL`. Pakiet odtwarzania bazy obejmuje obie tabele i ochronę historii.

## Zwykły ponowny odczyt

Naprawa słownika nie zmienia automatycznie zakończonego zadania AI. Jego komunikat walidacji pozostaje częścią historii. Aby sprawdzić wynik po naprawie, użyj w panelu **Sprawdź zapisany wynik** (`POST /api/admin/ai/{id}/actions`, `action: recheck`).

To osobny przebieg `recipeRecheck`, który:

- korzysta z istniejącego identyfikatora odpowiedzi, historii i limitu dwóch poprawek;
- pobiera wyłącznie zachowane odpowiedzi dostawcy, używa słownika i wcześniejszych dowodów składników;
- nie wysyła nowej generacji przepisu, płatnej naprawy ani nowych badań składników;
- wymaga uprawnień administratora, zgodnego pochodzenia żądania i niezmienionego szkicu;
- respektuje dzierżawę i generację procesu; nie budzi starszego procesu, który mógłby zlecić płatne prace;
- zapisuje poprawny wynik jako gotowy do oceny; sam przebieg nie stosuje go do szkicu, nie akceptuje treści, nie zleca zdjęć i nie publikuje przepisu.

Uproszczony edytor ma istniejący, osobny etap automatycznego wczytania gotowej propozycji do zgodnej wersji szkicu (`apply_text`). Dlatego po odczycie otwarty edytor może zwiększyć rewizję szkicu i oznaczyć zadanie jako `applied`, aby wyświetlić tekst do oceny. To nie jest akceptacja treści: nadal wymaga ona osobnego działania administratora po przeglądzie PL/EN. Szczegóły zadania AI nie wczytują propozycji automatycznie.

Jeżeli poprzedni proces nadal działa, poczekaj na zakończenie i ponów odczyt. Nie kasuj dzierżawy ani historii. Przy braku zapamiętanych dowodów pojawi się bieżąca, konkretna przeszkoda; recheck nie kupuje jej rozwiązania. Nowe błędy odczytu nie powinny być maskowane historycznymi błędami składników.

**Dokończ automatycznie** (`recover`) pozostaje osobną funkcją: może dopuścić rozliczane poprawki w dotychczasowym limicie. Nie traktuj jej jako gwarancji braku nowych kosztów.

Weryfikacja lokalna: `npm run test:ingredient-verification` oraz `npm run test:result-recovery:unit` bez usług i bazy. `npm run test:result-recovery` wymaga odizolowanej bazy PostgreSQL w `AI_TEST_DATABASE_URL`; nie używaj produkcyjnego połączenia. Test integracyjny blokuje połączenia z dostawcami i sprawdza historię, koszt, duplikaty i brak przyjęcia niewysłanego dziecka.

## Potwierdzenie 28.10.2026

Kod PR #2, scalony jako `22a8761`, wdrożono w produkcji `dpl_Btr8x8Mz8mRBSVfiNLKw66FUM9CN`; punkt wydania: `release-2026-10-28-recipe-recheck`. CI Node 24, lint, build i TypeScript przeszły; testy: 338 podstawowych, 84 słownika, 69 odzyskiwania oraz 40 integracji na odizolowanym PostgreSQL 18. Integracje nie łączyły się z rzeczywistymi dostawcami.

W zalogowanym panelu ponownie odczytano oba zachowane wyniki Miang Kham. Aktualna propozycja ma 13 składników i 7 kroków, wcześniejsza 14 i 8. Gotowa treść została wyświetlona w uproszczonym edytorze; sprawdzono przełączenie PL/EN aktualnego przepisu. Nie akceptowano treści, nie generowano zdjęć i nie publikowano tych szkiców.

Potwierdzono identyczne identyfikatory odpowiedzi (przez SHA-256), próbę płatnej poprawki nadal równą 0, niezmienione rachunki 0,56487050 i 0,79022500 USD oraz brak nowych zleceń i weryfikacji składników. Wzrosła tylko generacja procesu odczytu, nie numer płatnej poprawki. Dane dowodowe i spójna kopia bazy pozostają prywatnie poza Git.

Publiczny snapshot v2 odnowiono o `2026-10-27T23:28:36.381Z` (28.10, 00:28 czasu Warszawy): 44 przepisy i cztery kolekcje. PL/EN oraz kolekcja jednej patelni/garnka odpowiadały 200; kontrola logów wdrożenia nie wykazała 5xx. To historyczny punkt kontrolny, nie gwarancja przyszłego stanu.
