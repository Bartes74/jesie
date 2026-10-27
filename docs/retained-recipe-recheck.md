# Ponowne sprawdzanie zachowanego przepisu

Naprawa słownika nie zmienia automatycznie zakończonego zadania AI. Jego komunikat walidacji pozostaje częścią historii. Aby sprawdzić wynik po naprawie, użyj w panelu **Sprawdź zapisany wynik** (`POST /api/admin/ai/{id}/actions`, `action: recheck`).

To osobny przebieg `recipeRecheck`, który:

- korzysta z istniejącego identyfikatora odpowiedzi, historii i limitu dwóch poprawek;
- pobiera wyłącznie zachowane odpowiedzi dostawcy, używa słownika i wcześniejszych dowodów składników;
- nie wysyła nowej generacji przepisu, płatnej naprawy ani nowych badań składników;
- wymaga uprawnień administratora, zgodnego pochodzenia żądania i niezmienionego szkicu;
- respektuje dzierżawę i generację procesu; nie budzi starszego procesu, który mógłby zlecić płatne prace;
- zapisuje poprawny wynik jako gotowy do oceny, bez zastosowania do szkicu, akceptacji treści, zdjęć lub publikacji.

Jeżeli poprzedni proces nadal działa, poczekaj na zakończenie i ponów odczyt. Nie kasuj dzierżawy ani historii. Przy braku zapamiętanych dowodów pojawi się bieżąca, konkretna przeszkoda; recheck nie kupuje jej rozwiązania. Nowe błędy odczytu nie powinny być maskowane historycznymi błędami składników.

**Dokończ automatycznie** (`recover`) pozostaje osobną funkcją: może dopuścić rozliczane poprawki w dotychczasowym limicie. Nie traktuj jej jako gwarancji braku nowych kosztów.

Weryfikacja lokalna: `npm run test:ingredient-verification` oraz `npm run test:result-recovery:unit` bez usług i bazy. `npm run test:result-recovery` wymaga odizolowanej bazy PostgreSQL w `AI_TEST_DATABASE_URL`; nie używaj produkcyjnego połączenia. Test integracyjny blokuje połączenia z dostawcami i sprawdza historię, koszt, duplikaty i brak przyjęcia niewysłanego dziecka.
