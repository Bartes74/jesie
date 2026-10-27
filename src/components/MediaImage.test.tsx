import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MediaImage } from './MediaImage';
import { RecipeHeroImage } from './RecipeHeroImage';
import { RecipePhoto } from './RecipePhoto';

const src = '/media/c9fa7908-1c65-4e5d-9afc-66a1928cd227';

test('registered thumbnails deliver bounded native variants without the unauthenticated Next image proxy', () => {
  const html = renderToStaticMarkup(<MediaImage src={src} alt="" width={80} height={64} sizes="80px" maximumWidth={160} />);
  assert.match(html, /src="\/media\/c9fa7908-1c65-4e5d-9afc-66a1928cd227\?w=160&amp;d=2"/);
  assert.match(html, /sizes="80px"/); assert.match(html, /width="80"/); assert.match(html, /height="64"/);
  assert.match(html, /loading="lazy"/); assert.match(html, /decoding="async"/);
  assert.doesNotMatch(html, /_next\/image|320w|640w|1280w/);
});

test('public and private hero previews preserve fill composition and explicit priority with their own responsive variants', () => {
  for (const published of [true, false]) {
    const html = renderToStaticMarkup(<RecipeHeroImage src={src} published={published} alt="Danie" sizes="450px" loading="eager" fetchPriority="high" className="detail-dish" />);
    assert.match(html, /1600w/); assert.match(html, /loading="eager"/); assert.match(html, /fetchPriority="high"/i);
    assert.match(html, /position:absolute/); assert.match(html, /width:100%/); assert.match(html, /height:100%/);
    assert.match(html, /class="detail-dish"/); assert.doesNotMatch(html, /_next\/image/);
  }
});

test('registered media forwards load and error handlers so existing private preview recovery remains usable', () => {
  const onLoad = () => {};
  const onError = () => {};
  const image = MediaImage({ src, alt: 'Zdjęcie', width: 320, height: 240, onLoad, onError });
  assert.equal(image.props.onLoad, onLoad);
  assert.equal(image.props.onError, onError);
  assert.equal(image.props.loading, 'lazy');
});

test('standalone recipe photographs keep the crop viewport, decorative alt and small-source sizing', () => {
  const html = renderToStaticMarkup(<RecipePhoto media={{ src, columns: 1, rows: 1, index: 0, alt: { pl: 'Składnik', en: 'Ingredient' }, aspectRatio: 1 }} locale="pl" sizes="80px" legacySizes="320px" maximumWidth={320} className="ingredient-thumb" decorative />);
  assert.match(html, /recipe-photo-viewport ingredient-thumb/); assert.match(html, /sizes="80px"/); assert.match(html, /alt=""/);
  assert.match(html, /left:0%/); assert.match(html, /top:0%/); assert.match(html, /320w/); assert.doesNotMatch(html, /640w/);
});

test('legacy photographic atlases retain their original subject positioning and atlas-aware sizes', () => {
  const html = renderToStaticMarkup(<RecipePhoto media={{ src: '/images/ingredients-1.webp', columns: 4, rows: 3, index: 5, alt: { pl: 'Bazylia', en: 'Basil' } }} locale="pl" sizes="80px" legacySizes="320px" decorative />);
  assert.match(html, /sizes="320px"/); assert.match(html, /width:448/); assert.match(html, /height:336/);
  assert.match(html, /\/media\/static\/ingredients-1\.webp\?w=1600&amp;d=1/);
  assert.doesNotMatch(html, /_next\/image|[?&]d=2/);
});

test('safe legacy images use native capped srcset while preserving fill, priority, accessibility and handlers', () => {
  const onLoad = () => {};
  const onError = () => {};
  const image = MediaImage({ src: '/images/dish.webp', alt: 'Gotowe danie', fill: true, sizes: '450px', maximumWidth: 640,
    loading: 'eager', fetchPriority: 'high', decoding: 'sync', className: 'legacy-hero', style: { objectFit: 'contain' }, onLoad, onError });
  assert.equal(image.type, 'img');
  assert.equal(image.props.onLoad, onLoad); assert.equal(image.props.onError, onError);
  assert.equal(image.props.sizes, '450px'); assert.equal(image.props.alt, 'Gotowe danie');
  assert.equal(image.props.style.position, 'absolute'); assert.equal(image.props.style.width, '100%');
  assert.equal(image.props.style.objectFit, 'contain');
  const html = renderToStaticMarkup(image);
  assert.match(html, /src="\/media\/static\/dish\.webp\?w=640&amp;d=1"/);
  assert.match(html, /640w/); assert.doesNotMatch(html, /960w|_next\/image/);
  assert.match(html, /loading="eager"/); assert.match(html, /fetchPriority="high"/i); assert.match(html, /decoding="sync"/);
  assert.match(html, /class="legacy-hero"/);
});

test('legacy ingredients retain enough atlas width for the small viewport and preserve decorative positioning', () => {
  const html = renderToStaticMarkup(<RecipePhoto media={{ src: '/images/ingredients-1.webp', columns: 4, rows: 3, index: 5, alt: { pl: 'Bazylia', en: 'Basil' } }} locale="en" sizes="80px" legacySizes="320px" maximumWidth={320} decorative />);
  assert.match(html, /sizes="320px"/); assert.match(html, /alt=""/);
  assert.match(html, /left:-118/); assert.match(html, /top:-118/);
  assert.match(html, /1600w/); assert.doesNotMatch(html, /_next\/image/);
});

test('legacy standalone photographs keep locale alt, supplied sizes and their ordinary width cap', () => {
  const html = renderToStaticMarkup(<RecipePhoto media={{ src: '/images/standalone.png', columns: 1, rows: 1, index: 0, alt: { pl: 'Zdjęcie', en: 'Photograph' } }} locale="en" sizes="200px" maximumWidth={320} />);
  assert.match(html, /alt="Photograph"/); assert.match(html, /sizes="200px"/);
  assert.match(html, /width:100%/); assert.match(html, /left:0%/);
  assert.match(html, /320w/); assert.doesNotMatch(html, /480w|_next\/image/);
});

test('public legacy hero takes the durable route while keeping the complete fill frame and priority', () => {
  const html = renderToStaticMarkup(<RecipeHeroImage src="/images/lemon-pasta.webp" published alt="Makaron" sizes="700px" loading="eager" fetchPriority="high" />);
  assert.match(html, /\/media\/static\/lemon-pasta\.webp\?w=1600&amp;d=1/);
  assert.match(html, /sizes="700px"/); assert.match(html, /alt="Makaron"/);
  assert.match(html, /position:absolute/); assert.match(html, /width:100%/); assert.match(html, /height:100%/);
  assert.match(html, /loading="eager"/); assert.match(html, /fetchPriority="high"/i);
  assert.doesNotMatch(html, /_next\/image/);
});

test('legacy step atlases keep the established 21:9 viewport and atlas-aware source sizes', () => {
  const html = renderToStaticMarkup(<RecipePhoto media={{ src: '/images/steps-pumpkin-soup.webp', columns: 2, rows: 3, index: 3, aspectRatio: 1.5, alt: { pl: 'Krok', en: 'Step' } }} locale="en" sizes="600px" legacySizes="(max-width: 700px) 180vw, 100vw" maximumWidth={1600} viewportAspectRatio={21 / 9} />);
  assert.match(html, /\/media\/static\/steps-pumpkin-soup\.webp\?w=1600&amp;d=1/);
  assert.match(html, /alt="Step"/); assert.match(html, /sizes="\(max-width: 700px\) 180vw, 100vw"/);
  assert.match(html, /aspect-ratio:2\.333/); assert.match(html, /width:204%/); assert.match(html, /left:-103%/);
  assert.match(html, /object-fit:fill/); assert.doesNotMatch(html, /_next\/image/);
});

test('unsupported static or query-bearing sources retain the original component path', () => {
  for (const source of ['/images/dish.webp?version=1', '/images/logo.svg', '/images/%2e%2e/private.png']) {
    const image = MediaImage({ src: source, alt: 'Original', width: 320, height: 240 });
    assert.notEqual(image.type, 'img'); assert.equal(image.props.src, source);
  }
});

test('private collection artwork keeps its authenticated same-origin URL outside the image proxy', () => {
  const privateSrc = '/api/admin/collections/winter/assets/c9fa7908-1c65-4e5d-9afc-66a1928cd227';
  const image = MediaImage({ src: privateSrc, alt: 'Oprawa kolekcji', width: 1024, height: 1024 });
  assert.equal(image.props.src, privateSrc);
  assert.equal(image.props.unoptimized, true);
  const html = renderToStaticMarkup(image);
  assert.match(html, /src="\/api\/admin\/collections\/winter\/assets\/c9fa7908-1c65-4e5d-9afc-66a1928cd227"/);
  assert.doesNotMatch(html, /_next\/image/);
});

test('public collection artwork uses bounded responsive variants and preserves its aspect ratio', () => {
  const html = renderToStaticMarkup(<MediaImage src="/media/collections/c9fa7908-1c65-4e5d-9afc-66a1928cd227" alt="Kolekcja" width={1024} height={1024} maximumWidth={960} sizes="40vw" />);
  assert.match(html, /320w/); assert.match(html, /640w/); assert.match(html, /960w/);
  assert.match(html, /width="1024" height="1024"/); assert.match(html, /sizes="40vw"/);
  assert.doesNotMatch(html, /1280w|1600w|_next\/image/);
});
