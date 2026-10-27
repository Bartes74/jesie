# Fotograficzna książka kucharska

Wymaganie użytkownika z 3 października 2026: wizualna lista składników spójna ze zdjęciem potrawy, zdjęcie przy każdym kroku pokazujące kluczowy detal, konsystencję lub etap przygotowania.

## Rekomendowany układ

Każdy składnik ma fotograficzną miniaturę, nazwę, aktualną ilość i checkbox. Zdjęcia na jasnym tle wykorzystują to samo miękkie światło i ciepłą kolorystykę co potrawa. Ilości nie są zapisane w grafice: HTML zachowuje czytelność, dostępność i prawidłowe przeliczanie porcji.

Każdy krok ma własne zdjęcie detalu oraz krótki podpis „na co patrzeć”: np. tylko żółta skórka cytryny, sos otulający makaron, suche nadzienie pierogów, ścięte brzegi placuszków, złota kruszonka. Zdjęcie gotowego dania nie zastępuje fotografii etapu. Na telefonie zdjęcia kroków zajmują szerokość treści, a składniki pozostają w czytelnych wierszach.

## Rekomendowany model i proces docelowy

fal.ai pozostaje rekomendowanym serwisem, z modelem obrazu wskazanym w dokumencie rekomendacji. Biblioteka składników jest współdzielona między przepisami, wersjonowana i weryfikowana ręcznie. Generowanie każdego przepisu nie powiela zdjęć soli, masła czy mąki.

Dla zdjęć kroków zapisujemy `recipeVersionId`, `stepId`, rolę zdjęcia, opis detalu i oczekiwanej konsystencji, prompt, model, parametry, assetId, sumę kontrolną i status weryfikacji. Jako referencje stylistyczne używamy zaakceptowanego zdjęcia potrawy. Zdjęcie musi odpowiadać konkretnemu etapowi oraz faktycznym składnikom; nie może przedstawiać innych dodatków, niewłaściwego narzędzia ani sprzecznego stopnia obróbki.

Zmiana liczby porcji nie generuje nowych fotografii. Zdjęcia pokazują metodę i konsystencję, a opisane ilości wylicza wspólny kalkulator. Wersja opublikowana zamraża fotografie, podpisy i powiązania tak samo jak tekst. Prawdziwe zdjęcia autora można w przyszłości podmienić w tych samych polach bez zmiany układu.

Ilustracje AI wspierają instrukcję, a akceptację jakości kulinarnej potwierdza test kuchenny i ocena redakcyjna. Nie traktujemy wyglądu AI jako dowodu prawidłowo ugotowanej potrawy.

## Implementacja demo

Wszystkie 6 przepisów otrzymuje fotografie składników i zdjęcia przy każdym kroku oraz podpisy PL/en-GB. Źródłowe fotografie generuje wbudowane `image_gen`; na etapie demo nie wywołujemy płatnego API fal.ai. Atlasy fotograficzne ułatwiają wspólne ładowanie miniatur i zachowują jednolity styl. Każdy viewport pokazuje jedno zdjęcie przypisane do składnika lub kroku; sam interfejs jest HTML/CSS, a reference nie jest używane jako obraz interfejsu.

Druk ilustrowany zawiera fotografie. Wariant oszczędny i tekstowy pomija fotografie. Oba warianty zachowują aktualne porcje i jednostki.
