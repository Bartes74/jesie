import { isStepPhotoRequired, validStepPhotoOmission } from '@/lib/step-photo-selection';
import { MediaImage } from '@/components/MediaImage';
import { AlertCircle, Check, ImagePlus, LoaderCircle } from 'lucide-react';
import { RecipePhoto } from '@/components/RecipePhoto';
import type { EditorialRecord } from '@/lib/editorial-types';
import type { MediaTile } from '@/lib/recipe-media';
import type { TrendRun } from '@/lib/trend-types';
import { STEP_PHOTO_ASPECT_RATIO } from '@/lib/recipe-photo-layout';

export type TrendPhotoTarget = { kind: 'hero' | 'ingredient' | 'step'; targetId?: string };

const inProgress = new Set(['queued', 'submitting', 'generating']);
const stopped = new Set(['failed', 'uncertain', 'cancelled']);

function photoState(run: TrendRun, target: TrendPhotoTarget, present: boolean) {
  const job = run.photos.jobs?.find(item => item.kind === target.kind && (target.kind === 'hero' || item.targetId === target.targetId));
  if (job && inProgress.has(job.status)) return { label: present ? 'Przygotowuję nowe zdjęcie' : 'Przygotowuję zdjęcie', state: 'working' as const };
  if (job && stopped.has(job.status)) return { label: present ? 'Poprzednie zdjęcie zachowane · nowa próba wymaga uzupełnienia' : 'Zdjęcie wymaga uzupełnienia', state: 'missing' as const };
  if (present) return { label: 'Gotowe do sprawdzenia', state: 'ready' as const };
  return { label: 'Brakuje zdjęcia', state: 'missing' as const };
}

function PhotoCard({ title, target, media, hero, run }: {
  title: string;
  target: TrendPhotoTarget;
  media?: MediaTile;
  hero?: { src: string; alt: string };
  run: TrendRun;
}) {
  const present = Boolean(media?.src || hero?.src);
  const state = photoState(run, target, present);
  return <article className={'admin-trend-photo-card is-' + target.kind}>
    <div className="admin-trend-photo-image">
      {hero?.src ? <MediaImage src={hero.src} alt={hero.alt || title} width={640} height={640} sizes="(max-width: 600px) calc(100vw - 80px), 360px" maximumWidth={960} /> : media?.src ? <RecipePhoto media={media} locale="pl" sizes="(max-width: 600px) calc(100vw - 80px), 360px" maximumWidth={960} viewportAspectRatio={target.kind === 'step' ? STEP_PHOTO_ASPECT_RATIO : 1} /> : <div className="admin-trend-photo-placeholder"><ImagePlus size={28} strokeWidth={1.3} /><span>Zdjęcie pojawi się tutaj</span></div>}
    </div>
    <div className="admin-trend-photo-caption"><h4>{title}</h4>{target.kind === 'step' && media?.caption?.pl && <p className="admin-trend-photo-cue">{media.caption.pl}</p>}<p className={'admin-trend-photo-state is-' + state.state} role={state.state === 'working' ? 'status' : undefined}>{state.state === 'working' ? <LoaderCircle size={13} className="admin-spinner" /> : state.state === 'ready' ? <Check size={13} /> : <AlertCircle size={13} />}{state.label}</p>
    </div>
  </article>;
}

export function TrendPhotos({ recipe, run }: { recipe: EditorialRecord; run: TrendRun }) {
  const content = recipe.content;
  return <section className="admin-trend-photos" aria-labelledby="trend-photos-heading">
    <div className="admin-trend-photo-heading"><h3 id="trend-photos-heading">Wszystkie fotografie</h3><p>Sprawdź danie, składniki i każdy krok. Zdjęcia zlecasz i zmieniasz w edytorze po akceptacji treści. Wyniki i rzeczywiste koszty pozostają zapisane w historii.</p>{run.status === 'published' && <p>Nowe zdjęcie zmieni opublikowany przepis dopiero po ponownej publikacji.</p>}</div>
    <h4 className="admin-trend-photo-group-title">Gotowe danie</h4>
    <div className="admin-trend-photo-grid is-hero"><PhotoCard title={content.recipe.title.pl || 'Gotowe danie'} target={{ kind: 'hero' }} hero={content.recipe.image ? { src: content.recipe.image, alt: content.recipe.imageAlt.pl } : undefined} run={run} /></div>
    <h4 className="admin-trend-photo-group-title">Składniki · {content.recipe.ingredients.length}</h4>
    <div className="admin-trend-photo-grid">{content.recipe.ingredients.map(ingredient => <PhotoCard key={ingredient.id} title={ingredient.name.pl || 'Składnik'} target={{ kind: 'ingredient', targetId: ingredient.id }} media={content.photos.ingredients[ingredient.id]} run={run} />)}</div>
    <h4 className="admin-trend-photo-group-title">Kroki przygotowania · {content.recipe.steps.length}</h4>
    <div className="admin-trend-photo-grid is-steps">{content.recipe.steps.map((step, index) => content.photos.steps[step.id] || isStepPhotoRequired(content, step.id)
      ? <PhotoCard key={step.id} title={`${index + 1}. ${step.title.pl || 'Krok przygotowania'}`} target={{ kind: 'step', targetId: step.id }} media={content.photos.steps[step.id]} run={run} />
      : <article key={step.id} className="admin-trend-photo-card is-step"><div className="admin-trend-photo-caption"><h4>{index + 1}. {step.title.pl}</h4><p>{validStepPhotoOmission(content, step.id)?.reason.pl || 'Ten krok nie wymaga osobnej fotografii. Instrukcja pozostaje w przepisie.'}</p></div></article>)}</div>
  </section>;
}
