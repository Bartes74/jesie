@AGENTS.md

# jesie.pl — instrukcje projektu

Repozytorium: https://github.com/Bartes74/jesie (prywatne). Serwis: https://www.jesie.pl.
Komunikuj się po polsku. To działający serwis, nie nowy projekt.

## Najpierw kontekst

- Przeczytaj `docs/claude-code-handoff.md`; prompt pierwszego audytu: `docs/claude-code-prompt.md`.
- Przed zmianami Next.js czytaj odpowiedni przewodnik w `node_modules/next/dist/docs/`. Zachowaj generowany blok AGENTS.md.
- Kod i aktualne runbooki są nadrzędne wobec historycznych specyfikacji w głównym katalogu. Nie przywracaj dawnych funkcji na podstawie starego opisu.
- Zachowuj styl jesie.pl, Lora/Manrope, nawigację, PL/en-GB i znane kontrolki.

## Stos i moduły

Node 24.x (`.nvmrc`), npm/lockfile, Next.js 16.3.8 App Router, React 19, TypeScript, PostgreSQL/Neon + Drizzle, Better Auth, prywatny Vercel Blob i Workflow; generowanie OpenAI/fal.ai.

- `src/app`: strony PL/EN, panel /admin, API, cron i media.
- `src/components`: interfejs; `src/lib`: reguły domenowe, porcje, zakupy i wersjonowany localStorage.
- `src/server/editorial`, `ai`, `trends`, `collections`: treść, generowanie, inspiracje i kolekcje.
- `src/server/public`, `seo`, `media*`: publikacje, snapshoty, odkrywanie, media i kopie.
- `src/workflows`: trwałe zadania; `migrations` i `scripts`: schemat i operacje.

## Komendy

```sh
npm ci
npm run dev -- --hostname 127.0.0.1
npm run lint
npm test
npm run test:collections
npm run build
npm run typecheck
```

Build tworzy typy tras; na świeżym klonie wykonaj go przed samodzielnym typecheck. Na wolnym dysku można użyć `npm run build -- --webpack`. Testy integracyjne nie należą do podstawowego CI; sprawdź wymagania konkretnego skryptu i bazę.

## Dane i środowiska

- .env.local służy osobnej bazie development. Nie nadpisuj konfiguracji użytkownika. Potwierdzaj środowisko przez bezpieczne metadane, bez wypisywania DSN, haseł, tokenów lub linków aktywacji.
- Migracje i seed wykonuj dla potwierdzonego celu. Starsze runnery respektują odziedziczone DATABASE_URL; sama nazwa pliku nie potwierdza celu.
- Nie zmieniaj zastosowanych migracji. Dodaj nową i uaktualnij pakiet schematu backupu, jeśli zmieniasz bazę.
- Zachowuj niezmienną historię publikacji, odrębne stany szkicu/akceptacji/publikacji i expectedRevision.
- Nie ujawniaj szkiców, inspiracji, researchu i prywatnych mediów. Snapshoty podlegają walidacji i unieważnieniu przed zmianą publikacji.

## Aktualne reguły produktu

- Codzienna inspiracja tworzy tekst szkicu. Człowiek ocenia treść, osobno zleca zdjęcia i ręcznie publikuje. Nie przywracaj publikowania o 06:00.
- Brak finansowych limitów i rezerwacji. Raportuj potwierdzone koszty; brak rachunku nie oznacza zera. Zachowuj równoległość i ochronę przed powieleniem płatnego POST-a.
- Kolekcje działają cały rok; daty dotyczą promocji hero. Stare kolekcje mają próg odkrywania 5 dań, nowe minimum 1. Dobór „do 30 minut” jest automatyczny, pozostały ręczny.
- Zestaw kolekcji nie ma limitu 3 dań. Limit 3 dotyczy osobnego planu. Zakupy sumują zgodne produkty/jednostki z uwzględnieniem porcji i zamienników.

## Praca

Realizuj zlecone odwracalne zmiany lokalne bez dodatkowych pytań o rutynowe decyzje. Nie nadpisuj pracy użytkownika. Pracuj na osobnej gałęzi, testuj adekwatny zakres, opisuj wynik i ograniczenia.

Wdrożenia, migracje produkcyjne, publikowanie treści i płatne generowanie wymagają konkretnego zlecenia użytkownika; przejęcie projektu go nie zastępuje. `vercel.json` wyłącza automatyczne wdrożenie produkcji po pushu do main; pozostałe gałęzie mogą otrzymywać podglądy Vercel. Pełne wdrożenie ze świeżego klonu wymaga prywatnych archiwów poza Git — patrz instrukcja przekazania.
