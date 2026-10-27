> Materiał historyczny z wcześniejszych etapów projektu. Aktualny stan, konfigurację i granice publikacji opisują [przekazanie](docs/claude-code-handoff.md), kod i bieżące runbooki; nie traktuj dawnych planów jako aktywnego zachowania.

# Rekomendacje decyzji i modeli

Stan dokumentacji sprawdzony 3 października 2026. Dokument rozwija `Analiza_i_plan_wdrozenia.md` i specyfikację. Poniższe wybory są rekomendacjami do realizacji, a limity kosztów są propozycją konfiguracji. Nie uruchomiono usług, nie zakupiono planów i nie zmieniono zakresu źródłowej specyfikacji.

Aktualizacja ustalenia z 4 października 2026: docelowa domena to **jesie.pl**, zgodnie z decyzją właściciela. Pozostałe ustalenia pozostają bez zmian.

## Proponowany zestaw

**Next.js + TypeScript na Vercel, Neon PostgreSQL + Drizzle, Better Auth, Vercel Blob, Vercel Workflows, OpenAI do treści i fal.ai do obrazów.**

fal.ai dobrze pasuje do projektu. Nie ma powodu rezygnować z posiadanego dostępu: API obsługuje asynchroniczne zlecenia, statusy i webhooki. Aplikacja zleca generowanie po stronie serwera i zapisuje identyfikator żądania, zamiast czekać przez cały czas generacji w jednym połączeniu HTTP. [Kolejka fal](https://fal.ai/docs/documentation/model-apis/inference/queue)

## Modele treści i obrazów

| Decyzja | Rekomendacja | Uzasadnienie |
| --- | --- | --- |
| Główny model redakcyjny | `gpt-6-astra` przez OpenAI Responses API | Priorytetem jest jakość przy małej początkowej liczbie autorskich przepisów |
| Analiza, opracowanie i przegląd przepisu | Astra, reasoning `high` dla trudnych analiz, `medium` dla prostych | Większą pracę modelu przeznaczamy na niejasności, proporcje i zgodność instrukcji |
| Wyszukiwanie z nazwy | Astra z narzędziem `web_search` | Zachowujemy rzeczywiście uzyskane źródła oraz rozstrzygamy wariant przed generowaniem grafiki |
| Tłumaczenie PL ↔ en-GB | Astra, `medium`, wspólny słownik kulinarny | Tłumaczymy teksty; ilości, identyfikatory i jednostki pozostają danymi aplikacji |
| Kategorie, robocze tagi, ALT i SEO | `gpt-6.1-sol` | Niższy koszt dla krótszych, kontrolowanych zadań; etykiety wymagające weryfikacji nadal zatwierdza człowiek |
| Format danych | Structured Outputs oraz walidacja schematu i reguł aplikacji | Format JSON pomaga w integracji, ale nie dowodzi prawdziwości przepisu |
| Weryfikacja końcowa | Kontrole kodem, osobny przegląd redakcyjny AI i akceptacja administratora | Druga odpowiedź modelu nie zastępuje sprawdzenia ani testu w kuchni |
| Finalna ilustracja | GPT Image 2.5 Sunburst przez fal.ai, `quality: xhigh` | Kandydat do dopracowanych ilustracji z detalem; wyższa jakość zwiększa czas i zużycie tokenów |
| Przegląd wariantów | Sunburst `high`, dwie propozycje w jednym zleceniu | Pozwala wybrać kompozycję przed finalnym dopracowaniem |
| Edycja obrazu | Sunburst `edit`, aktualny obraz i zatwierdzona referencja stylu | Zmieniamy wybrany zasób, zachowując kierunek wizualny |
| Składniki bez tła | Sunburst, `background: transparent`, PNG | Osobne bitmapy do składania scen; kanał alfa trzeba sprawdzić w podglądzie |
| Model porównawczy grafiki | Nano Banana 2 w 2K, przez to samo fal.ai | Drugi kandydat do próby porównawczej; wdrażamy go jako wybór dopiero, jeśli przynosi korzyść |
| Bardzo wysoka jakość `max` | Ręczna opcja dla trudnego zasobu lub ważnego wydruku | Wzrost kosztu oceniamy na wyniku, nie włączamy automatycznie dla każdej miniatury |
| Własny wytrenowany model | Początkowo wystarczą słownik, referencje stylu i przykłady | Potrzebę dodatkowego treningu oceniamy po zebraniu powtarzalnych problemów |

OpenAI opisuje Astrę jako najbardziej zdolny model, a Sol jako model zbliżony jakością przy niższym koszcie. To uzasadnia powyższy profil startowy; nie stanowi dowodu przewagi w polskich przepisach. Nie znaleziono oficjalnego benchmarku tego konkretnego zastosowania. [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)

Źródła z `web_search` i cytowania zapisujemy jako dane, a propozycje normalizacji jako osobne wyniki. Bibliografia nie powinna powstawać z pamięci modelu. [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

Sunburst jest wariantem fal nastawionym na precyzję i detal kosztem czasu. Schema potwierdza poziomy `high`, `xhigh`, `max`, przezroczyste tło oraz osobny endpoint edycji. Domyślny endpoint ilustracji to `openai/gpt-image-2.5/sunburst/text-to-image`; dla referencji i poprawek używamy `openai/gpt-image-2.5/sunburst/edit`. [Generowanie Sunburst](https://fal.ai/models/openai/gpt-image-2.5/sunburst/text-to-image/api), [Edycja Sunburst](https://fal.ai/models/openai/gpt-image-2.5/sunburst/edit/api)

Na ilustrację główną proponuję 2560 × 1920 px, z daniem pośrodku i zapasem na kadrowanie. PNG zachowujemy jako oryginał, a warianty web tworzymy osobno. Rozmiar docelowy potwierdzamy na szablonie druku. Liczb, nazw i instrukcji nie generujemy wewnątrz obrazu. Referencja stylu, naczynia i dekoracje nie mogą dodawać składników nieobecnych w przepisie.

## Wszystkie decyzje z rozdziału 20 specyfikacji

| Decyzja | Moja rekomendacja |
| --- | --- |
| Nazwa marki | **jesie.pl**, zgodnie z decyzją właściciela |
| Domena | Ustalona przez właściciela: **jesie.pl**. Docelowy adres HTTPS: `https://jesie.pl`; demo działa pod adresem Vercel. Podłączenie domeny i DNS przy docelowym uruchomieniu |
| Identyfikacja | Ciepła biel, krem, szałwia i ochra; Lora do tytułów, Manrope do treści i panelu, duże ilustracje; referencja wyznacza nastrój |
| Główny rodzaj wizualizacji | Responsywna karta HTML z oddzielną ilustracją, składnikami i krokami; kontrolowany wariant druku z tych samych danych |
| Publiczny dostęp | Bez logowania. Ulubione i postęp lokalnie; synchronizacja kont czytelników pozostaje w P1 |
| Język angielski | en-GB. PL jako domyślny język roboczy; kompletność obu wersji jako warunek publikacji |
| Jednostki UK | Metryczne domyślnie w obu językach; ręczne przełączenie na UK imperial. Domyślnie °C; bez domyślnego „UK cup” |
| Redakcja | Jeden właściciel na start, indywidualne konta `owner` i `admin`; wyłącznie ręczna publikacja. Właściciel zarządza dostępem i budżetem |
| Źródła i prawa | Własne przepisy lub autorskie opracowania ze źródłami. Własne zdjęcia albo jawnie oznaczone ilustracje AI; pochodzenie zapisywane przy wersji |
| Zakres pierwszej wersji | Pełne P0 jako docelowe wydanie produkcyjne. Wcześniej oddzielna demonstracja i kolejne wdrożenia testowe; nie zmieniają priorytetów dokumentu |
| Budżet AI | Pilotaż do **50 USD łącznie**. Po pilotażu proponowany limit produkcji **50 USD/miesiąc i 10 USD/dzień**; testy **20 USD/miesiąc i 5 USD/dzień**. Są to proponowane limity, nie prognoza rachunku |
| Hosting | Vercel na posiadanym koncie. Do produkcji rekomenduję Pro; płatny plan włączamy dopiero, gdy potrzebny jest do uruchomienia, po sprawdzeniu bieżącego konta |
| Przepisy na start | Docelowo **24 kompletne przepisy PL/EN**, obejmujące wszystkie kategorie. Pierwsze sześć służy do dopracowania wyglądu; zbiór oceny AI obejmuje 30 przypadków |
| Dane odżywcze | Opcjonalne pola w modelu. Wyświetlanie tylko ręcznie zatwierdzonych danych ze źródłem; przy braku danych sekcja jest pomijana |
| Utrzymanie | Codzienna kopia, przegląd zależności raz w miesiącu, wskazany odbiorca alertów. Proponowane RPO 24 h i RTO 8 h potwierdzamy odtworzeniem |

Pro jest obecnie prezentowany od 20 USD miesięcznie, z rozliczaniem dodatkowego wykorzystania i odpowiednimi zasadami miejsc zespołu. To cena bazowa planu, nie całej infrastruktury. [Cennik Vercel](https://vercel.com/pricing)

Lora i Manrope są dostępne w katalogu Google Fonts na licencji OFL; proponuję hostować pliki wraz z aplikacją i używać tych samych fontów w PDF. [Lora](https://raw.githubusercontent.com/google/fonts/main/ofl/lora/METADATA.pb), [Manrope](https://raw.githubusercontent.com/google/fonts/main/ofl/manrope/METADATA.pb)

## Konkretne wybory technologii i zachowania systemu

| Decyzja | Rekomendacja |
| --- | --- |
| Framework i język | Next.js App Router + TypeScript, wspólny projekt publiczny, panel i API; wspierane wersje przypięte w lockfile |
| Baza | Neon PostgreSQL przez Vercel Marketplace; Drizzle do schematu, zapytań i wersjonowanych migracji |
| Logowanie | Better Auth: e-mail i hasło, publiczna rejestracja wyłączona, właściciel tworzy konta, reset przez e-mail; MFA dla właściciela |
| E-mail systemowy | Resend do odzyskiwania dostępu i zaproszeń administratorów; własna zweryfikowana domena nadawcza przed produkcją |
| Uprawnienia | Sprawdzanie sesji oraz roli na serwerze przy każdej operacji; role nie wynikają z danych przesłanych z przeglądarki |
| Limity prób logowania i zgłoszeń | Trwałe liczniki w bazie dla wszystkich instancji aplikacji; nie polegamy na pamięci pojedynczej funkcji |
| Magazyn zasobów | Vercel Blob: prywatny magazyn szkiców i kopii, publiczne warianty zatwierdzonych ilustracji. Każda wersja ma własny klucz pliku |
| Wykonanie zadań | Vercel Workflows do procesu redakcyjnego i eksportu; własne rekordy zadań, outbox oraz rezerwacje kosztów w PostgreSQL |
| fal.ai | Submit do kolejki → zapis `request_id` → podpisany webhook → walidacja → zapis obrazu we własnym magazynie. Odczyt statusu odzyskuje rezultat przy braku webhooka |
| Powtarzanie zadań | Deduplikacja i limity prób; przy niepewnym stanie dostawcy najpierw odczyt wyniku. Kolejna płatna generacja wymaga jawnej decyzji administratora |
| Grafiki składników | Wspólna biblioteka według składnika i jego postaci, zamiast generowania tej samej cebuli dla każdego przepisu |
| Druk | HTML/CSS `print`, domyślnie A4 z ilustracją; Letter, oszczędny i tekstowy jako pozostałe warianty P0 |
| PDF | Playwright + Chromium renderujący ten sam widok druku w zadaniu serwerowym. Gotowy PDF w magazynie, klucz cache uwzględnia publikację i wszystkie ustawienia |
| PDF na Vercel | Prototyp mierzy czas, pamięć i zależności dla 30 składników i 15 kroków; decyzję o dodatkowym wykonawcy podejmujemy tylko, jeśli pomiary wymagają zmiany |
| Wyszukiwanie | PostgreSQL, synonimy PL/EN, normalizacja znaków i trigramy; filtrów czytelnika nie obsługuje płatny model AI |
| Podobne i wyróżnione | Sześć ręcznie wskazanych przepisów na stronie głównej, cztery podobne według kategorii i głównych składników |
| Stan filtrów | URL; kategorie OR, grupy filtrów AND, widoczne wykluczenia i możliwość wyczyszczenia |
| Responsywność | Osobne układy treści, z testami 320/360, 768 i 1440 px; panel mobilny w jednej kolumnie z zakładkami języków |
| Edytor wizualizacji | Trzy rodziny szablonów z dozwolonymi strefami warstw, kolejnością, kadrem, skalą i kolorami. Zmiany muszą mieć reguły telefonu i druku oraz cofnij/ponów |
| Obsługa bez przeciągania | Przyciski zmiany kolejności i ustawienia warstw oraz klawiatura; gest przeciągania jest dodatkową metodą |
| Podstawa skalowania | Jawne `scalingBasisType`, `baseQuantity` i `baseUnit`; porcje i uzysk osobno. `manual_review` wybiera wyłącznie zatwierdzone warianty |
| Kalkulator | Jeden deterministyczny moduł dla przeglądarki i serwera, wartości bazowe, dokładne przeliczniki, zaokrąglenia wyłącznie w prezentacji |
| Masa ↔ objętość | Dopiero po zatwierdzeniu przelicznika konkretnego składnika i jego postaci |
| Kroki | Tekst z typowanymi odwołaniami do ilości składników, ich udziałów, czasów i temperatur. Tłumaczenie zachowuje odwołania |
| Zapis szkicu | Automatyczny zapis z komunikatem stanu i kontrolą rewizji; konflikty wymagają porównania, a wynik starego zadania AI trafia do historii |
| Publikacja | Akceptacja PL/EN, danych, źródeł i grafiki, transakcja i niezmienny snapshot, osobny szkic dalszych zmian |
| Słowniki w publikacji | Zamrożone nazwy, metadane alergenów i wersje jednostek, konwersji, szablonów oraz zasobów |
| Pochodzenie informacji | Link do źródła przy przepisie oraz powiązania z odpowiednimi polami/krokami; treści redaktora i propozycje AI oznaczone osobno |
| Slugi | Osobne PL/EN, stałe ID, przekierowanie 301 po zmianie. Historycznych adresów nie przydzielamy innemu przepisowi |
| Archiwizacja i kosz | Obie operacje wycofują publikację. Kosz: 30 dni; archiwum zachowuje historię. Zasoby użyte w zachowywanej wersji nie są fizycznie usuwane |
| Wycofanie i PDF | Wycofanie strony/API/katalogu i blokada nowych eksportów do 60 s. Pobieranie PDF przez endpoint sprawdzający aktualny dostęp; długie publiczne URL eksportów nie są wymagane |
| Data publikacji | Faktyczny czas w P0; zaplanowanie przyszłej publikacji w P1 |
| Region | Aplikacja i baza możliwie blisko siebie w UE, preferowany Frankfurt. Miejsce przetwarzania przez dostawców AI sprawdzamy oddzielnie |
| Środowiska | Lokalne, testowe i produkcyjne z osobnymi danymi, kluczami i limitami. Preview nie otrzymuje danych osobowych administratorów produkcji |
| Kopie | Codzienne kopie bazy i manifestu niezmiennych zasobów, niezależna kopia oryginałów, retencja 30 dni. Pierwsze odtworzenie przed premierą, kolejne raz na kwartał |
| Limity i alarmy | Rezerwacje kosztów; informacja przy 70% i 90%, blokada nowych zleceń przy 100%. Działająca książka kucharska pozostaje dostępna |
| Bezpieczny limit ruchu | Najpierw profil małego serwisu: 2 administratorów, 2 równoczesne generacje; test katalogu dla 10 000 przepisów. Docelowy ruch potwierdzamy pomiarami |

Integracje PostgreSQL są dostępne w Vercel Marketplace, a Better Auth dokumentuje logowanie hasłem, wyłączenie rejestracji, MFA i adapter Drizzle. [Vercel Storage](https://vercel.com/docs/storage), [Better Auth](https://better-auth.com/docs/authentication/email-password), [Opcje kont](https://better-auth.com/docs/reference/options), [MFA](https://better-auth.com/docs/plugins/2fa), [Adapter Drizzle](https://better-auth.com/docs/adapters/drizzle)

Resend dokumentuje integrację z Next.js i wymaga zweryfikowanej domeny do wysyłki z własnego adresu. [Resend + Next.js](https://resend.com/docs/send-with-nextjs)

Blob obsługuje osobne magazyny prywatne i publiczne. Workflows udostępnia trwałe etapy, ponawianie i wznowienie, ale limity czasu pojedynczego wykonania nadal trzeba uwzględnić. [Vercel Blob](https://vercel.com/docs/vercel-blob), [Vercel Workflows](https://vercel.com/docs/workflows), [Limity Functions](https://vercel.com/docs/functions/limitations)

fal dokumentuje weryfikację podpisów webhooków i konfigurację retencji plików. Obrazy kopiujemy do własnego magazynu po otrzymaniu wyniku. [Webhooki fal](https://fal.ai/docs/documentation/model-apis/inference/webhooks), [Retencja fal](https://fal.ai/docs/documentation/model-apis/media-expiration)

Playwright `page.pdf()` korzysta z CSS dla druku i obsługuje A4 oraz Letter, dlatego jest dobrym punktem wyjścia do zgodności podglądu z PDF. [Playwright PDF](https://playwright.dev/docs/api/class-page#page-pdf)

## Koszty i potwierdzenie jakości

Aktualne stawki OpenAI Standard dla krótkiego kontekstu:

| Model | 1 mln tokenów wejścia | 1 mln tokenów wyjścia |
| --- | ---: | ---: |
| GPT-6 Astra | 10 USD | 50 USD |
| GPT-6.1 Sol | 2 USD | 10 USD |

Jedno wywołanie z 10 000 tokenów wejścia i 3 000 rozliczanych tokenów wyjścia kosztuje 0,25 USD dla Astry albo 0,05 USD dla Sol. To przykład pojedynczego wywołania, nie całej receptury. Dodatkowe przejścia, tokeny rozumowania i wyniki wyszukiwania zwiększają rachunek. Web search ma cenę 0,01 USD za wywołanie plus pobrane tokeny według stawki modelu. [Cennik OpenAI](https://developers.openai.com/api/docs/pricing)

fal podaje pomiar krótkiego żądania GPT Image 2.5 high przy 2560 × 1440: 0,0554 USD, czyli około 0,06 USD. To przykład pomiaru z 8 września 2026, nie stała cena wybranej tu ilustracji 2560 × 1920 w jakości xhigh. `xhigh`, większy obraz, referencje i prompt zwiększają koszt tokenowy. [Cennik i opis pomiaru fal](https://fal.ai/gpt-image-2.5)

Nano Banana 2 kosztuje obecnie 0,12 USD dla 2K bez dodatkowych opcji, zgodnie z bazową stawką 0,08 USD i mnożnikiem 1,5. [Nano Banana 2](https://fal.ai/models/fal-ai/nano-banana-2)

Rekomenduję pilotaż na 30 przepisach, w tym minimum ośmiu trudnych, oraz porównanie obrazów 12 różnych potraw. Sunburst i Nano Banana otrzymują ten sam brief. Oceniamy zgodność potrawy, poprawność składników, apetyczność, spójność stylu i jakość wycięcia. Rozliczamy koszt zaakceptowanego zasobu, uwzględniając odrzucone warianty i poprawki.

Warunki odbioru są bezwzględne dla mechaniki: wszystkie przykłady kalkulatora przechodzą, żaden wynik AI nie publikuje się sam, ilości PL/EN są zgodne, szkice pozostają prywatne, a przed publikacją rozstrzygnięto wszystkie błędy krytyczne. Dla modeli mierzymy kompletność i błędy na próbce; nie zakładamy bezbłędności na podstawie nazwy modelu.

## Kolejność realizacji

1. Ustalenie danych przepisu i projektu, kalkulator oraz jeden szablon strony i druku.
2. Działająca demonstracja na Vercel i sprawdzenie realnego telefonu, PL/EN oraz wydruku.
3. Panel, logowanie, szkice, publikacje i historie.
4. OpenAI, fal.ai, trwałe zadania oraz pomiar jakości i kosztów.
5. Pozostałe szablony, edytor, serwerowy PDF i pełny odbiór P0.

Pierwszy deploy nowego projektu Vercel jest oznaczany jako Production niezależnie od intencji testowej; trzeba świadomie oddzielić zasoby testowe i docelową domenę. [Środowiska Vercel](https://vercel.com/docs/deployments/environments#first-deployment)

Rekomendacje techniczne można przyjąć jako roboczy punkt wyjścia. Właściciel ostatecznie wybiera nazwę/domenę, konto i zespół Vercel, odbiorcę alertów oraz osoby zatwierdzające treści. Budżety pozostają proponowanymi ustawieniami do ustalenia przy wdrożeniu. Klucze OpenAI i fal oraz sekrety infrastruktury skonfigurujemy po stronie serwera, gdy rozpocznie się implementacja; nie trzeba przekazywać ich w treści rozmowy.
