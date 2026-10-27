> Materiał historyczny z wcześniejszych etapów projektu. Aktualny stan, konfigurację i granice publikacji opisują [przekazanie](docs/claude-code-handoff.md), kod i bieżące runbooki; nie traktuj dawnych planów jako aktywnego zachowania.

# Analiza aplikacji i plan wdrożenia na Vercel

Data: 3 października 2026. Podstawa: `Specyfikacja_ksiazki_kucharskiej.md` oraz referencja `IMG_3411.JPG`.

Ten dokument ocenia proponowane wymagania i przedstawia rekomendacje wdrożeniowe. Nie zastępuje specyfikacji, nie zmienia jej priorytetów i nie oznacza zatwierdzenia wszystkich założeń przez właściciela.

Konkretne wybory, w tym modele tekstowe i fal.ai, opisuje [Rekomendacje decyzji i modeli](Rekomendacje_decyzji_i_modeli.md).

Aktualizacja ustalenia z 4 października 2026: właściciel wybrał **jesie.pl** jako docelową domenę serwisu. Pozostałe ustalenia pozostają bez zmian; domenę podłączamy w ramach docelowego uruchomienia opisanego poniżej.

## Ocena projektu

Aplikacja jest wykonalna jako responsywny serwis z publiczną książką kucharską oraz prywatnym panelem redakcyjnym. Vercel jest odpowiednim miejscem dla aplikacji Next.js i jej API. Dane, ilustracje i zadania AI wymagają trwałych usług niezależnych od otwartej karty przeglądarki. [Next.js na Vercel](https://vercel.com/docs/frameworks/full-stack/nextjs)

Najważniejsze decyzje specyfikacji są trafne: jeden model ilości dla PL i EN, przeliczenia wykonywane kodem, osobne obrazy i teksty, ręczna akceptacja wyników AI oraz publikowanie niezmiennych wersji. Warto zachować je od początku, również w prototypie.

P0 jest rozbudowanym wydaniem produkcyjnym. Obejmuje nie tylko katalog, lecz także współpracę administratorów, analizę źródeł, tłumaczenia, generowanie obrazów, kontrolę kosztów, trzy szablony, edytor warstw, serwerowy PDF i procedurę odzyskania danych. Pierwszy deploy techniczny może sprawdzić część tych funkcji; odbiór P0 nadal wymaga całości wskazanej w specyfikacji.

W katalogu projektu znajdują się obecnie specyfikacja i ilustracja referencyjna. Nie ma kodu aplikacji, konfiguracji Vercel ani repozytorium Git.

## Proponowany układ aplikacji

| Obszar | Ekrany i najważniejsze działania |
| --- | --- |
| Katalog publiczny | Wyróżnione przepisy, wyszukiwanie, kategorie, filtry, sortowanie i paginacja |
| Strona przepisu | Ilustracja, parametry, PL/EN, porcje, jednostki, składniki, kroki, timery, źródła i druk |
| Ulubione | Lista zapisana lokalnie, dostępna bez konta czytelnika |
| Logowanie | Indywidualny dostęp administratora, odzyskiwanie dostępu, wyłączona publiczna rejestracja |
| Panel | Lista przepisów, statusy, szkice, zadania AI oraz zgłoszenia błędów |
| Edytor treści | Oryginał, uporządkowane dane, PL/EN, uwagi AI, podgląd i akceptacje |
| Edytor wizualizacji | Kontrolowane szablony, obrazy, ustawienia warstw, cofanie, telefon i wydruk |
| Ustawienia właściciela | Dostęp administratorów, limity generacji, słowniki i historia operacji |

Adresy publiczne powinny rozdzielać języki, np. `/pl/przepisy/[slug]` i `/en/recipes/[slug]`. Oba adresy wskazują ten sam przepis. Zmiana języka zachowuje wybraną liczbę porcji i profil jednostek. Nazwy ścieżek są rekomendacją; wymaganiem dokumentu jest podział `/pl/` i `/en/`.

## Kierunek wizualny i responsywność

Referencja sugeruje kremowe tło, maślane akcenty, szałwiową zieleń, ciemną typografię, miękkie cienie i wyeksponowane potrawy. W aplikacji potrzebne są większe teksty i wyraźniejsza hierarchia niż na obrazie. Czas, porcje i trudność powinny zajmować miejsce dekoracyjnych statystyk. Teksty i liczby pozostają w HTML, a ilustracja jest oddzielnym zasobem.

| Widok | Katalog | Przepis | Panel administratora |
| --- | --- | --- | --- |
| Telefon, punkt wyjścia 320–767 px | Jedna kolumna kart, filtry w wysuwanym panelu | Zdjęcie, parametry, kontrolki, składniki i kroki kolejno; wygodne przyciski | Jedna kolumna formularza, zakładki PL/EN, lista zamiast szerokiej tabeli |
| Tablet, punkt wyjścia 768–1199 px | Zwykle dwie kolumny | Dwie kolumny, jeśli treść mieści się czytelnie | Nawigacja zwijana; podgląd dostępny osobno |
| Komputer, od około 1200 px | Trzy lub cztery kolumny zależnie od szerokości | Składniki obok instrukcji; ilustracja ma więcej miejsca | Formularz i podgląd lub obie wersje językowe obok siebie |

To proponowane progi CSS, do weryfikacji na rzeczywistej treści. Odbiór obejmuje szerokości 360, 768 i 1440 px z dokumentu oraz reflow przy 320 CSS px. WCAG 2.2 AA wymaga zachowania treści i funkcji przy tej szerokości, z określonymi wyjątkami dla treści wymagającej układu dwuwymiarowego. [WCAG: reflow](https://www.w3.org/TR/WCAG22/#reflow)

Tekst receptury: 16–18 px jako punkt wyjścia. Główne cele dotykowe: 44 × 44 px jako założenie produktowe. Kontrolki przyklejane do krawędzi ekranu nie mogą zasłaniać treści ani fokusu. Trzeba sprawdzić długie nazwy EN, powiększenie tekstu, orientację poziomą i klawiaturę ekranową.

Wizualizacja mobilna korzysta z przepływu treści i reguł szablonu. Pozycje warstw desktopowych nie powinny być bezpośrednio kopiowane na telefon. Rekomenduję kontrolowane strefy układu, kolejność bloków i osobne ustawienia wariantów. Przesuwanie elementów musi mieć odpowiednik bez przeciągania oraz obsługę klawiaturą. [WCAG: dragging movements](https://www.w3.org/TR/WCAG22/#dragging-movements)

## Architektura i trwałość danych

Rekomendowany punkt wyjścia to modułowa aplikacja Next.js z TypeScript: publiczne strony renderowane na serwerze, interakcje kalkulatora w przeglądarce, prywatny panel i API w tym samym projekcie. Publiczny katalog nie powinien pobierać kodu edytora sceny.

| Element | Rekomendacja | Powód |
| --- | --- | --- |
| Aplikacja i API | Next.js na Vercel | Wspólny projekt, renderowanie publicznych stron i wygodne wdrożenia |
| Dane | Zarządzany PostgreSQL z poolingiem połączeń | Relacje, transakcje, publikacje, konflikty wersji i historia |
| Obrazy oraz PDF | Trwały magazyn obiektowy i CDN | Oryginały, warianty i osobne klucze plików dla kolejnych wersji |
| Logowanie | Utrzymywana biblioteka lub usługa z indywidualnymi kontami | Sesje i odzyskiwanie dostępu bez własnego mechanizmu kryptograficznego |
| AI | Adapter dostawcy uruchamiany wyłącznie na serwerze | Możliwość zmiany modeli i centralna kontrola kosztów |
| Zadania | Trwała orkiestracja lub kolejka i wykonawca | Ponawianie, wznowienie, idempotencja i przetrwanie odświeżenia panelu |
| Przeliczenia | Wspólny moduł TypeScript z dokładnymi wartościami | Te same wyniki w liście, krokach, wizualizacji i eksporcie |

Wybór konkretnej bazy, magazynu i usługi logowania pozostaje decyzją wdrożeniową. Najpierw trzeba sprawdzić posiadane usługi, wymagany region i budżet. Nie ma potrzeby tworzenia wielu mikroserwisów ani osobnego silnika wyszukiwania na starcie.

Wariant do sprawdzenia w prototypie to PostgreSQL połączony przez Vercel Marketplace, np. Neon, oraz Vercel Blob na obrazy i PDF. Vercel oferuje integracje baz danych w Marketplace. Blob obsługuje magazyny prywatne i publiczne; szkice i niezatwierdzone ilustracje powinny korzystać z dostępu prywatnego. Tryb dostępu wybiera się przy tworzeniu magazynu, więc trzeba zaplanować go przed uruchomieniem. [Vercel Storage](https://vercel.com/docs/storage), [Vercel Blob](https://vercel.com/docs/vercel-blob)

Do procesu AI warto sprawdzić Vercel Workflows: dokumentacja opisuje trwałe etapy, ponawianie oraz wznowienie po awarii lub wdrożeniu. To kandydat do oddzielenia przetwarzania od żądania HTTP bez osobnego stale działającego serwera. Rezerwacje kosztów, powiązanie z rewizją przepisu i spójność z bazą nadal są odpowiedzialnością aplikacji. Workflows nie oznacza, że płatne wywołanie AI można bezpiecznie powtarzać bez sprawdzenia wcześniejszego wyniku. [Vercel Workflows](https://vercel.com/docs/workflows)

Vercel Queues jest alternatywą dla kolejki niezależnych zadań, lecz aktualna dokumentacja oznacza usługę jako Beta i opisuje dostarczanie co najmniej raz. Wymaga to deduplikacji po stronie aplikacji. Nie trzeba wdrażać jednocześnie Queues i Workflows, jeśli jedna usługa wystarczy dla wybranego przepływu. [Vercel Queues](https://vercel.com/docs/queues)

Zwykłe Vercel Functions mają limity czasu i pamięci zależne od planu oraz konfiguracji. API powinno szybko zwracać identyfikator zadania; wykonanie AI i eksportu nie może zależeć od utrzymywania pojedynczego połączenia z panelem. Przy prototypie PDF trzeba sprawdzić czas renderowania, fonty, rozmiar zależności i zużycie pamięci, a gotowy plik zapisać w magazynie obiektowym. [Limity Vercel Functions](https://vercel.com/docs/functions/limitations)

Wyszukiwanie może rozpocząć od PostgreSQL, słownika synonimów PL/EN, normalizacji znaków i indeksów. `pg_trgm` zapewnia porównywanie podobieństwa tekstu, a `unaccent` usuwa diakrytyki. Dostępność rozszerzeń trzeba sprawdzić u wybranego dostawcy; same rozszerzenia nie zastępują testów trafności ani słownika kulinarnego. [PostgreSQL pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html), [PostgreSQL unaccent](https://www.postgresql.org/docs/current/unaccent.html)

Przepływ redakcyjny: zapis szkicu → niezmienny zapis wejścia zadania → analiza AI → przegląd administratora → tłumaczenie i ilustracja → podgląd → ręczna publikacja. Część etapów można uruchamiać oddzielnie. Wynik zadania rozpoczętego dla starej rewizji trafia do historii i nie nadpisuje nowszych zmian.

Publikacja powinna w transakcji sprawdzić rewizję, wymagane akceptacje i zasoby, utworzyć niezmienny snapshot, a następnie przełączyć wskaźnik aktualnej publikacji. Oczekująca operacja unieważnienia cache musi być trwała i ponawiana po błędzie. Snapshot zamraża również używane etykiety składników, metadane i wersje przeliczników.

## Uzupełnienia potrzebne przed implementacją

| Miejsce w specyfikacji | Niejednoznaczność lub ryzyko | Proponowane rozstrzygnięcie |
| --- | --- | --- |
| 7.2–7.3 | Swobodne pozycje warstw a telefon i druk | Ustalić dozwolone strefy, ustawienia wariantów i granice edytora |
| 8.1, 8.3, 12 | Przepisy bez liczby osób: sztuki albo formy | Dodać jawny typ podstawy skalowania i wielkość bazową; porcje oraz uzysk przechowywać osobno |
| 8.4 | `manual_review` bez opisanej struktury wariantów | Zapisywać zatwierdzone warianty partii i ograniczać selektor do nich |
| 8.6, 9 | Ilości zapisane wewnątrz instrukcji | Używać typowanych odwołań do składników, czasów i temperatur w obu językach |
| 4.1–4.2 | Wyróżnienie, podobieństwo i akceptacja wyszukiwania | Ręczne wyróżnianie, jawne reguły podobieństwa i testowe zapytania PL/EN z literówkami |
| 5.1, 5.5 | Archiwizacja, kosz i publiczna wersja | Osobno zdefiniować skutki każdej operacji oraz zachowanie dawnych slugów |
| 5.5 | „P1 może dodać datę publikacji” | Czas faktycznej publikacji jest potrzebny w P0; P1 powinno dotyczyć zaplanowania publikacji |
| 5.5, 10 | Wycofanie a istniejące PDF i adresy zasobów | Ustalić zasady dalszego pobierania, wygaśnięcia linków i utrzymywania historii |
| 6.4, 12 | Pochodzenie poszczególnych informacji | Dodać relację źródła z polem lub krokiem, jeśli śledzenie ma być tak szczegółowe |
| 6.5, 18 | Odbiór jakości AI oraz rezerwacja budżetu | Ustalić zestaw 20–30 przepisów, mierniki jakości i twarde ograniczenia każdego zlecenia |
| 14 | Znaczenie loginu i pierwszy administrator | Wybrać e-mail, nazwę użytkownika lub oba; opisać nadawanie dostępu i odzyskiwanie |
| 15.2, 17, 20 | Obciążenie i utrzymanie | Uzgodnić region, profil ruchu, budżet, opiekuna oraz proponowane RPO/RTO |

Szablony wydruku trzeba opracowywać równolegle z modelem danych. Serwerowy PDF jest oddzielną funkcją od opcji „Zapisz jako PDF” w przeglądarce. Pełne P0 wymaga eksportu serwerowego wskazanego w rozdziale 10.

## Kolejność realizacji

| Etap | Wynik do sprawdzenia | Co potwierdza |
| --- | --- | --- |
| 1. Fundament i projekt | Model danych, kalkulator, katalog i przepis na telefonie oraz komputerze, jeden szablon i wydruk | Czy dane i kierunek wizualny działają razem |
| 2. Pierwsze wdrożenie testowe | Działający katalog PL/EN, reprezentatywne przepisy, porcje, jednostki, ulubione i druk przeglądarkowy | Responsywność, przepływ czytelnika i uruchomienie na Vercel |
| 3. Przepływ redakcyjny | Konta, formularz, szkice, akceptacje, niezmienne publikacje i historia | Czy można bezpiecznie prowadzić książkę kucharską |
| 4. AI | Analiza własnego tekstu, propozycja z nazwy ze źródłami, tłumaczenia, ilustracje, zadania i limity | Jakość wyników, koszty i odporność na błędy |
| 5. Domknięcie P0 | Trzy szablony, edytor, serwerowy PDF, zgłoszenia i wszystkie kryteria odbiorowe | Gotowość pełnego wydania produkcyjnego |

Etapy są rekomendowaną kolejnością prac. Nie przenoszą istniejących wymagań P0 do P1. Funkcje niewykonane przy pierwszym deployu muszą być wskazane jako brakujące; działająca demonstracja nie jest odbiorem produkcji.

Pierwszy pełny przepływ należy zweryfikować na rzeczywistym przepisie: zapis → PL/EN → ilustracja → publikacja → zmiana porcji i jednostek → wydruk. Następnie sprawdzić zupę, wypiek, zakresy, „do smaku”, pół jajka oraz długi wariant EN. Dane demonstracyjne nie mogą otrzymać oznaczenia „sprawdzony w kuchni” bez testu redaktora.

## Wdrożenie na Vercel

1. Utworzyć aplikację i repozytorium, zapisać zależności oraz instrukcję uruchomienia.
2. Przywrócić dostęp do konta Vercel i wybrać właściwy zespół oraz projekt.
3. Oddzielić konfigurację testową od docelowej: baza, zasoby, klucze i limity AI.
4. Wykonać pierwszy deploy testowy bez podłączania docelowej domeny; sprawdzić dostępność i ochronę środowiska na wybranym planie.
5. Zweryfikować przeglądanie, języki, kalkulator, układ mobilny, obrazy i wydruk pod rzeczywistym adresem.
6. Po zakończeniu P0 przejść odbiór produkcyjny, odtworzyć kopię danych, skonfigurować monitoring i uruchomić docelową domenę.

Aktualna dokumentacja Vercel podaje, że pierwszy deploy nowego projektu jest zawsze oznaczany jako Production, również gdy użyto `vercel` bez `--prod`. Kolejne wdrożenia stosują normalne reguły Preview i Production. Dlatego określenie „testowe” opisuje tutaj cel i oddzielną konfigurację, a nie gwarantowany typ pierwszego deploymentu. [Vercel: środowiska i pierwszy deploy](https://vercel.com/docs/deployments/environments#first-deployment)

Sprawdzenie dostępu w tej sesji: połączenie Vercel w Codex zwróciło konieczność ponownego uwierzytelnienia. `vercel whoami` również zgłosiło nieważny token. Nie dało się potwierdzić zespołu, planu ani projektów. Odnowienie połączenia albo lokalne `vercel login` jest potrzebne przed wdrożeniem. Sekretów nie należy wklejać do dokumentacji projektu.

## Weryfikacja i budżet

Najbardziej wartościowe testy dotyczą kalkulatora, dostępu do szkiców, atomowej publikacji, konfliktów edycji, powtórzenia zlecenia AI i zgodności PDF z podglądem. Trzeba przejść przykłady rozdziału 8 oraz AC01–AC17. Test długiego przepisu obejmuje 30 składników i 15 kroków. Dostępność i wydruk wymagają również oceny ręcznej.

Przed odbiorem ustalamy liczbę równoczesnych czytelników, administratorów i generacji. Zbiór 10 000 przepisów określa rozmiar danych, lecz nie zastępuje profilu obciążenia. Wyniki laboratoryjne nie potwierdzają jeszcze Core Web Vitals w rzeczywistym ruchu.

Budżet obejmuje osobno hosting, bazę i kopie, magazyn oraz transfer obrazów/PDF, wykonanie zadań, AI tekstowe, wyszukiwanie źródeł i obrazy. Koszt przepisu zależy także od liczby wariantów i ponowień. Wiarygodną estymację należy przygotować po próbie 20–30 przepisów i sprawdzeniu wybranego planu. Awaria lub wyczerpanie budżetu AI nie może blokować czytania opublikowanych przepisów.

Przed implementacją warto rozstrzygnąć przede wszystkim nazwę marki, rodzaj loginu, posiadane usługi, region danych, miesięczny limit kosztów, źródło przepisów startowych i granice edytora. Docelowa domena jest ustalona: **jesie.pl**. Demo pozostaje dostępne pod adresem Vercel do docelowego uruchomienia.
