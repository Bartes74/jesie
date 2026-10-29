import { z } from 'zod';

const localized = z.object({
  heading: z.string().trim().min(1).max(200),
  lead: z.string().trim().max(500),
  description: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20000),
}).strict();
export const aboutPageContentSchema = z.object({ pl: localized, en: localized }).strict();
export type AboutPageContent = z.infer<typeof aboutPageContentSchema>;
export type AboutPageRecord = { revision: number; content: AboutPageContent; updatedAt: string; updatedByName: string };
export type AboutSection = { heading: string | null; paragraphs: string[] };

/** Body is plain text: blocks are separated by a blank line and a "## " block opens a new section. */
export function aboutSections(body: string): AboutSection[] {
  const sections: AboutSection[] = [];
  for (const block of body.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(item => item.trim()).filter(Boolean)) {
    if (block.startsWith('## ')) sections.push({ heading: block.slice(3).trim(), paragraphs: [] });
    else {
      if (!sections.length) sections.push({ heading: null, paragraphs: [] });
      sections[sections.length - 1].paragraphs.push(block.replace(/\s*\n\s*/g, ' '));
    }
  }
  return sections;
}

/** Built-in text served until an editor saves the page, and whenever the database is unavailable. */
export const defaultAboutPage: AboutPageContent = {
  pl: {
    heading: 'Dobre jedzenie na co dzień.',
    lead: 'Rodzinna książka kucharska, do której łatwo wrócić.',
    description: 'Rodzinna książka kucharska do codziennego gotowania: dostępne składniki, dopasowane porcje i instrukcje krok po kroku.',
    body: `## Gotowanie po swojemu

jesie.pl powstało z myślą o codziennych posiłkach w domu. Zbieramy przepisy, które pomagają wybrać danie, przygotować składniki i przejść przez gotowanie bez szukania informacji w wielu miejscach.

Liczbę porcji dopasujesz do swojego stołu. Ilości na liście składników i w instrukcji przeliczają się razem. Możesz zapisywać ulubione dania, odhaczać kroki i wydrukować przepis z aktualnymi ilościami.

## Opracowanie przepisów

Materiały są opracowywane pod marką jesie.pl. Nowe publikacje przechodzą przegląd treści, ilości, instrukcji i ilustracji. Gdy sprawdzimy danie podczas domowego gotowania, uwagi wykorzystujemy do kolejnych poprawek.

Data przy przepisie wskazuje pierwszą publikację. Datę aktualizacji zmieniamy przy poprawkach opublikowanej treści. Porady i zamienniki znajdziesz bezpośrednio przy przepisie.`,
  },
  en: {
    heading: 'Good food every day.',
    lead: 'A family cookbook that is easy to return to.',
    description: 'A family cookbook for everyday cooking: available ingredients, adjustable servings and step-by-step instructions.',
    body: `## Cook your way

jesie.pl was created for everyday meals at home. We collect recipes that help you choose a dish, prepare ingredients and follow the method without searching for information in different places.

Adjust servings to your table. Quantities in the ingredient list and method update together. Save favourites, tick off steps and print the recipe with the quantities you need.

## Recipe editing

Content is edited under the jesie.pl name. New publications are reviewed for content, quantities, instructions and illustrations. When a dish is checked through home cooking, the notes inform later improvements.

The date beside a recipe shows its first publication. The update date changes when published content is revised. Find tips and substitutions directly on the recipe page.`,
  },
};
