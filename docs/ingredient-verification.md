# Weryfikacja nieznanych składników

Gdy odpowiedź przepisu zawiera nierozpoznaną nazwę PL lub EN, worker sprawdza istniejący słownik, a następnie zleca osobny, ograniczony research samej nazwy. Nie wysyła oryginalnych notatek ani całego przepisu do wyszukiwarki. Nowe tożsamości sprawdza kolejno, uruchamiając najwyżej jedno nowe zgłoszenie podczas danego odczytu przepisu; każde sprawdzenie ma limit dwóch wyszukiwań i 4096 tokenów wyjścia.

Wpis wymaga dokładnej tożsamości pojedynczego składnika, wysokiej pewności, zgodności kategorii oraz dwóch niezależnych faktycznie wyszukanych źródeł HTTPS. Źródło instytucjonalne musi potwierdzać zastosowanie kulinarne. Samo istnienie rośliny nie wystarcza. Nazwa zaproponowana jako literówka nie trafia do słownika i nie zmienia oryginału. Mieszanki, niejasne produkty i podpuszczka pozostają objęte dotychczasową kontrolą.

`ai_ingredient_verification` przechowuje niezmienne dane zapytania, potwierdzenie dostawcy, fakty i koszt. `ai_verified_ingredient_alias` udostępnia wyłącznie dokładne sprawdzone nazwy, bez dopasowania przybliżonego. Równoczesne zlecenia współdzielą zapis. Brak potwierdzenia POST blokuje ponowne płatne wysłanie; zapisane potwierdzenie umożliwia bezpieczny GET.

Wersja polityki dowodów jest oddzielna od klucza tożsamości. Zmiana filtra instytucji może ponownie ocenić tę samą opłaconą odpowiedź, zachowując jej źródła, fakty i koszt. Nie tworzy nowego researchu. Wynik negatywny według bieżącej polityki jest zapamiętany.

Zaufany słownik jest pobierany także przy zapisie, zastosowaniu wyniku, akceptacji treści i publikacji. Przeglądarka nie dostarcza własnego potwierdzenia. Linki źródłowe trafiają do prywatnego szkicu; koszty są ujęte raz przy pierwotnym zleceniu lub w researchu bez przepisu.

Wdrożenie wymaga migracji 0028 i 0029. Testy: `npm run test:ingredient-verification` oraz `npm run test:ingredient-verification:integration`. Drugie polecenie korzysta z odizolowanego schematu PostgreSQL i blokuje płatny transport. Pakiet odtwarzania bazy obejmuje nowe tabele i ochronę ich historii.
