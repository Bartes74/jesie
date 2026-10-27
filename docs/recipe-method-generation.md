# Generowanie etapów przygotowania

## Zasady

`src/server/ai/recipe-method.ts` zawiera wspólny kontrakt metody i brief trendów. Korzystają z niego ręczne opracowanie, aktywny automat, starsza ścieżka radaru oraz naprawy wyników. Nie ma redakcyjnego minimum ani limitu 6/8 kroków lub 8/12 składników. Liczba etapów wynika z metody, samodzielnych procesów i punktów decyzji.

Krok prowadzi do jednego rozpoznawalnego rezultatu. Powiązane drobne czynności mogą zostać razem. Niezależna obróbka lub osobno kontrolowane oczekiwanie otrzymują własny etap, gdy pomaga to wykonać danie. Sama liczba zdań lub zmiana przyboru nie jest powodem podziału.

Instrukcja zawiera potrzebne warunki, oznaki zakończenia, orientacyjny czas i jego początek tam, gdzie jest potrzebny, oraz dalsze działanie przy braku oczekiwanego efektu. Prosta czynność nie wymaga redundantnego „gotowe, gdy…”. Czas nie zastępuje sprawdzenia gotowości. Jeden minutnik oznacza jeden konkretny ciągły przedział; nie sumuje osobnych oczekiwań. Przy pracy równoległej instrukcja mówi, co nadal trwa, kiedy można rozpocząć następne zadanie i gdzie trzeba sprawdzić gotowość przed połączeniem wyników. PL i EN opisują te same zależności.

Opisy pól w Structured Outputs przypominają te zasady, ale nie zmieniają kształtu odpowiedzi. Warunek przejścia pozostaje w `step.text`; nie dodano nowego pola ani wersji schematu. Stare przyjęte odpowiedzi i historyczne publikacje pozostają zgodne. Nowe lub faktycznie podzielone etapy powinny mieć nowe ID; zachowanie postępów nadal zależy od wersji całej metody.

Zasady promptu korzystają z jawnych wymagań i przykładów różnych granic etapów, zgodnie z [OpenAI Docs — prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering). Testy obejmują faktyczny request i request naprawy, również dla utrwalonego starszego briefu zawierającego limit 6/8.

## Fotografie i limity

Czysty builder `image-prompt.ts` jest współdzielony przez dostawcę i preflight. Przed nowym pakietem fotografii system buduje wszystkie planowane prompty, zachowując pełny tekst. Sprawdza limit 32 000 znaków Unicode promptu (nie bajtów UTF-8) i 60000 bajtów aktualnego wejścia. Aktywne/starsze trendy i ręczne pakiety wykonują kontrolę przed nowymi płatnymi fotografiami. Wznowienie starych pakietów i nowe sloty też mają tę kontrolę; odczyt istniejącego przyjętego wyniku nie jest nową generacją i pozostaje dostępny.

Blokada podaje rodzaj/krok i powód oraz zachowuje kompletny szkic. Nie skraca metody. Zachowano bezpieczniki: 100 składników i 100 kroków, 40 miejsc fotograficznych trendu, 201 brakujących fotografii ręcznego pakietu, ograniczenie równoległości i idempotencję. Dłuższa metoda może wymagać większej liczby zdjęć i zatrzymać się na technicznym limicie pakietu. Administrator może przygotować odpowiednie fotografie ręcznie; nie ma presji na skracanie instrukcji dla zdjęć.

Preflight dotyczy pełnego aktualnego wejścia. Metadane zdjęć dopisywane podczas długiego pakietu mogą później zwiększyć jego rozmiar; kontrola każdego nowego admission nadal odrzuci przekroczenie 60 KB. Nie projektujemy nieznanych przyszłych metadanych i nie osłabiamy tego limitu.

## Weryfikacja i wdrożenie

- `npm run test:providers`: kontrakt promptów, reprezentacja metod 3/12 kroków, zgodność starych wyników, preflight i zatrzymanie rzeczywistych punktów admission przed zapisem nowego zlecenia.
- `npm run test:photo-batches`: pakiety, workflow, wznowienie i brak ponownego płatnego zlecenia.
- Testy codziennych workflow i odpowiednie integracje trendów: zatwierdzenie treści, osobne zlecenie i fotografie w poprawnej kolejności oraz zachowanie konkretnego powodu blokady.
- TypeScript, ESLint i kompilacja produkcyjna.

Przykłady 3/12 kroków są jawnie przygotowanymi fixture'ami testowymi: dowodzą zachowania treści, kolejności, czasów i warunków w pipeline, a nie jakości nowego wyniku modelu. Testy dostawców używają atrap transportu. Nie jest to test gotowania ani automatyczna semantyczna certyfikacja poprawności receptury. Przegląd redakcyjny nadal powinien sprawdzić proporcje, sens granic etapów, gotowość, minutniki, oba języki i zdjęcia.

Zmiana dotyczy nowych zleceń i napraw wysyłanych z nowej wersji aplikacji. Nie przepisuje już opublikowanych treści ani nie ponawia przyjętych zleceń. Nie wymaga migracji bazy. Dawny zegar publikacji pozostaje historyczny. Aktualny cron przygotowuje tekst szkicu, a zdjęcia i publikacja wymagają osobnych decyzji administratora. Nie ma finansowych limitów ani rezerwacji; raportowane są rzeczywiste koszty.
