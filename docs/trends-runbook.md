# Codzienne inspiracje: wyszukiwanie i tekst, potem decyzje redakcji

## Obowiązujący model od 20.10.2026

Radar codziennie wyszukuje propozycję i opracowuje **tekst szkicu PL/EN**. Każdy wynik wymaga oceny administratora. Dotyczy to zarówno potwierdzonego trendu, jak i inspiracji. Codzienne przygotowanie nie zleca fotografii, nie zatwierdza treści za człowieka i nie publikuje przepisu.

Przebieg pracy:

1. Dzienny cron `/api/cron/trends` o 12:00 UTC wyszukuje propozycję i przygotowuje tekst. To 14:00 w Warszawie latem, 13:00 zimą; panel pokazuje konkretną datę i godzinę dla Europe/Warsaw.
2. Administrator otwiera szkic z sekcji „Szkice do Twojej oceny” w `/admin/automation` lub z kolejki redakcyjnej. Sprawdza oba języki, składniki, ilości, kroki, czasy, pochodzenie i zamienniki. Poprawia treść w podstawowym edytorze.
3. Administrator jawnie akceptuje bieżącą treść, a potem osobno decyduje o przygotowaniu zdjęć. Odczyt szkicu i podglądu nie stanowi zgody na fotografie.
4. Po sprawdzeniu fotografii oraz obu aktualnych podglądów administrator ręcznie klika „Publikuj przepis”. Wyszukiwanie, akceptacja treści i zakończenie fotografii nie uruchamiają publikacji.

Adres `/admin/automation` pozostaje zgodny ze starszymi odnośnikami; w panelu nazywa się „Codzienne inspiracje”. Przełącznik właściciela dotyczy wyłącznie przyszłego wyszukiwania i opracowania tekstu. Włączenie nie uruchamia natychmiast płatnego przebiegu. Fotografie i publikacja pozostają osobnymi decyzjami redakcji także przy włączonym przełączniku.

## Wybór propozycji i dowody

Ranking opiera się na zebranych dowodach aktualnego zainteresowania z publicznych, indeksowanych źródeł. Nie mierzy wszystkich odsłon ani polubień platform i nie oznacza globalnej popularności.

Potwierdzony trend wymaga trzech niezależnych źródeł z ostatnich 14 dni, w tym materiału autora społecznościowego i sprawdzonej wzmianki o bieżącym zainteresowaniu. Weryfikacja porównuje cytat i datę ze stroną. Niedostępny materiał, nieznana data, duplikat lub niepotwierdzony autor nie zastępują brakujących dowodów. Alias istniejącego przepisu i niejednoznaczne podobieństwo chronią przed duplikatem.

Kolejność wyboru to potwierdzony trend, inspiracja z wyszukiwania, lokalna propozycja sezonowa, a po wyczerpaniu nowych pomysłów istniejący przepis z katalogu do ponownej oceny. Wybór sezonowy i katalog nie otrzymują fikcyjnych źródeł. Istniejący przepis nie jest ponownie generowany tylko po to, aby dostarczyć nowy szkic.

Oznaczenie „Popularne teraz” wymaga potwierdzonych dowodów. Inspiracja ich nie zastępuje. Żadna podstawa wyboru nie zwalnia z ręcznej oceny, zgody na zdjęcia ani ręcznej publikacji.

## Treść, fotografie i odzyskiwanie

Codzienne przygotowanie kończy się na szkicu do oceny. Nie tworzy systemowej akceptacji zastępującej decyzję człowieka. Akceptacja treści odnosi się do bieżącego hasha kulinarnej treści PL/EN i konceptu podania. Zmiana treści wymaga ponownej akceptacji. Samo dodanie fotografii jej nie unieważnia.

Po ręcznej akceptacji i osobnym zleceniu fotografii kolejność pakietu jest stała: **brakujące składniki → kroki → gotowe danie**. Zgodne fotografie składników można ponownie wykorzystać z biblioteki. Gotowe wyniki są zapisywane przed kolejnym etapem; ostateczne zdjęcie korzysta z zaakceptowanego konceptu, składników, kroków i podania.

Niepewne lub przyjęte już zgłoszenie nie może zostać powielone drugim płatnym POST-em. Najpierw odczytaj zachowany identyfikator i stan dostawcy. Wyłączenie wyszukiwania nie usuwa istniejących wyników, treści, rachunków ani historii. Ręczny szkic i publikacja pozostają dostępne w edytorze zgodnie z uprawnieniami.

Przejęcie redakcyjne i stara historia akceptacji pozostają zachowane. Wznowiony stary worker nie może ominąć obowiązku ręcznej decyzji o fotografiach ani opublikować przepisu. Granica ta obowiązuje także w bazie, niezależnie od wersji kodu uśpionego workera. Dawne rekordy dni publikacji i zegary służą wyłącznie historii; nie są obietnicą przyszłej publikacji.

## Uruchomienie i kontrola

1. Skonfiguruj serwerowe usługi wyszukiwania i treści oraz `CRON_SECRET`. Do późniejszych, ręcznie zleconych fotografii potrzebne są także usługa zdjęć i prywatny Blob. Sekrety nie trafiają do repozytorium ani klienta. Brak konfiguracji fotografii nie powinien blokować samego wyszukiwania i tekstu.
2. Zastosuj migracje do zweryfikowanej bazy właściwego środowiska przed udostępnieniem nowego kodu. Nie zmieniaj zastosowanych migracji. Migracja 0026 usuwa finansowe ograniczenia nowych zleceń; migracja 0027 odgradza dawną automatyczną publikację i wymusza ręczną zgodę przed nowymi zdjęciami. Zachowaj zgodność pakietu schematu kopii zapasowej.
3. Wdróż aplikację i nowe workery. Sprawdź alias produkcyjny, stan migracji i rzeczywisty cron. Nie wywołuj płatnego przebiegu wyłącznie dla sprawdzenia interfejsu.
4. Właściciel zarządza przełącznikiem w `/admin/automation`. Wcześniejsze automatyczne zatrzymanie wymaga sprawdzenia widocznej przyczyny i aktualnego tokenu potwierdzenia; nie obchodź tej kontroli.
5. Sprawdź następny termin wyszukiwania, stan ostatniego przygotowania, kolejkę szkiców do oceny i odnośniki do źródeł oraz kosztów. Interfejs odświeża stan podczas pracy i po powrocie do karty. „Włączone” nie oznacza, że zlecenie właśnie trwa.

Istniejący cron `/api/cron/trends/publish` pozostaje dla zgodności i odzyskiwania outboxu SEO. Nie uzbraja zegara i nie publikuje przepisu; jego odpowiedź nie jest dowodem publikacji. Nie dodawaj nowego publishera. Ewentualny przyszły, uśpiony zegar starej wersji można zakończyć dopiero po wdrożeniu zabezpieczeń bazy i odczytowym potwierdzeniu właściwego identyfikatora.

Log `daily_preparation_dispatch` rozróżnia utworzenie, istniejący przebieg i pominięcie z kodem. Sam HTTP 202 nie dowodzi wykonania wyszukiwania. Potwierdź rzeczywisty `trend_run`, identyfikator Workflow, zachowany wynik wyszukiwania, opracowany szkic i końcowy stan do oceny. Oddziel poprawne wykonanie wyszukiwania od znalezienia potwierdzonego trendu. Brak zdjęć po dziennym przebiegu jest oczekiwanym wynikiem.

## Rzeczywiste koszty

Od 19.10.2026 nie ma finansowych limitów ani rezerwacji. Nowe zadania zapisują rezerwację zero. Historyczne pola i księga pozostają niezmienione dla audytu; nie są aktywną blokadą. Stare endpointy zmiany limitów zwracają 410 po sprawdzeniu uprawnień.

Koszty radaru obejmują wykonane wyszukiwanie, opracowanie i historyczne lub ręcznie zlecone fotografie. Studio ma osobne zestawienie. Kwota jest rzeczywista tylko po potwierdzeniu rachunku; brak rachunku oznacza „do rozliczenia” i nie jest zerowym kosztem. Ograniczenie równoległości, autoryzacja, idempotencja i odzyskiwanie przyjętych zgłoszeń działają niezależnie od kwoty.

Przed dziennym wyszukiwaniem system odczytuje rachunki istniejących, zakończonych zdjęć radaru metodą GET. Nie zleca przez to nowej generacji. Ręczne uzgodnienie jest dostępne w `/admin/trends/budget` — historyczny adres prowadzi do „Kosztów i rachunków radaru”. Brak rachunku, brak dostępu lub niedostępność dostawcy pozostawiają koszt do rozliczenia. Uzgodnienie Studio nadal obejmuje wyłącznie Studio.

## Historia wcześniejszego modelu

Do zmiany z 20.10.2026 istniał mechanizm publikacji o 06:00 Europe/Warsaw dla kwalifikujących się trendów. Migracje 0019 i 0020 porządkowały wcześniejsze harmonogramy i ręczne przejęcie. Raporty w `output/kitchen-production-2026-10-18/`, `output/trend-automation-fix-2026-10-19/` i `output/cost-only-2026-10-19/` opisują stan z tamtych wdrożeń. Ich zegary, kryteria automatycznej akceptacji i terminy publikacji są dowodem historycznym, a nie aktualną instrukcją działania.
