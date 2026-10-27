> Materiał historyczny z wcześniejszych etapów projektu. Aktualny stan, konfigurację i granice publikacji opisują [przekazanie](docs/claude-code-handoff.md), kod i bieżące runbooki; nie traktuj dawnych planów jako aktywnego zachowania.

# Specyfikacja interaktywnej książki kucharskiej

Dokument funkcjonalny i techniczny dla projektanta oraz developera

Wersja 1.0 • 3 października 2026 • Język dokumentacji polski

## 1 Cel aplikacji i założenia

Aplikacja ma być publiczną, dwujęzyczną książką kucharską z autorskim wyglądem i prywatnym panelem administratora. Administrator dodaje pełny przepis albo nazwę potrawy. System pomaga opracować treść, znaleźć źródła, rozpoznać kategorie, przygotować wersje polską i angielską oraz wygenerować ilustracje. Administrator poprawia i zatwierdza materiał przed publikacją. Czytelnik przegląda przepisy, wybiera porcje oraz jednostki i drukuje przepis z wizualizacją.

Dokument służy do zaprojektowania aplikacji, podziału prac, przygotowania wyceny i odbioru wdrożenia. Opisuje proponowany zakres, a nie już istniejący system. Wymagania oznaczone P0 tworzą pierwszą wersję produkcyjną. P1 i P2 są rozszerzeniami i powinny otrzymać osobną wycenę.

### 1.1 Ustalenia wynikające z zamówienia

- Strona i przepisy działają w językach polskim oraz angielskim.
- Administrator loguje się indywidualnym loginem i hasłem.
- Dodanie przepisu jest możliwe przez podanie jego treści albo samej nazwy dania.
- AI pomaga zweryfikować lub wyszukać przepis i przypisuje wiele kategorii do jednej potrawy.
- Każdy opublikowany przepis otrzymuje estetyczną, edytowalną wizualizację.
- Użytkownik zmienia porcje i jednostki metryczne lub UK oraz drukuje aktualny wariant z grafiką.
- Część publiczna i panel administratora mają być spójne wizualnie, responsywne i nowoczesne.

### 1.2 Proponowane założenia do wyceny

Pierwsza wersja jest jednym serwisem jednej marki. Czytanie nie wymaga konta. Nie zawiera płatności, sklepu ani publicznego dodawania przepisów. Właściciel może nadać dostęp kilku administratorom. P0 ma prostą flagę właściciela do zarządzania kontami i budżetem; rozbudowane role redakcyjne są w P1. Publikację zawsze zatwierdza człowiek.

Angielski przyjmuje wariant en-GB, polski pl-PL. Wybór języka jest niezależny od wyboru jednostek. Początkowo wdrażamy jeden dopracowany system wizualny i trzy kontrolowane szablony kart. Zakładamy do 10 000 opublikowanych przepisów jako skalę do testów; rzeczywisty ruch i limity generowania trzeba doprecyzować przed wyceną infrastruktury.

Domyślna interpretacja wizualizacji to interaktywna karta przepisu z ilustracją dania, składnikami i krokami. Ten sam zestaw danych zasila uproszczony, przeznaczony do druku układ infografiki. Pełny edytor dowolnych plakatów i projektów graficznych nie jest wymagany w P0.

### 1.3 Najważniejsze decyzje projektowe

| Decyzja | Przyjęte rozwiązanie | Uzasadnienie |
| --- | --- | --- |
| Edytowalna wizualizacja | Ilustracje AI jako zasoby i osobno edytowalne warstwy tekstu oraz układu | Zmiana języka i porcji nie wymaga ponownej generacji obrazka |
| Źródło ilości | Jeden wspólny model liczb, jednostek i składników | PL i EN nie mogą mieć różnych proporcji |
| Przeliczanie | Deterministyczny kalkulator aplikacji | Wynik jest powtarzalny i możliwy do testowania |
| Publikacja | Zatwierdzona, niezmienna wersja treści i zasobów | Edycja szkicu nie psuje publicznego przepisu |
| AI | Zadania w tle z kontrolą kosztów i akceptacją człowieka | Długie zadania i błędy nie blokują pracy redaktora |
| Pierwsze wdrożenie | Modułowa aplikacja i osobny proces zadań | Ograniczenie kosztów i złożoności utrzymania |

## 2 Zakres i priorytety

P0 oznacza funkcję wymaganą na uruchomienie. P1 oznacza kolejny etap po sprawdzeniu pierwszej wersji. P2 oznacza pomysł do dalszego rozwoju. Każdy etap obejmuje projekt, implementację i testy swoich funkcji.

| Obszar | P0 pierwsza wersja | P1 kolejny etap | P2 rozwój |
| --- | --- | --- | --- |
| Katalog | Kategorie, wyszukiwarka, filtry, podobne przepisy | Kolekcje, sezonowość, wyszukiwanie po zawartości lodówki | Planowanie jadłospisów |
| Przepis | PL i EN, porcje, metryczne i UK, druk oraz PDF | Rozbudowane zamienniki, warianty dietetyczne, skalowanie form | Dopasowanie do preferencji użytkownika |
| Gotowanie | Odznaczanie składników i kroków, proste timery | Tryb pełnoekranowy, działanie wybranych przepisów offline | Sterowanie głosem |
| Ulubione | Lokalne zapisanie w przeglądarce | Konto i synchronizacja między urządzeniami | Współdzielone kolekcje |
| Zakupy | Skopiowanie składników jednego przepisu | Lista zbiorcza, grupowanie, eksport | Integracja z dostawcą zakupów |
| Redakcja | Formularz, AI, wersje, przegląd PL i EN, podgląd i publikacja | Import URL i dokumentów, OCR zdjęć, import zbiorczy, harmonogram | Złożony proces redakcyjny z wieloma rolami |
| Grafika | Ilustracje AI, kontrolowane szablony, edytor warstw, PDF | Rozbudowana biblioteka zasobów, eksport SVG i zestawów społecznościowych | Dowolne szablony tworzone przez projektanta w aplikacji |
| Społeczność | Formularz zgłoszenia błędu z limitem i moderacją | Oceny, komentarze i zdjęcia po moderacji | Publiczne przepisy użytkowników |
| Dane żywieniowe | Miejsce w modelu i ręczne wartości z pochodzeniem | Obliczenia z wybranej bazy produktów | Spersonalizowane cele żywieniowe |

W P0 wszystkie funkcje podstawowe działają bez konta czytelnika. Lokalne ulubione i postęp gotowania nie gwarantują synchronizacji i mogą zostać usunięte przy wyczyszczeniu danych przeglądarki. Nie należy uzależniać kalkulatora porcji od wywołania płatnego modelu AI.

## 3 Kategorie i metadane przepisów

Kategorie są stabilnym słownikiem. Przepis może należeć do dowolnej sensownej liczby kategorii, ale musi mieć co najmniej jedną oraz kategorię główną do prezentacji. Kategoria główna musi należeć do zbioru wybranych kategorii.

| Identyfikator | Polska nazwa | Angielska nazwa |
| --- | --- | --- |
| breakfast | Śniadanie | Breakfast |
| brunch | Brunch | Brunch |
| lunch | Lunch | Lunch |
| starter | Przystawka | Starter |
| soup | Zupa | Soup |
| main | Główne danie | Main course |
| dessert | Deser | Dessert |
| afternoon | Podwieczorek | Afternoon treat |
| snack | Przekąska | Snack |
| dinner | Kolacja | Dinner |

Kategorie opisują zastosowanie dania i mogą się nakładać. Zupa może należeć do lunchu i kolacji. Kategoria „główne danie” opisuje rolę w posiłku; „kolacja” okazję. Angielskie tłumaczenia lunch i dinner należy traktować jako etykiety nawigacji, a nie sztywne reguły godziny spożycia.

AI proponuje kategorie wraz z krótkim uzasadnieniem. Administrator może zmienić każdy wybór. Wynik modelu podający własną ocenę pewności nie jest prawdopodobieństwem potwierdzającym poprawność. Kategorie spoza słownika są odrzucane.

Dodatkowe metadane obejmują kuchnię, sezon, składniki dominujące, technikę, sprzęt, trudność, czas aktywny, czas obróbki, odpoczynek i czas całkowity. Tagi dietetyczne i alergeny otrzymują stan „do sprawdzenia”, „sprawdzone” albo „nieustalone”. Nie wolno wnioskować „bez alergenów” wyłącznie z braku znalezionego alergenu.

## 4 Część publiczna

### 4.1 Nawigacja i ekran główny

Na ekranie głównym znajdują się wyróżnione przepisy, wyszukiwanie i dziesięć kategorii. P1 dodaje kolekcje redakcyjne. Karty pokazują danie, tytuł, czas, trudność i podstawowe oznaczenia. Na telefonie układ zachowuje duże zdjęcia, czytelne teksty i wygodne przyciski. Filtry są dostępne w wysuwanym panelu, a aktywne ustawienia można łatwo usunąć.

Adresy publiczne mają warianty /pl/ i /en/. Przełączenie języka na stronie danego przepisu otwiera jego odpowiednik i zachowuje porcje oraz jednostki. Nie powoduje powrotu na stronę główną. Nie należy automatycznie przekierowywać każdego wejścia zgodnie z językiem przeglądarki.

### 4.2 Wyszukiwanie i filtrowanie

Wyszukiwarka obejmuje tytuły, nazwy składników i ich synonimy. Ma obsługiwać polskie znaki, proste literówki i równoważne nazwy PL i EN. W wynikach pokazuje tłumaczenie w wybranym języku. Powinna umożliwiać filtrowanie kategorii, maksymalnego czasu, trudności, kuchni, składnika i zweryfikowanego tagu dietetycznego.

Wybór kilku kategorii w jednej grupie działa jako OR, a różne grupy filtrów jako AND. Wykluczenie składnika jest widoczne i możliwe do cofnięcia. Filtr alergenu oznacza „przepis nie zawiera wskazanego alergenu według sprawdzonego składu”; nie jest gwarancją dotyczącą śladów i produktu konkretnej marki. Przepisy z nieustalonym składem nie trafiają do wyników przedstawianych jako odpowiednie po takim wykluczeniu.

Sortowanie P0 obejmuje trafność, najnowsze i najkrótszy czas. Popularność może zostać dodana po zebraniu rzeczywistych danych. Stan filtrów jest zapisany w URL, aby wynik można było udostępnić. Brak wyników pokazuje aktywne ograniczenia i umożliwia ich usunięcie.

### 4.3 Strona przepisu

Strona zawiera tytuł, opis, ilustrację lub zdjęcie, kategorie, czas, trudność, porcje, sprzęt, składniki w grupach, kolejne kroki, porady, informacje o przechowywaniu, pochodzenie i autora. Wartości nieustalone są wyraźnie opisane lub pomijane, zamiast otrzymywać zmyślone liczby.

Kontrolki porcji, jednostek, języka, druku i przejścia do składników są widoczne bez przewijania całego artykułu. Długie wprowadzenie redakcyjne nie poprzedza wszystkich czynności praktycznych. Czytelnik może odznaczać składniki i ukończone kroki. Zmiana ilości nie usuwa zaznaczeń; zmiana wersji przepisu informuje o konieczności ponownego sprawdzenia listy.

Wizualizacja pokazuje te same ilości co lista i instrukcja. Fotografia rzeczywistego dania oraz ilustracja wygenerowana przez AI mają osobne oznaczenia i teksty alternatywne. Oznaczenie „sprawdzony w kuchni” wymaga ręcznego potwierdzenia administratora, daty oraz notatki z testu.

### 4.4 Pomoc podczas gotowania

P0 obejmuje widok czytelnych kroków, odznaczanie postępu i timery uruchamiane z kroków posiadających czas. Timer oblicza pozostały czas z zapisanego czasu zakończenia, aby powrót z uśpienia nie zmieniał jego wskazania. Powiadomienie dźwiękowe zależy od uprawnień przeglądarki; jego brak nie blokuje przepisu.

P1 dodaje powiększony tryb gotowania, opcjonalne utrzymanie aktywnego ekranu tam, gdzie przeglądarka na to pozwala, i zapis wybranych przepisów offline. Aplikacja pokazuje, że jest to zapisana wersja i jaka jest data zapisu.

### 4.5 Ulubione i zakupy

W P0 czytelnik zapisuje ulubione lokalnie i kopiuje listę składników aktualnie przeliczonych dla jednego przepisu. P1 może dodać konto czytelnika, foldery oraz zbiorczą listę zakupów. Ilości można sumować tylko wtedy, gdy chodzi o ten sam składnik, jego postać i zgodne jednostki. Nie wolno automatycznie łączyć surowego ryżu z ugotowanym ani gramów z łyżkami bez zatwierdzonego przelicznika.

## 5 Panel administratora

### 5.1 Ekrany i codzienna praca

Panel zawiera przegląd statusów publikacji, listę przepisów, formularz dodawania, edytor przepisu, zakładki PL i EN, przegląd uwag AI, edytor wizualizacji, bibliotekę zasobów, zadania AI, ustawienia słowników, historię zmian i ustawienia konta.

Lista przepisów umożliwia filtrowanie statusu, kategorii, braków tłumaczenia i błędów zadań. Pokazuje ostatniego edytora, datę zmian oraz to, czy publiczna wersja różni się od szkicu. Dostępne operacje to utworzenie, duplikacja, archiwizacja, cofnięcie publikacji i przywrócenie wersji. Usunięcie odbywa się najpierw do kosza; okres zachowania jest konfigurowalny.

Formularz automatycznie zapisuje zmiany i pokazuje stan zapisu. Zamknięcie niezapisanego formularza wymaga ostrzeżenia. Równoczesna edycja wykrywa konflikt wersji i umożliwia porównanie zmian. Nie nadpisuje bez komunikatu pracy drugiej osoby.

### 5.2 Dodanie pełnego przepisu

Administrator wybiera tryb „Mam przepis”, wpisuje nazwę, wkleja treść i może dodać własne zdjęcie. System zachowuje oryginał i tworzy roboczą, uporządkowaną wersję. AI nie zastępuje oryginału bez śladu.

Analiza wskazuje brakujące ilości, niejasne jednostki, składniki pominięte w krokach, kroki z nieobecnym składnikiem, konflikty czasu i proporcji oraz kwestie wymagające sprawdzenia. Każda propozycja ma uzasadnienie i przyciski przyjęcia, zmiany lub odrzucenia. Gdy opis jest niejednoznaczny, system prosi o uzupełnienie w panelu.

### 5.3 Dodanie tylko nazwy potrawy

Administrator wybiera tryb „Znajdź przepis”, wpisuje nazwę i opcjonalnie kuchnię, wariant, dietę, liczbę porcji albo preferowane źródło. Przy wieloznacznej nazwie system przedstawia warianty, np. klasyczny, regionalny lub wegetariański. Administrator wybiera jeden przed rozwinięciem przepisu i wygenerowaniem kosztownych grafik.

System wyszukuje źródła, pokazuje ich adresy i opracowuje propozycję z oznaczeniem pochodzenia. Brak wiarygodnego wyniku kończy się czytelną informacją. Administrator może zdecydować o przygotowaniu autorskiej propozycji AI, która pozostaje oznaczona jako taka i wymaga sprawdzenia. Nie wolno przedstawiać wygenerowanego przepisu jako pochodzącego z nieistniejącego źródła.

### 5.4 Zawartość formularza

| Grupa | Najważniejsze pola | Warunek publikacji |
| --- | --- | --- |
| Tożsamość | Tytuły PL i EN, slugi, opis, autor | Oba języki, unikalne adresy |
| Klasyfikacja | Kategorie, kategoria główna, tagi | Minimum jedna kategoria |
| Wydajność | Porcje i opcjonalna liczba sztuk lub masa, opis porcji | Dodatnia baza i jawna miara selektora |
| Składniki | Składnik, postać, ilość, jednostka, grupa, uwagi | Rozpoznany składnik i poprawna ilość lub jawny opis |
| Przygotowanie | Kolejność, teksty PL i EN, powiązania, czasy i temperatury | Co najmniej jeden kompletny krok |
| Parametry | Czasy, trudność, sprzęt, rozmiar formy | Brak sprzecznych wartości |
| Informacje | Alergeny, przechowywanie, źródła i prawa | Krytyczne uwagi rozstrzygnięte |
| Wizualizacja | Ilustracja główna, warstwy, szablon, opis alternatywny | Gotowy podgląd mobilny i wydruk |
| Redakcja | Status, uwagi AI, akceptacja językowa | Zatwierdzona bieżąca wersja |

Administrator może pozostawić niekrytyczne pole niewypełnione. Nie powinien być zmuszany do wymyślania kalorii, kosztu dania lub sposobu przechowywania wyłącznie po to, aby przejść formularz.

### 5.5 Publikacja i historia

Status redakcyjny przyjmuje wartości draft, in_review, approved i archived. Stan publikacji jest osobny: never_published, published lub unpublished. Zadania AI mają własne statusy, dlatego błąd grafiki nie zmienia automatycznie statusu publicznej wersji.

Publikacja wymaga zatwierdzenia treści PL i EN, kategorii, modelu ilości, źródeł, ilustracji i aktualnych uwag krytycznych. Zapisuje niezmienny zestaw danych oraz identyfikatory wszystkich zasobów. Nowa edycja tworzy szkic nad nadal dostępną publiczną wersją. Cofnięcie wersji publicznej nie usuwa historii i nie przywraca automatycznie starego hasła ani ustawień kont.

Przywrócenie historycznej wersji do szkicu wymaga ponownej akceptacji przed publikacją. Osobna akcja „Cofnij publiczną wersję” przełącza na wcześniejszy, już zatwierdzony snapshot w całości. Publikacja, cofnięcie i wycofanie odświeżają publiczny HTML, API, katalog, mapę strony i cache. Własny cache musi respektować wycofanie przepisu w uzgodnionym czasie, proponowane maksymalnie 60 sekund. Serwis nie gwarantuje usunięcia kopii zapisanych przez czytelnika lub zewnętrzne wyszukiwarki.

P1 może dodać datę publikacji, podgląd przyszłych wersji i rozdzielone role redaktora oraz osoby zatwierdzającej. Akcje masowe nie mogą omijać warunków publikacji pojedynczego przepisu.

## 6 Proces AI

### 6.1 Zadania i kolejność

1. Zapis wejścia oraz identyfikatora wersji szkicu.
2. Rozpoznanie intencji: analiza własnego przepisu albo wyszukanie potrawy.
3. Wyszukanie i zapis źródeł, jeżeli jest potrzebne; rozstrzygnięcie wariantu dania.
4. Normalizacja do walidowanego schematu danych przepisu.
5. Kontrole mechaniczne i przegląd AI z listą uwag.
6. Propozycja kategorii, metadanych, słownika składników i tłumaczeń.
7. Akceptacja modelu przepisu przez administratora.
8. Przygotowanie briefu wizualnego, generowanie ilustracji i ułożenie szablonu.
9. Podgląd wszystkich wariantów oraz ręczne zatwierdzenie.
10. Atomowa publikacja spójnej wersji PL i EN.

Generowanie ilustracji następuje po zatwierdzeniu składników i rodzaju potrawy. Zmiana etykiety lub koloru nie uruchamia nowej generacji. Zmiana potrawy albo jej kluczowego składnika oznacza zasoby jako wymagające przeglądu.

### 6.2 Rozdzielenie odpowiedzialności

| Zadanie | Rodzaj rozwiązania | Oczekiwany wynik |
| --- | --- | --- |
| Pozyskanie źródeł | Wyszukiwanie web przez serwer | Adresy, pochodzenie i materiał do analizy |
| Analiza i klasyfikacja | Model tekstowy z wynikiem strukturalnym | Dane przepisu, kategorie i uwagi |
| PL i EN | Model językowy i słownik kulinarny | Teksty bez zmiany identyfikatorów i liczb |
| Ilustracje | Model generowania obrazów | Zasoby potraw i składników |
| Kompozycja | Szablony i silnik aplikacji | Edytowalna scena i responsywny widok |
| Jednostki i porcje | Kod z wersjonowanymi tabelami | Powtarzalne wartości liczbowe |
| Publikacja | Reguły aplikacji i administrator | Zatwierdzona wersja publiczna |

Modele i dostawcy są konfigurowalni. Developer tworzy warstwę integracji, aby można było zmienić model bez przebudowy danych. Przy rozpoczęciu implementacji należy porównać aktualne modele na próbce rzeczywistych przepisów. Cena, opóźnienie i jakość zależą od wybranego dostawcy; dokument nie zamraża nazwy „najlepszego” modelu.

Wynik zgodny ze schematem nie potwierdza prawdziwości treści. Structured Outputs pomaga wymusić format; odmowa modelu, odpowiedź ucięta i błąd schematu mają odrębne przyczyny błędu zadania. To uzasadnia osobną walidację i przegląd redakcyjny. [Dokumentacja Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

### 6.3 Co oznacza weryfikacja przepisu

Kontrole aplikacji obejmują dodatnie porcje, poprawne jednostki, istniejące powiązania kroków, kompletność języków, zgodność kategorii, logiczne zakresy i brak duplikatów. AI analizuje spójność kulinarną i wskazuje rzeczy wymagające potwierdzenia. Zgodność proporcji z innym przepisem jest przesłanką, nie dowodem udanego gotowania.

Uwagi mają poziom blocking, warning albo info. Każda zawiera pole, problem, proponowaną zmianę, pochodzenie i rozstrzygnięcie. Aplikacja może dopuścić publikację po świadomym odrzuceniu uwagi merytorycznej z uzasadnieniem, ale nie pozwala ominąć błędu schematu, braku języka lub niespójnych zasobów.

### 6.4 Źródła i pochodzenie

Każde źródło przechowuje URL, tytuł, autora jeżeli znany, datę dostępu, rodzaj wykorzystania i informację o uprawnieniu do użycia tekstu lub zdjęcia. Administrator widzi, które twierdzenia pochodzą ze źródła, które podał sam, a które dopowiedziało AI. Brak ustalenia pochodzenia jest widoczny.

Wyszukiwanie powinno zachować odsyłacze zwrócone przez dostawcę. Interfejs prezentuje czytelnikowi źródła tam, gdzie przepis lub informacja rzeczywiście się na nich opiera. Aktualna integracja web search udostępnia odwołania do materiałów źródłowych. [Dokumentacja web search](https://developers.openai.com/api/docs/guides/tools-web-search)

Samo znalezienie strony nie przyznaje praw do skopiowania jej tekstu ani fotografii. Domyślnie system opracowuje własną treść na podstawie dopuszczonych materiałów, zachowuje przypisanie źródeł i nie pobiera chronionych zdjęć jako własnych zasobów. Zakres ponownego wykorzystania treści ustala właściciel serwisu.

### 6.5 Stabilność i koszt

Zadanie ma identyfikator, niezmienny snapshot wejścia z rewizją i hashem, etap, próbę, status, model, czas i koszt. Administrator widzi kolejkę, bieżący etap, błąd i możliwość wznowienia lub zatrzymania dalszych etapów. Anulowanie nie gwarantuje cofnięcia opłaty za rozpoczęte wywołanie. Odświeżenie strony nie tworzy drugiego zlecenia. Po zmianie wejścia stary wynik trafia do historii i nie nadpisuje nowego szkicu.

Limity obejmują budżet dzienny i miesięczny, liczbę wariantów obrazu, maksymalny rozmiar wejścia i czas zadania. Przed zleceniem system transakcyjnie rezerwuje konserwatywnie oszacowany koszt według ograniczeń zlecenia. Równoległe zadania uwzględniają rezerwacje; po zakończeniu rozliczany jest rzeczywisty koszt i zwalniana niewykorzystana część. Przekroczenie zatrzymuje nowe generowanie, zachowuje dane i pokazuje komunikat. Ponowienie dotyczy błędów przejściowych; odmowa modelu lub zły schemat wymagają jawnej obsługi. Nie wolno bez ograniczeń ponawiać kosztownych generacji.

## 7 Wizualizacja i kierunek estetyczny

### 7.1 Interpretacja załączonej referencji

Referencja IMG_3411.JPG sugeruje ciepłą biel, odcienie masła i złota, zielone akcenty, dużo światła, duże ilustracje potraw, miękkie cienie i starannie uporządkowane moduły informacji. Jest inspiracją dla wyglądu. Jej drobne, nieczytelne teksty i ozdobne wykresy nie wyznaczają funkcji aplikacji.

Projekt powinien zachować apetyczne ilustracje i poczucie pięknej książki, przy większej czytelności. Informacje o czasie, składnikach i krokach muszą mieć praktyczny sens. Panel administratora korzysta z tej samej typografii i palety, lecz zapewnia więcej miejsca na formularze i porównywanie treści.

Proponowany system: jasne tło, ciemny tekst, paleta kremu i szałwii, jeden akcent ochry, czytelny krój do treści i subtelny krój redakcyjny do tytułów. Tekst receptury ma punkt wyjścia 16–18 px i interlinię około 1,5, a główne przyciski dotykowe cel 44 × 44 px. Projektant dobiera fonty z prawami do użycia w web i PDF. Delikatny ruch służy zmianie stanu i można go ograniczyć ustawieniami użytkownika. Nie wymaga się kosztownej sceny 3D ani WebGL.

Odbiór projektu wizualnego obejmuje zatwierdzone makiety katalogu, przepisu i panelu dla desktopu oraz telefonu, a także jeden wydruk A4. Makiety korzystają z rzeczywistego przepisu PL i EN. Biblioteka grafik zachowuje uzgodnione światło, perspektywę, kadrowanie i charakter cieni. Stan zapisu, uwagi AI i gotowość publikacji są stale łatwe do odnalezienia w edytorze.

### 7.2 Co można edytować

Wizualizacja składa się z tła, ilustracji dania, ilustracji składników, nagłówków, ilości, opisów, ikon i bloków kroków. Administrator może zmienić szablon, pozycję i kolejność elementów, skalę, kadr, dopuszczone kolory, treść opisów oraz widoczność dekoracji. Powinien mieć cofnij, ponów, reset szablonu, blokowanie warstwy i podgląd telefonu oraz druku.

Ilustracja wygenerowana przez model jest bitmapą. Jej piksele można zastąpić albo przegenerować, a nie dowolnie edytować jak obiekty wektorowe. Model może tworzyć osobne obrazy na przezroczystym tle; generowanie obrazu nie jest gwarancją idealnego wycięcia i wymaga podglądu jakości. [Dokumentacja generowania obrazów](https://developers.openai.com/api/docs/guides/image-generation)

Liczby, nazwy i instrukcje nie są wypalane w obrazach. Warstwa tekstowa odwołuje się do pól przepisu. Jeśli administrator edytuje ilość z karty, edytuje właściwe dane składnika. Nie można stworzyć lokalnego tekstu „200 g”, gdy lista składników pokazuje „250 g”. Dekoracyjne etykiety niezwiązane z ilościami mogą być edytowane osobno.

### 7.3 Scena i szablony

Scena jest przechowywana jako wersjonowany JSON: identyfikatory warstw, typ, powiązanie z danymi, zasób, pozycja, rozmiar, styl, kolejność i wariant urządzenia. Kod aplikacji renderuje teksty w HTML lub bezpiecznym SVG. Publiczna treść przepisu zawsze istnieje również jako semantyczny tekst HTML.

P0 obejmuje trzy rodziny szablonów: „Danie w centrum”, „Składniki wokół dania” i „Przygotowanie krok po kroku”. Każda ma reguły desktopu, telefonu i czytelnego wydruku; są to warianty tego samego przepisu. Układ kroków może korzystać z ikon i zatwierdzonych ilustracji, bez wymogu generowania osobnego zdjęcia każdej czynności. Responsywność wynika z reguł szablonu, nie ze zmniejszenia całego plakatu do szerokości telefonu. Długie nazwy EN i PL zawijają się bez zasłaniania innych elementów. Zmiana proporcji zdjęcia nie może przesunąć przycisków podczas ładowania.

### 7.4 Zasady generowania ilustracji

Brief grafiki wykorzystuje zatwierdzone składniki, sposób przygotowania, podanie, styl marki, tło i format. Nie dodaje owoców, orzechów lub sosów wyłącznie dla efektu, jeżeli nie należą do przepisu. Administrator ocenia zgodność ilustracji i może dodać prawdziwe zdjęcie zamiast obrazu AI.

Zasób przechowuje oryginał, warianty rozdzielczości, identyfikator modelu, parametry zlecenia, prawa, opis alternatywny oraz wersję przepisu używaną do generacji. W P0 wystarczą wariant główny, miniatura i wersja do druku. Ponowne generowanie tworzy nowy identyfikator oraz klucz pliku. Nie nadpisuje pliku używanego w publikacji. Administrator widzi, który zasób zastępuje w szkicu i jaka publikacja nadal korzysta ze starego.

## 8 Jednostki i porcje

### 8.1 Model ilości

Przepis przechowuje jedną bazę skalowania i jeden wspólny model składników. Ilość ma typ exact, range lub qualitative oraz osobną flagę approximate dla zapisu „około”. Sztuka jest jednostką wymiaru count, nie odrębnym typem ilości. Osobno zapisuje jednostkę, oryginalny zapis, identyfikator składnika, postać składnika i tryb skalowania. Dla masy jednostką bazową jest gram, dla objętości mililitr, dla sztuk liczba sztuk. Nie należy przekształcać niejasnego zapisu do masy na podstawie przypuszczenia.

Typ qualitative obsługuje „do smaku”, „do posmarowania”, „w razie potrzeby” i „szczypta” bez udawania dokładności. Range ma dwie wartości i skaluje obie. Ilości powinny być zapisane jako liczby dziesiętne o kontrolowanej precyzji lub ułamki, a nie jako gotowy tekst. W API dokładne liczby są przesyłane jako decimal strings. Tłumaczenia odnoszą się do tego samego identyfikatora ilości.

Porcje i wydajność są osobnymi informacjami: 4 porcje mogą odpowiadać 12 ciastkom. Pola baseServings oraz opcjonalne yieldQuantity i yieldUnit przechowują to powiązanie; zmiana na 6 porcji daje 18 ciastek i współczynnik 1,5. Jeśli liczba osób jest nieustalona, selektor jawnie pokazuje wydajność, np. „sztuki”, zamiast udawać porcje. Zmiana wielkości partii nie jest zmianą sposobu podziału tej samej partii.

### 8.2 Profile jednostek

| Profil | Masa | Objętość | Temperatury i miary kuchenne |
| --- | --- | --- | --- |
| Metryczny | g, kg | ml, l | °C; łyżeczka i łyżka z jawną definicją |
| UK imperial | oz, lb | Imperial fl oz, pint, ewentualnie ml dla małych ilości | Domyślnie °C; opcjonalne °F; tsp 5 ml i tbsp 15 ml jako przyjęte miarki kuchenne |

Profil UK jest świadomie wybraną opcją wyświetlania imperialnego. Język angielski nie włącza go automatycznie. „oz” oznacza masę, „fl oz” objętość. Definicje Imperial i US muszą pozostać rozdzielone. „Cup” oraz polska „szklanka” wymagają konkretnej pojemności; pozycja bez takiej informacji trafia do przeglądu.

Nie wprowadza się domyślnego „UK cup”. Jeśli potrzebny jest kubek miarowy, administrator wybiera jawnie 250 ml albo standard źródłowy i użytkownik widzi tę pojemność. Miarki tsp 5 ml i tbsp 15 ml są konwencją produktu; nie należy podmieniać ich definicją US lub łyżką domową o nieznanej objętości.

Poniższe stałe są podstawą obliczeń, przed zaokrągleniem prezentacji. Jednostki masy oz i lb używają systemu avoirdupois. Relacje objętości odnoszą się do Imperial, a nie US. Współczynniki i ich definicje developer sprawdza względem źródeł metrologicznych. [NIST o przelicznikach jednostek](https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors/nist-guide-si-appendix-b8)

| Jednostka | Wartość w jednostce bazowej |
| --- | --- |
| 1 oz masy | 28,349523125 g |
| 1 lb | 453,59237 g i 16 oz |
| 1 Imperial fl oz | 28,4130625 ml |
| 1 Imperial pint | 568,26125 ml i 20 Imperial fl oz |
| 1 Imperial gallon | 4546,09 ml i 8 Imperial pint |
| 1 inch do wymiarów sprzętu | 25,4 mm |

Proponowany profil prezentacji r1: g i ml od 10 wzwyż do całej jednostki, od 1 do poniżej 10 z jednym miejscem dziesiętnym, poniżej 1 z co najmniej dwoma; oz, lb, fl oz i pint do dwóch miejsc dziesiętnych. Reguła to round-half-up wyłącznie w widoku. Końcowe zera można ukryć. Jeżeli zaokrąglenie przekracza 1% wartości, zwiększamy precyzję; dodatnia dawka nie może zostać pokazana jako zero. Dla bardzo małych ilości wskazujemy potrzebę odpowiedniej miarki. Składnik wrażliwy może otrzymać ręcznie zatwierdzony profil dokładności. Sztuki zachowują ułamek, np. ½, a „około” pozostaje widoczne. To decyzja produktu, nie uniwersalna norma kulinarna.

Różne granice zakresu nie mogą zniknąć w tej samej zaokrąglonej liczbie. Dla składnika dzielonego między kroki suma prezentowanych części musi odpowiadać prezentowanej całości albo pozostawać przedstawiona jako udziały tej całości.

### 8.3 Przeliczanie porcji

Współczynnik wynika z liczby docelowych porcji podzielonej przez liczbę bazową. Ilość docelowa składnika liniowego to ilość bazowa pomnożona przez ten współczynnik. Następnie wykonywana jest konwersja jednostki, a zaokrąglenie następuje wyłącznie w prezentacji. Każda zmiana zaczyna od wartości bazowej, nigdy od poprzednio zaokrąglonego wyniku.

Domyślny selektor umożliwia 1–24 porcje, z limitem konfigurowalnym i ograniczeniami konkretnego przepisu. Przepis może opisywać porcje, sztuki albo jedną formę. Dla sztuk można stosować krok całkowity, a dla ciasta w formie pokazać osobny opis i dostępne warianty. Administrator określa sprawdzony zakres skalowania; poza nim aplikacja informuje o potrzebie oceny techniki i sprzętu.

### 8.4 Wyjątki od prostego mnożenia

Czas pieczenia, temperatura, grubość produktu, minimalna ilość do pracy sprzętu i objętość naczynia nie skalują się automatycznie jak składniki. Model obsługuje tryby linear, fixed, qualitative oraz manual_review. Drożdże, zakwas, przyprawy i płyny do smażenia mogą wymagać ograniczeń charakterystycznych dla przepisu; aplikacja nie tworzy dla nich uniwersalnej reguły kulinarnej.

Tryb manual_review ogranicza selektor do zatwierdzonych wariantów partii. Żądanie innej liczby pokazuje potrzebę sprawdzenia i zachowuje poprzedni spójny wariant; system nie skaluje tylko części listy i nie drukuje niespójnego zestawu. Tryb fixed zachowuje ilość z objaśnieniem, np. tłuszcz do posmarowania formy.

Ułamki sztuk pozostają widoczne. Jeśli wynik daje pół jajka, instrukcja może wskazać odważenie części roztrzepanego jajka według zatwierdzonej masy. Bez tej informacji system nie zaokrągla go po cichu do całego. Składnik „jedna puszka” musi mieć masę produktu, ewentualnie masę po odsączeniu, albo pozostać sztuką z opisem. Ilość do kupienia może zostać zaokrąglona do opakowań, ale nie zmienia ilości do użycia w przepisie.

P1 może dodać skalowanie powierzchni formy przy zachowaniu grubości, ale nie zmienia automatycznie czasu obróbki. Rodzaj formy, wysokość i sprawdzone warianty pozostają częścią przepisu.

### 8.5 Masa i objętość

Konwersja między masą a objętością wymaga przelicznika konkretnego składnika i jego postaci, np. mąki sypanej lub ubitej. Przelicznik ma źródło, datę, sposób pomiaru i stan zatwierdzenia. Brak gęstości blokuje konwersję g ↔ ml, lecz nie blokuje przeliczenia g ↔ oz albo ml ↔ Imperial fl oz.

Należy wyświetlać, kiedy wynik jest przybliżeniem. Nie można używać gęstości wody dla wszystkich płynów i produktów sypkich. Przy zmianie składnika albo jego postaci dotychczasowy przelicznik wymaga ponownego sprawdzenia.

### 8.6 Liczby w krokach i temperatury

Instrukcja korzysta z powiązań do ilości składników, czasów i temperatur. Powiązana wartość aktualizuje się wraz z kalkulatorem. Ręcznie wpisane liczby w tekście podlegają kontroli, aby „dodaj 200 g mąki” nie pozostało w kroku po zmianie listy na 400 g.

Jeżeli krok wykorzystuje część składnika, zapisuje udział lub osobną ilość przypisaną do kroku. Udziały nie mogą łącznie przekraczać dostępnej ilości bez rozstrzygnięcia. Równoważność °C i °F jest czysto arytmetyczna: wartość °C mnożymy przez 9/5 i dodajemy 32. Dlatego 180 °C daje dokładnie 356 °F, choć przepis może wskazać zatwierdzoną nastawę 350 °F. Temperatury piekarnika z termoobiegiem oraz stopnie gas mark są osobnymi, sprawdzonymi wariantami; nie należy ich przedstawiać jako dokładnej uniwersalnej konwersji. Temperatura wewnątrz produktu jest osobnym polem.

Czas całkowity uwzględnia czynności wykonywane równolegle. Nie jest automatycznie sumą wszystkich timerów. Regułę lub wartość czasu całkowitego zatwierdza redaktor.

### 8.7 Przykłady odbiorowe kalkulatora

| Wejście | Działanie | Oczekiwany wynik |
| --- | --- | --- |
| 250 g dla 4 porcji | Zmiana na 6 porcji | 375 g we wszystkich powiązanych widokach |
| 20–30 ml dla 4 porcji | Zmiana na 2 porcje | 10–15 ml |
| 2 jajka dla 4 porcji | Zmiana na 1 porcję | ½ jajka i zatwierdzona wskazówka, bez cichego zaokrąglenia |
| Sól do smaku | Zmiana liczby porcji | Tekst pozostaje jakościowy |
| 100 g mąki bez gęstości | Żądanie ml | Brak zgadywania, propozycja pozostania przy masie |
| 180 °C i 30 minut | Podwojenie porcji | Temperatura i czas pozostają parametrami bazowymi |
| 250 g dla 4 porcji | Sekwencja 4 → 7 → 4 | Powrót dokładnie do 250 g |
| 568,26125 ml | Profil UK imperial | Dokładnie 1 pint przed prezentacją |
| Około 100 g | Podwojenie partii | Około 200 g |
| 180 °C | Zmiana na °F | 356 °F, bez zmiany trybu piekarnika |
| 0,3 g składnika | Zmiana profilu prezentacji | Dodatnia dawka, nigdy 0 g |

## 9 Dwa języki i spójność treści

Tłumaczone są tytuły, opisy, nazwy prezentowane składników, kroki, uwagi, teksty alternatywne, metadane SEO i komunikaty. Identyfikatory, wartości liczbowe, kategorie i powiązania pozostają wspólne. Słownik kulinarny obejmuje regionalne określenia, niejednoznaczne nazwy produktów oraz zapis typu „mąka pszenna typ 450” z opisem zrozumiałym po angielsku.

Administrator widzi PL i EN obok siebie albo w zsynchronizowanych zakładkach. Tłumaczenie AI można poprawić i oznaczyć jako sprawdzone. Zmiana źródłowego tekstu oznacza odpowiednie tłumaczenie jako wymagające przeglądu. Automatyczne tłumaczenie nie nadpisuje zatwierdzonych poprawek bez jawnego przyjęcia.

Na stronie publicznej publikowane są obie kompletne wersje. Brak EN blokuje publikację nowej wersji, pozostawiając poprzednią publiczną wersję. Slugi mogą być różne, ale prowadzą do wspólnego identyfikatora przepisu. Zmiana sluga tworzy przekierowanie ze starego adresu.

## 10 Drukowanie i eksport

P0 obejmuje podgląd wydruku, standardowe drukowanie przeglądarki i pobranie PDF z identycznego snapshotu danych. Dostępne są A4 i Letter, wariant z wizualizacją, oszczędny oraz tekstowy. Wariant domyślny zawiera grafikę, składniki i kroki, ale nie wymusza jednej strony kosztem czytelności.

Użytkownik wybiera język, porcje i profil jednostek przed eksportem. Zostają one utrwalone w wydruku wraz z tytułem, adresem przepisu, numerem wersji i datą wygenerowania. Zmiana ustawień w otwartej karcie nie może zmienić już wygenerowanego pliku PDF. Długie przepisy przechodzą na kolejne strony z powtórzeniem podstawowego nagłówka.

Układ ma marginesy bezpieczne dla domowych drukarek, czytelną skalę tekstu, podziały grup składników i rozsądne łamanie kroków. Nawigacja, filtry i przyciski nie trafiają do druku. Wariant oszczędny ogranicza tło i zużycie tuszu. Grafika do wydruku powinna mieć wystarczającą rozdzielczość dla docelowego rozmiaru; system ostrzega administratora przy zbyt małym zasobie.

PDF generowany na serwerze używa tego samego kalkulatora, szablonów i danych co podgląd, przy ustalonej wersji renderera oraz fontów. Klucz bufora obejmuje publicationId lub hash treści, język, porcje, jednostki, A4 albo Letter, wariant układu i wersje szablonu, renderera oraz fontów. Data w pliku oznacza utworzenie tego PDF, nie każde jego pobranie. Przy braku gotowego pliku API zwraca 202 oraz identyfikator zadania eksportu; odczyt statusu i pobranie nie generują drugiego zadania. Pobieranie PDF i równoległe renderowanie mają limity.

## 11 Architektura techniczna

### 11.1 Proponowany zestaw technologii

Rekomendowany punkt wyjścia to TypeScript i React z frameworkiem umożliwiającym renderowanie publicznych stron na serwerze, np. Next.js, relacyjna baza PostgreSQL, magazyn obiektowy zgodny z S3, CDN do zasobów i trwała kolejka zadań. Backend może być modułem tej samej aplikacji. Proces wykonujący długie zadania działa osobno i nie zależy od czasu otwarcia przeglądarki.

Wyszukiwanie początkowo korzysta z indeksów PostgreSQL, wyszukiwania pełnotekstowego i słownika synonimów. Osobny silnik wyszukiwania można dodać po pomiarze potrzeb. Edytor sceny może używać SVG albo biblioteki canvas, ale treść dostępna publicznie pozostaje w HTML. Developer wybiera wspierane wersje bibliotek, zapisuje je w projekcie i sprawdza licencje.

Wybór hostingodawcy, usługi uwierzytelniania i dostawcy AI jest decyzją wdrożeniową zależną od budżetu, regionu danych i kompetencji zespołu. Rozwiązanie powinno dawać możliwość wyeksportowania danych i oryginalnych zasobów.

### 11.2 Przepływ między komponentami

Przeglądarka korzysta z aplikacji publicznej lub panelu administratora. Backend autoryzuje operacje, zapisuje szkic w bazie i zleca zadanie. Worker pobiera zadanie, komunikuje się z dostawcą AI, waliduje wynik i zapisuje zasoby. Panel odczytuje status przez polling albo SSE. Publikacja udostępnia zatwierdzony snapshot przez stronę oraz CDN.

Tajemne klucze AI, bazy i magazynu obiektowego znajdują się wyłącznie po stronie serwera. Czytelnik nie wywołuje generowania AI podczas zwykłego przeglądania. Przeliczenia porcji działają szybko w przeglądarce, a serwer wykorzystuje ten sam moduł do eksportu. Panel i prywatne podglądy nie są publicznie buforowane i stosują private/no-store. Renderer eksportu odczytuje tylko własne zatwierdzone zasoby, bez wykonywania adresów sieciowych podanych w scenie.

### 11.3 Trwałość zadań

Zadania korzystają z klucza idempotencji i wersji wejścia. Kolejka jest trwała, ma limity równoległości, kontrolowane ponawianie oraz miejsce na zadania zakończone błędem. Wysłanie zadania do kolejki musi być spójne z zapisem w bazie, np. przez wzorzec outbox.

Ponowienie po utracie odpowiedzi dostawcy najpierw sprawdza, czy zewnętrzne zlecenie zostało wykonane. Jeżeli nie można tego ustalić, system pokazuje ryzyko drugiego kosztu zamiast ukrytego, nieograniczonego powtarzania. Worker zapisuje wynik tylko dla niezmiennego snapshotu i rewizji, dla których został zlecony. Blokada czasowa zadania, heartbeat i odzyskanie po restarcie zapobiegają pozostawieniu go bezterminowo w stanie running.

## 12 Model danych

| Encja | Zawartość i relacje |
| --- | --- |
| AdminUser | Login, stan konta, metoda uwierzytelnienia, ewentualna rola; sesje osobno |
| Recipe | Stałe ID, autor, bieżący szkic, wskazanie publicznej wersji, stan archiwum |
| RecipeVersion | Numer wersji, wydajność, parametry, status redakcyjny, kompletne dane składników i kroków |
| RecipeTranslation | Wersja, locale, tytuł, slug, opis, teksty i stan przeglądu |
| Ingredient | Kanoniczna tożsamość, nazwy i synonimy, postać produktu, alergeny |
| RecipeIngredient | Wersja, składnik, grupa, ilość, jednostka, tryb skalowania i uwagi |
| Step | Wersja, kolejność, czas, temperatury, sprzęt, powiązania z ilościami |
| Category i Tag | Stabilny słownik, etykiety PL i EN; relacje wiele do wielu |
| UnitDefinition | Wymiar, symbol, dokładny współczynnik, profil i wersja definicji |
| IngredientConversion | Składnik i postać, gęstość lub masa sztuki, źródło, stan akceptacji |
| Source | URL, tytuł, data dostępu, autor, prawa i zakres wykorzystania |
| VerificationIssue | Wersja, pole, poziom, problem, propozycja i rozstrzygnięcie |
| Asset | Obraz, oryginał i warianty, pochodzenie, prawa, parametry generacji |
| VisualizationScene | Wersja, schemaVersion, szablon, warstwy, powiązania i układy |
| AIJob | Typ, wersja wejścia, status, etap, próby, model, koszt i błędy |
| Publication | Niezmienny snapshot, zasoby, oba języki, osoba i czas publikacji |
| AuditEvent | Kto, kiedy, jaka operacja, przedmiot i wersja; bez sekretów |
| Report | Zgłoszenie błędu, stan obsługi, minimalne dane kontaktowe |

Ilości, czasy i temperatury są danymi, a nie fragmentami tłumaczonego tekstu. Scena odwołuje się do identyfikatorów. Klucze obce i walidacja aplikacji pilnują relacji. Zasób użyty w publikacji nie jest fizycznie usuwany przez usunięcie go z aktualnego szkicu.

Wersjonowanie musi objąć definicje konwersji oraz szablony, aby stary wydruk i przywrócona publikacja nie zmieniły się przypadkiem po edycji słownika. Można przechować wymagane definicje w snapshotcie publikacji lub wskazać ich niezmienne wersje.

## 13 Kontrakty API

Poniższe endpointy pokazują oczekiwany podział odpowiedzialności. Developer opisuje ostateczny kontrakt w OpenAPI wraz z przykładami, walidacją i uprawnieniami. Publiczne odpowiedzi zawierają wyłącznie opublikowane dane.

| Operacja | Proponowany endpoint | Ważna zasada |
| --- | --- | --- |
| Logowanie i sesja | POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me | Bezpieczna sesja i limit prób |
| Katalog | GET /api/recipes | Locale, filtry, sortowanie i paginacja |
| Przepis | GET /api/recipes/{id} | Wersja publiczna i jawny profil |
| Zapis szkicu | POST /api/admin/recipes, PATCH /api/admin/recipes/{id} | If-Match lub oczekiwana wersja do wykrywania konfliktów |
| Propozycja z nazwy | POST /api/admin/recipes/{id}/research | Zwraca 202 i jobId |
| Analiza | POST /api/admin/recipes/{id}/validate | Uwagi przypisane do wersji |
| Tłumaczenie | POST /api/admin/recipes/{id}/translate | Locale i wersja źródłowa |
| Ilustracje | POST /api/admin/recipes/{id}/generate-assets | Wybrany zasób i limit kosztu |
| Scena | PATCH /api/admin/recipes/{id}/scene | Walidowane powiązania warstw |
| Zadanie | GET /api/admin/jobs/{jobId} | Status, etap i komunikat błędu |
| Publikacja | POST /api/admin/recipes/{id}/publish | Atomowy snapshot i warunki publikacji |
| Przywrócenie | POST /api/admin/recipes/{id}/restore | Tworzy szkic na podstawie wersji |
| Cofnięcie publicznej wersji | POST /api/admin/recipes/{id}/rollback | Przełącza cały zatwierdzony snapshot |
| Wycofanie publikacji | POST /api/admin/recipes/{id}/unpublish | Odbiera publiczny dostęp i unieważnia cache |
| Reset i zmiana hasła | POST /api/auth/password-reset, POST /api/auth/password-change | Jednorazowy token lub bieżąca sesja |
| Upload | POST /api/admin/assets/upload-intent | Kontrola pliku przed wykorzystaniem |
| Wznowienie i anulowanie | POST /api/admin/jobs/{jobId}/retry, POST /api/admin/jobs/{jobId}/cancel | Zachowanie wyniku wcześniejszych etapów |
| PDF | POST /api/recipes/{id}/exports | Snapshot, locale, porcje, jednostki i format |
| Status eksportu | GET /api/exports/{exportId} | Status oraz bezpieczny adres gotowego pliku |
| Zgłoszenie | POST /api/recipes/{id}/reports | Limit i ochrona przed spamem |

API używa stabilnych identyfikatorów błędów oraz lokalizowanych komunikatów. Błąd zawiera code, field, message i requestId. Wymagane stany to 400/422 dla błędnych danych, 401 dla braku sesji, 403 dla braku uprawnień, 404, 409 lub 412 przy If-Match dla konfliktu wersji, 429 dla limitu i 503 dla niedostępnej usługi. Odpowiedź nie ujawnia sekretów ani pełnych logów dostawcy.

Publikacja przekazuje oczekiwaną wersję szkicu i zestaw akceptacji. Jeżeli administrator zatwierdził wersję 7, ale szkic jest już w wersji 8, serwer zwraca konflikt zamiast publikować niezatwierdzone zmiany. Polecenia zlecające zadania i publikujące przyjmują klucz idempotencji.

## 14 Logowanie i bezpieczeństwo

Administrator posiada indywidualny login i hasło. Publiczna rejestracja administratorów jest wyłączona. Pierwsze konto powstaje bezpiecznie podczas konfiguracji. Nowe konta tworzy właściciel. Hasła obsługuje sprawdzona biblioteka lub usługa; przy własnym przechowywaniu należy stosować współczesne haszowanie, np. Argon2id, bez przechowywania haseł w postaci jawnej. [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

Sesja wykorzystuje cookies HttpOnly, Secure i właściwe SameSite, rotację po logowaniu, termin ważności oraz unieważnienie po wylogowaniu, blokadzie konta lub zmianie hasła. Operacje modyfikujące dane są zabezpieczone przed CSRF zgodnie z przyjętym modelem. Każdy endpoint administratora sprawdza uprawnienia na serwerze. Samo ukrycie przycisku nie zabezpiecza operacji. [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

P0 obejmuje limity prób logowania, neutralne komunikaty, bezpieczne odzyskanie hasła z jednorazowym tokenem i rejestr ważnych zdarzeń. Jeżeli właściciel nie podaje adresu do odzyskiwania, developer zapewnia udokumentowaną procedurę administracyjną. Zalecane jest MFA dla kont z prawem publikacji, szczególnie właściciela. [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)

Pliki mają limity rozmiaru, sprawdzany faktyczny typ i bezpieczną nazwę; obrazy są dekodowane i ponownie zapisywane, z usunięciem zbędnych metadanych. HTML i SVG są sanitizowane. Edytor nie może wprowadzić skryptu do publicznego przepisu. Dostęp do prywatnych zasobów i podglądów jest ograniczony czasowo lub wymaga sesji.

Treści stron, dokumentów i wyników wyszukiwania są niezaufanymi danymi. Instrukcje znalezione w przepisie nie mogą zmieniać systemowych poleceń AI, ujawniać kluczy ani wywoływać publikacji. Model dostaje tylko narzędzia konieczne do danego etapu. Wynik jest walidowany przed zapisem.

Importer URL z P1 blokuje localhost, prywatne adresy IP i usługi metadanych, sprawdza przekierowania oraz limity pobierania. Ta ochrona przed SSRF obowiązuje również przy pobieraniu zewnętrznego zasobu. Sekrety są zarządzane na serwerze, a logi nie zawierają haseł, tokenów i niepotrzebnych danych osobowych.

## 15 Dostępność wydajność i wyszukiwarki

### 15.1 Dostępność

Celem produktowym jest WCAG 2.2 na poziomie AA, zweryfikowane automatycznie i ręcznie. Dotyczy części publicznej i panelu. Formularze mają etykiety i powiązane błędy, cały proces jest możliwy klawiaturą, fokus jest widoczny, a zmiany porcji ogłaszane czytnikowi bez odczytywania całej strony. Interakcje edytora mają odpowiedniki klawiaturowe. [Standard WCAG 2.2](https://www.w3.org/TR/WCAG22/)

Tekst i kontrolki mają odpowiedni kontrast, znaczenie nie zależy tylko od koloru, a ilustracje mają opisy. Zmniejszona intensywność ruchu jest respektowana. Widok mobilny i powiększenie nie ukrywają składników. Dostępna alternatywa tekstowa obejmuje całą treść pokazaną w dekoracyjnej wizualizacji.

### 15.2 Wydajność

Docelowe parametry publicznych stron to LCP do 2,5 s, INP do 200 ms i CLS do 0,1 w 75. percentylu rzeczywistych odwiedzin, osobno dla urządzeń mobilnych i desktopowych. Przed premierą wykonuje się testy laboratoryjne; potwierdzenie terenowe jest możliwe dopiero po zebraniu ruchu. [Definicje Core Web Vitals](https://web.dev/articles/vitals)

Obrazy mają warianty rozdzielczości, nowoczesne formaty i zadane wymiary. Zasoby poniżej ekranu mogą ładować się później. Edytor administratora ładuje się osobno od publicznego katalogu. Projekt nie wysyła wszystkich pełnych obrazów składników na telefon przy otwarciu listy.

Zmiana porcji ma cel do 100 ms od interakcji do widocznego wyniku dla typowego przepisu. Wyszukiwanie ma cel p95 do 500 ms po stronie serwera dla uzgodnionego zbioru 10 000 przepisów i profilu obciążenia. Te wartości są celami do weryfikacji w środowisku produkcyjnym, a nie obietnicą niezależną od hostingu.

### 15.3 SEO i udostępnianie

Strony mają unikalne tytuły, opisy, adresy kanoniczne, wzajemne hreflang PL i EN, mapę strony oraz poprawne przekierowania. Panel, szkice i prywatne podglądy nie są indeksowane i są zabezpieczone dostępem. Robots nie zastępuje uwierzytelnienia. [Google o wersjach językowych](https://developers.google.com/search/docs/specialty/international/localized-versions)

Publiczny przepis zawiera dane strukturalne Recipe zgodne z widoczną treścią, m.in. nazwę, obraz, składniki, kroki i wydajność. Domyślne JSON-LD opisuje zatwierdzoną wydajność bazową. Ocen i wartości odżywczych nie należy tworzyć dla uzyskania bogatszego wyniku wyszukiwania. Zgodna implementacja nie gwarantuje wyświetlenia rozszerzonego wyniku. [Google Recipe structured data](https://developers.google.com/search/docs/appearance/structured-data/recipe)

Udostępniany link może zachować porcje i jednostki w parametrach. Canonical prowadzi do podstawowego adresu przepisu, aby każdy wariant kalkulatora nie tworzył osobnej indeksowanej strony. Podglądy społecznościowe wykorzystują tytuł i zatwierdzoną ilustrację.

## 16 Jakość informacji i prywatność

### 16.1 Alergeny i wartości odżywcze

Informacje o alergenach pochodzą z pełnej listy składników, składników złożonych i zamienników. Zatwierdzenie obejmuje aktualną wersję. Zmiana produktu lub zamiennika wymaga ponownego przeglądu. Oznaczenie wegańskie nie gwarantuje braku alergenu ani jego śladów. [Food Standards Agency o alergenach](https://www.food.gov.uk/food-safety-and-hygiene/food-allergies-intolerances-and-coeliac-disease)

Jeżeli dodamy wartości odżywcze, przechowujemy źródło, dopasowanie produktu, masę części jadalnej, podstawę „na porcję” lub „na 100 g” oraz niepewność. Brak danych nie jest zerem. Całkowita energia zmienia się z ilością przepisu; energia na tak samo zdefiniowaną porcję nie rośnie tylko dlatego, że wybrano więcej porcji. System nie przedstawia danych AI jako pomiaru laboratoryjnego.

### 16.2 Dane użytkowników

P0 ogranicza dane osobowe do kont administratorów i ewentualnego kontaktu przy zgłoszeniu błędu. Rejestr przechowywanych danych określa cel, okres retencji, dostęp i sposób usunięcia. Nie zbieramy informacji o zdrowiu czytelników dla zwykłego filtrowania. Jest to zgodne z zasadą minimalizacji i ograniczenia przechowywania danych. [RODO w EUR-Lex](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng)

Przed premierą właściciel dostarcza właściwe informacje o prywatności, warunki korzystania i zasady wykorzystania treści. Developer wdraża konfigurację zgodnie z faktycznie używanymi usługami oraz podstawami przetwarzania. Analityka i zgody powinny być zaprojektowane dla wybranego sposobu pomiaru, a nie dodane jako zbędny baner bez związku z technologią.

P1 z kontami czytelników wymaga obsługi usunięcia konta, eksportu danych, synchronizacji ulubionych i ochrony formularzy. Komentarze i zdjęcia użytkowników nie trafiają od razu do publikacji. Newsletter wymaga osobnej decyzji produktowej i udokumentowanego procesu zgody.

## 17 Utrzymanie i eksploatacja

Wymagane są osobne środowiska lokalne, testowe i produkcyjne, migracje bazy w repozytorium oraz automatyczne wdrożenia z możliwością wycofania. Środowisko testowe nie używa produkcyjnych danych osobowych i ma oddzielne klucze oraz limity AI.

Kopie obejmują bazę, oryginały ilustracji, sceny, definicje konwersji i dane publikacji. Proponowany punkt wyjścia to RPO do 24 godzin i RTO do 8 godzin, do uzgodnienia z właścicielem i dostawcą. Przed uruchomieniem należy faktycznie odtworzyć kopię w osobnym środowisku. Sam komunikat o wykonaniu backupu nie spełnia odbioru.

Monitoring obejmuje dostępność strony, błędy API, kolejkę, zadania długo bez postępu, koszty AI, nieudane logowania, zapis do magazynu i generowanie PDF. Alerty trafiają do wskazanego właściciela utrzymania. Limity kosztów i liczby zadań są konfigurowalne bez zmiany kodu.

Dokumentacja operacyjna opisuje pierwsze konto, odzyskanie dostępu, zmianę kluczy, odtworzenie kopii, ponowienie zadania, brak dostawcy AI, wycofanie wersji oraz eksport całości danych. Awaria AI nie blokuje czytania opublikowanych przepisów ani ręcznej edycji szkiców.

## 18 Kryteria akceptacji

Kryteria są częścią odbioru P0. Developer przygotowuje reprezentatywne dane testowe obejmujące prosty przepis, zupę, wypiek, zakresy, ilości jakościowe, jajka, składniki złożone i długi wariant EN. Macierz przeglądarek obejmuje aktualną i poprzednią główną wersję Chrome, Safari, Firefox i Edge oraz Safari iOS i Chrome Android. Uzgodnione ekrany testowe obejmują szerokości 360, 768 i 1440 px. Długi przepis testowy ma 30 składników i 15 kroków.

| ID | Scenariusz | Warunek odbioru |
| --- | --- | --- |
| AC01 | Dodanie pełnego przepisu | Oryginał zachowany; powstaje szkic i lista uwag bez automatycznej publikacji |
| AC02 | Dodanie samej nazwy | Propozycja ma źródła albo jawne pochodzenie AI; niejasny wariant wymaga wyboru |
| AC03 | Klasyfikacja | Jeden przepis należy do kilku kategorii i jest w każdej widoczny |
| AC04 | PL i EN | Obie wersje kompletne; przełączenie zachowuje ID przepisu, porcje i jednostki |
| AC05 | Przeliczanie | Przykłady z sekcji 8 przechodzą; wartości listy, kroków, grafiki i PDF są zgodne |
| AC06 | UK | Masa i objętość rozróżnione; Imperial nie jest mieszany z US; cup nie jest zgadywany |
| AC07 | Edytowalna karta | Zmiana tekstu, układu i zasobu bez generowania całego obrazka; działa cofnij |
| AC08 | Druk | PL i EN, A4 i Letter, 1 i 6 porcji; grafika obecna i nic nie jest ucięte |
| AC09 | Publikacja | Szkic nie zmienia publicznej wersji; publikacja jest atomowa; można przywrócić wersję |
| AC10 | Zadania | Odświeżenie nie dubluje zlecenia; błędy i wznowienie widoczne; stary wynik nie nadpisuje szkicu |
| AC11 | Dostęp | Niezalogowany nie odczytuje szkicu i nie może wywołać generacji lub publikacji |
| AC12 | Konflikt edycji | Drugi zapis nie nadpisuje nowszej wersji bez rozstrzygnięcia |
| AC13 | Telefon i dostępność | Podstawowe zadania możliwe na telefonie, klawiaturą i czytnikiem ekranu |
| AC14 | SEO | Publiczne dane Recipe zgodne z treścią, locale i mapą strony; szkice niedostępne publicznie |
| AC15 | Odzyskanie | Kopia faktycznie odtworzona; przepis, ilustracje i publikacja pozostają spójne |
| AC16 | Limity kosztów | Przekroczenie zatrzymuje nowe zadania i zachowuje dotychczasową pracę |
| AC17 | Zgłoszenie błędu | Zgłoszenie trafia do panelu, limit ogranicza spam i żadne dane kontaktowe nie są publiczne |

Testy obejmują moduł przeliczeń, reguły publikacji, autoryzację API, zadania asynchroniczne i najważniejsze przepływy przeglądarkowe. Wydruki wymagają porównania wizualnego. Dostępność wymaga także ręcznej oceny. Weryfikacja bezpieczeństwa obejmuje próbę wstrzyknięcia instrukcji w źródle, niedozwolony URL, plik z błędnym typem i dostęp do cudzego szkicu.

Ocena AI korzysta z ustalonego zestawu przepisów i checklisty redaktora. Mierzymy odsetek poprawnie rozpoznanych składników, kategorii i uwag, liczbę nieuzasadnionych zmian, spójność PL i EN oraz zgodność grafiki z daniem. Krytycznym warunkiem jest brak automatycznej publikacji niesprawdzonego materiału. Nie wystarcza pokazanie jednego udanego przykładu.

## 19 Etapy prac i przekazanie

### 19.1 Kolejność realizacji

1. Uzgodnienie założeń, makiety głównych ekranów i projekt systemu wizualnego.
2. Prototyp modelu przepisu oraz kalkulatora na trudnych przykładach.
3. Konta administratorów, formularz, wersje i podstawowy katalog.
4. Integracje AI, uwagi, tłumaczenia, kolejka i limity.
5. Ilustracje, szablony i edytor sceny.
6. Publikacja, wyszukiwanie, druk i PDF.
7. Testy odbiorowe, dostępność, bezpieczeństwo, odtworzenie kopii i uruchomienie.
8. Ocena korzystania z P0 i osobny wybór rozszerzeń P1.

Zanim zostanie zbudowany pełny edytor grafiki, należy potwierdzić działanie jednego reprezentatywnego przepisu od formularza do wydruku, z obu językami i przeliczeniami. Ten pionowy prototyp powinien ujawnić problemy danych i jakości ilustracji.

### 19.2 Co developer przekazuje

- Repozytorium aplikacji, instrukcję uruchomienia i konfiguracji bez sekretów.
- Projekt ekranów i komponentów, opis tokenów wizualnych oraz szablonów.
- Schemat bazy, migracje, kontrakt API i format sceny.
- Wersjonowane definicje jednostek, reguły zaokrągleń i przykłady odbiorowe.
- Konfigurację modeli, prompty, reguły walidacji i zestaw oceny AI.
- Scenariusze testów i raport z kryteriów akceptacji.
- Instrukcję administratora i utrzymania, backupu oraz odzyskiwania.
- Listę użytych usług, licencji, kosztów stałych i zmiennych oraz procedurę eksportu danych.

Wycena powinna rozdzielać projekt UX i UI, aplikację publiczną, panel, AI, kalkulator, edytor grafiki, PDF, testy i utrzymanie. Osobno pokazuje abonamenty, koszt jednej pełnej generacji przepisu oraz koszt ponowienia obrazów. Wydajność i jakość nie powinny być zastąpione ogólną deklaracją „nowoczesny design”.

## 20 Decyzje do potwierdzenia przed implementacją

Poniższe punkty mają proponowane odpowiedzi, więc nie blokują przygotowania pierwszej wyceny. Właściciel może je zmienić; developer powinien pokazać wpływ na koszt i zakres.

| Decyzja | Proponowany punkt wyjścia |
| --- | --- |
| Nazwa, domena i identyfikacja marki | Do ustalenia; styl ciepły, jasny i redakcyjny zgodny z referencją |
| Główny rodzaj wizualizacji | Interaktywna karta i kontrolowany wariant do druku |
| Publiczny dostęp | Bez konta; konta czytelników w P1 |
| Język angielski | en-GB, niezależny od jednostek |
| Znaczenie profilu UK | Imperial masa i objętość, jawne miarki kuchenne, domyślnie °C |
| Redakcja | Jedna marka, kilku indywidualnych administratorów, ręczna publikacja |
| Źródła i prawa | Własne i dopuszczone źródła, zapis pochodzenia, własne grafiki lub AI |
| Zakres pierwszej wersji | Wszystkie pozycje P0; P1 i P2 wyceniane oddzielnie |
| Budżet generacji i hosting | Kwota i limity do ustalenia po próbie na 20–30 przepisach |
| Przepisy na start | Reprezentatywny zbiór redakcyjny, w tym dania trudne do przeliczania |
| Dane odżywcze | Ręczne dane z pochodzeniem lub pominięcie; automatyczne obliczenia w P1 |
| Utrzymanie | Wskazany opiekun, harmonogram aktualizacji i uzgodnione RPO oraz RTO |

## 21 Źródła techniczne

Źródła wykorzystano do weryfikacji możliwości i standardów. Szczegółowe decyzje produktowe, cele wydajności i etapowanie są rekomendacjami tego dokumentu. Dokumentację usług i definicje jednostek należy ponownie sprawdzić przy rozpoczęciu implementacji.

- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation)
- [NIST przeliczniki jednostek](https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors/nist-guide-si-appendix-b8)
- [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [Google Recipe structured data](https://developers.google.com/search/docs/appearance/structured-data/recipe)
- [Google localized versions](https://developers.google.com/search/docs/specialty/international/localized-versions)
- [Core Web Vitals](https://web.dev/articles/vitals)
- [Food Standards Agency o alergenach](https://www.food.gov.uk/food-safety-and-hygiene/food-allergies-intolerances-and-coeliac-disease)
- [RODO w EUR-Lex](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng)
