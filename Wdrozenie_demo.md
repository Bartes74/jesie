> Materiał historyczny z wcześniejszych etapów projektu. Aktualny stan, konfigurację i granice publikacji opisują [przekazanie](docs/claude-code-handoff.md), kod i bieżące runbooki; nie traktuj dawnych planów jako aktywnego zachowania.

# jesie.pl — wdrożenie aplikacji i redakcji

Aktualizacja: 4 października 2026.

Aktualizacja z 4 października 2026: właściciel ustalił **jesie.pl** jako docelową domenę serwisu. Pozostałe ustalenia pozostają bez zmian. Podłączenie domeny, DNS i weryfikacja docelowych adresów canonical/hreflang są do wykonania przy docelowym uruchomieniu; poniżej podano działające adresy demo.

Adres aplikacji: https://zgotujsobie.vercel.app/pl

Wersja angielska: https://zgotujsobie.vercel.app/en

Panel redakcyjny: https://zgotujsobie.vercel.app/admin

Projekt Vercel: zgotujsobie. Scope: bartek-dajerpls-projects. Funkcje są przypisane do regionu Frankfurt `fra1`. Aplikacja ma noindex do docelowego uruchomienia. Publiczny układ zachowano; dane pochodzą obecnie z trwałych publikacji PostgreSQL. Ponownie sprawdzono 18 rzeczywistych PDF z pełnymi składnikami i krokami po podłączeniu bazy.

Aktualny deployment: `dpl_C3fjAXFR8rpXpTiXdWkuNLyBj6vz`, status READY, target production. Adres niezmiennego wdrożenia: https://zgotujsobie-fbpf8xh9g-bartek-dajerpls-projects.vercel.app. Końcowy smoke test potwierdził obie wersje językowe, sześć publikacji, przekierowanie panelu do logowania, kod401 chronionego API, wyłączoną rejestrację i niezużytą aktywację właściciela.

## Co działa

- Responsywny katalog sześciu przepisów i 10 kategorii.
- Wyszukiwanie PL/en-GB z obsługą polskich znaków, filtry kategorii, czasu i trudności, sortowanie i stan w URL.
- Strony przepisów w obu językach i lokalne ulubione.
- Fotograficzne miniatury każdego składnika, zdjęcia detalu wszystkich 31 kroków i podpisy wyjaśniające oczekiwany efekt.
- Porcje 1–24, Metric/UK Imperial, wspólny kalkulator ilości w składnikach i instrukcji.
- Lokalnie zapisany postęp, ustawienia i timery z terminem zakończenia.
- Kopiowanie listy zakupów i druk / zapis PDF przez przeglądarkę, A4/Letter, warianty ilustrowany, oszczędny i tekstowy.

## Panel redakcyjny

- Logowanie Better Auth, prywatne konta, sesje i limity prób w PostgreSQL, zmiana hasła i rejestr zdarzeń.
- Przegląd i wyszukiwanie przepisów, tworzenie prywatnego szkicu, edytor PL/EN z automatycznym zapisem i ochroną konfliktów.
- Ilości, składniki, kolejność kroków, podgląd, wybór fotografii składników i detali z istniejącej biblioteki oraz opisy i źródła.
- Niezmienna historia rewizji, przywracanie, duplikacja, archiwizacja i wycofanie publikacji.
- Ręczna akceptacja bieżącej rewizji i atomowa publikacja. Późniejsza edycja szkicu nie zmienia wersji publicznej.

Bazy produkcji i development/preview są oddzielne. Zaimportowano sześć wcześniejszych demonstracji bez dopisywania fikcyjnych ręcznych akceptacji lub testów kuchennych. Konto właściciela `bartek@dajer.pl` oczekuje aktywacji; hasło ustawia właściciel. Jednorazowy link jest zapisany w prywatnym lokalnym pliku `.env.owner-activation-link`, ważnym przez 24 godziny od wydania. Nie wysłano wiadomości e-mail. Procedura: `src/server/auth/README.md`.

## Kolejny etap — rekomendacja

Połączenie kluczy OpenAI i fal.ai oraz rzeczywista próba generacji w gotowym Studio AI. Trwałe zadania, rezerwacje kosztów i prywatny Blob są zaimplementowane. Następnie testy kuchenne, serwerowy eksport PDF i pozostałe kryteria P0 z pierwotnej specyfikacji. DNS jesie.pl oraz adres logowania zostaną skonfigurowane przy podłączeniu docelowej domeny.

Fotografie demo zostały wygenerowane wbudowanym image_gen. Dokumentacja fotografii: artifacts/design/DESIGN.md, fotografia-manifest: artifacts/design/photography-manifest.json. Biblioteki i potrawy: public/images/. Nie wykonywano płatnych wywołań fal.ai/OpenAI — klucze dostawców pozostają do połączenia.

Przepisy są danymi demonstracyjnymi AI, bez testu kuchennego. Generowanie AI na żądanie oczekuje na klucze dostawców; serwerowy eksport PDF pozostaje poza obecnym etapem. Aktualny raport backendu: `artifacts/verification/BACKEND_VERIFICATION.md`; wcześniejszy raport publicznego interfejsu: `artifacts/verification/VERIFICATION.md`. Architektura: `Backend_redakcyjny.md`.
