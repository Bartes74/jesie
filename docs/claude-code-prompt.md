# Prompt pierwszej sesji Claude Code

Uruchom `claude` w katalogu projektu i wklej poniższy tekst. Stałe instrukcje są w CLAUDE.md; procedury: [przekazanie](claude-code-handoff.md).

```text
Przejmujesz rozwój działającego projektu jesie.pl. Repozytorium:
https://github.com/Bartes74/jesie

Pierwsze zadanie to przejęcie projektu i audyt. Podczas tego audytu
nie zmieniaj kodu, danych ani konfiguracji usług.

Przeczytaj CLAUDE.md, AGENTS.md, README i instrukcję przekazania.
Następnie sprawdź aktualny kod oraz odpowiednie runbooki. Dokumentacja
może zawierać starsze ustalenia, więc rozbieżności porównuj z kodem.
Przed proponowaniem zmian Next.js przeczytaj właściwe dokumenty
z node_modules/next/dist/docs/.

To istniejący serwis produkcyjny PL/EN. Zachowujemy jego styl,
nawigację i sposób obsługi. Projekt obejmuje katalog przepisów,
panel redakcyjny, generowanie treści i fotografii, kolekcje,
zestawy potraw, zakupy, SEO oraz kopie zapasowe.

Kolekcje zostały już wdrożone. Migracje 0030/0031 wykonano na
produkcji; nie traktuj ich jako oczekujących. Ostatni zweryfikowany
stan obejmował 44 opublikowane przepisy, cztery kolekcje i publiczną
kopię v2. Sprawdź aktualność tych informacji przed dalszymi pracami.

Nie ujawniaj sekretów. Przed operacjami na bazie potwierdzaj
środowisko bez wypisywania danych dostępowych. Testy integracyjne
wykonuj wyłącznie w przeznaczonym do tego środowisku.
Wdrożenia, migracje produkcyjne, publikowanie treści i płatne
generowanie wymagają konkretnego zlecenia.

Wykonaj:
1. Mapę architektury i głównych przepływów danych.
2. Ocenę gotowości środowiska lokalnego.
3. Bezpieczne testy bazowe zgodnie z instrukcją projektu.
4. Audyt kolekcji: panel, publikacja, podglądy, PL/EN, zestawy,
   porcje, zakupy i trwałość zapisu.
5. Ocenę powtarzalności uruchomienia świeżego klonu.
6. Listę usterek i braków z dowodami, wagą oraz wpływem na użytkownika.

Oddziel potwierdzone problemy od przypuszczeń. Przy pominiętym
teście podaj powód; nie przedstawiaj go jako zaliczonego.

Na koniec przedstaw wyniki, trzy najważniejsze następne zadania
i szczegółowy plan pierwszego z nich. Nie rozpoczynaj jeszcze
implementacji nowej funkcjonalności.
```
