'use client';
import { formatRecipeDurationText } from '@/lib/recipe-duration-text';
import type { EditorialContent, RecipeSummary } from '@/lib/editorial-types';
import type { Locale } from '@/lib/recipes';
import Link from 'next/link';

type Props = { content: EditorialContent; locale: Locale; recipes: RecipeSummary[]; onChange: (mutate: (draft: EditorialContent) => void) => void };
function settings(draft: EditorialContent) { return draft.recipe.seo ??= {}; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="admin-field">{label}{children}</label>; }
export function RecipeSeoFields({ content, locale, recipes, onChange }: Props) {
  const seo = content.recipe.seo;
  function text(field: 'title' | 'description', value: string) { onChange(draft => { const s = settings(draft); s[field] ??= { pl: '', en: '' }; s[field][locale] = value; }); }
  function selected(field: 'relatedRecipeIds', id: string, checked: boolean) { onChange(draft => { const s = settings(draft); const set = new Set(s[field] ?? []); if (checked) set.add(id); else set.delete(id); s[field] = [...set].slice(0, 10); }); }
  function kitchen(field: 'date' | 'tester' | 'notes', value: string) { onChange(draft => { draft.kitchenTest ??= { date: '', tester: '', notes: '' }; draft.kitchenTest[field] = value; }); }
  return <>
    <section className="admin-section"><h2>Tytuł i opis w wyszukiwarce</h2><p>Puste pola korzystają z nazwy i opisu dania. Edytujesz wersję {locale.toUpperCase()}.</p>
      <Field label="Tytuł"><input maxLength={500} value={seo?.title?.[locale] ?? ''} placeholder={content.recipe.title[locale]} onChange={e => text('title', e.target.value)} /><small>Około 50–60 znaków to wskazówka, nie limit. Nazwę serwisu dodamy automatycznie.</small></Field>
      <Field label="Opis"><textarea rows={3} maxLength={500} value={seo?.description?.[locale] ?? ''} placeholder={content.recipe.description[locale]} onChange={e => text('description', e.target.value)} /><small>Smak, istotna cecha i rzeczywiste korzyści przepisu. Orientacyjnie 140–160 znaków.</small></Field>
      <Field label="Dodatkowe określenia dania"><input value={seo?.keywords?.[locale]?.join(',') ?? ''} placeholder="np. jedna patelnia, obiad dla dwojga" onChange={e => onChange(draft => { const s = settings(draft); s.keywords ??= { pl: [], en: [] }; s.keywords[locale] = e.target.value.split(',').slice(0, 12); })} /><small>Rozdziel przecinkami. Użyj kilku trafnych określeń.</small></Field>
      <div className="admin-search-preview"><small>jesie.pl › {content.recipe.slug[locale] || 'przepis'}</small><h3>{seo?.title?.[locale] || content.recipe.title[locale]} | jesie.pl</h3><p>{formatRecipeDurationText(seo?.description?.[locale] || content.recipe.description[locale], locale)}</p></div>
    </section>
    <section className="admin-section"><h2>Kolekcje</h2><p>Przepisy, ich kolejność i oprawę wydarzenia wybierzesz w edytorze kolekcji.</p>
      <Link className="admin-text-link" href={`/admin/collections?recipe=${encodeURIComponent(content.recipe.id)}`}>Zarządzaj kolekcjami tego przepisu</Link>
    </section>
    <section className="admin-section"><h2>Powiązane przepisy</h2><p>Wybierz bliskie tematycznie dania. Czytelnicy zobaczą tylko opublikowane przepisy; pozostałe propozycje dobierzemy z biblioteki.</p>
      {recipes.filter(item => !item.deletedAt && item.id !== content.recipe.id && item.editorialStatus !== 'archived').map(item => <label className="admin-checkbox" key={item.id}><input type="checkbox" checked={seo?.relatedRecipeIds?.includes(item.id) ?? false} onChange={e => selected('relatedRecipeIds', item.id, e.target.checked)} /><span>{item.title.pl || item.title.en}{item.publicationStatus !== 'published' ? ' · szkic' : ''}</span></label>)}
    </section>
    <section className="admin-section"><h2>Pytania przy gotowaniu</h2><p>Dodaj tylko pytania przydatne do tego dania. Odpowiedzi pojawią się w treści przepisu; uzupełnij oba języki.</p>
      {(seo?.questions ?? []).map((item, index) => <div className="admin-step-editor" key={item.id}><Field label="Pytanie"><input value={item.question[locale]} onChange={e => onChange(draft => { draft.recipe.seo!.questions![index].question[locale] = e.target.value; })} /></Field><Field label="Odpowiedź"><textarea rows={3} value={item.answer[locale]} onChange={e => onChange(draft => { draft.recipe.seo!.questions![index].answer[locale] = e.target.value; })} /></Field><button type="button" className="admin-button is-subtle" onClick={() => onChange(draft => { draft.recipe.seo!.questions!.splice(index, 1); })}>Usuń pytanie</button></div>)}
      <button type="button" className="admin-button is-secondary" disabled={(seo?.questions?.length ?? 0) >= 8} onClick={() => onChange(draft => { const s = settings(draft); s.questions ??= []; s.questions.push({ id: `question-${crypto.randomUUID().slice(0, 8)}`, question: { pl: '', en: '' }, answer: { pl: '', en: '' } }); })}>Dodaj pytanie</button>
    </section>
    <section className="admin-section"><h2>Prywatny zapis testu w kuchni</h2><p>Data, osoba i wynik pozostają w panelu. Zapisuj rzeczywiste próby i poprawki.</p><Field label="Data próby"><input type="date" value={content.kitchenTest?.date ?? ''} onChange={e => kitchen('date', e.target.value)} /></Field><Field label="Kto gotował"><input value={content.kitchenTest?.tester ?? ''} onChange={e => kitchen('tester', e.target.value)} /></Field><Field label="Wynik i uwagi"><textarea rows={4} value={content.kitchenTest?.notes ?? ''} onChange={e => kitchen('notes', e.target.value)} /></Field><label className="admin-checkbox"><input type="checkbox" checked={content.recipe.provenance.kitchenTested} onChange={e => onChange(draft => { draft.recipe.provenance.kitchenTested = e.target.checked; })} /><span>Przepis został sprawdzony w kuchni. Uzupełniłem datę, osobę i wynik.</span></label></section>
  </>;
}
