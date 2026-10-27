import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import sharp from 'sharp';
import { hashPassword } from 'better-auth/crypto';
import { parseVaultManifest, type VaultManifest } from './media-backup-vault';
import type { EditorialContent } from '../src/lib/editorial-types';
import { getRecipeImageVariants } from '../src/lib/recipe-image-variants';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const restoreSandboxProfile = '(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip "localhost:*")) (allow network-outbound (remote unix-socket))';
const secretNames = ['OPENAI_API_KEY', 'FAL_KEY', 'FAL_API_KEY', 'FAL_BILLING_KEY', 'BLOB_READ_WRITE_TOKEN', 'BLOB_STORE_ID', 'CRON_SECRET', 'INDEXNOW_KEY', 'VERCEL_TOKEN', 'VERCEL_OIDC_TOKEN'];
const safeName = (value: string) => /^[a-z][a-z0-9_]{0,62}$/.test(value);
function fail(code: string): never { throw new Error(code); }
const quote = (value: string) => { if (!safeName(value)) fail('RESTORE_DATABASE_IDENTIFIER_INVALID'); return `"${value}"`; };
async function privateDirectory(path: string) {
  if (!isAbsolute(path)) fail('RESTORE_ABSOLUTE_DIRECTORY_REQUIRED');
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) fail('RESTORE_CANONICAL_DIRECTORY_REQUIRED');
  await chmod(path, 0o700);
}
async function safeJson(path: string, value: unknown) { await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
export function restoreEnvironment(options: { socketPath: string; databaseUrl: string; port: number; guard: string; guardLogs: string; offlineMedia: string; authSecret: string }): NodeJS.ProcessEnv {
  const url = new URL(options.databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'localhost' || url.password
    || url.searchParams.get('host') !== dirname(options.socketPath) || !isAbsolute(options.socketPath)
    || options.authSecret.length < 32) fail('RESTORE_ENV_LOCAL_DATABASE_REQUIRED');
  return {
    PATH: '/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    NODE_ENV: 'production', VERCEL_ENV: 'preview', SEO_INDEXING_ENABLED: 'false', NEXT_TELEMETRY_DISABLED: '1',
    DATABASE_URL: options.databaseUrl, BETTER_AUTH_URL: `http://127.0.0.1:${options.port}`, BETTER_AUTH_SECRET: options.authSecret,
    NODE_OPTIONS: `--require=${JSON.stringify(options.guard)}`,
    JESIE_RESTORE_GUARD: '1', JESIE_RESTORE_HTTP_PORT: String(options.port), JESIE_RESTORE_SOCKET_PATH: options.socketPath,
    JESIE_RESTORE_GUARD_LOG_DIRECTORY: options.guardLogs, JESIE_RESTORE_MEDIA_ROOT: options.offlineMedia,
    LANG: 'en_US.UTF-8', TZ: 'Europe/Warsaw',
  };
}

type LocalRecoveryEntry = { file: string; byteLength: number; sha256: string; contentType: 'image/png' | 'image/webp' | 'image/jpeg' };
export async function prepareOfflineMedia(options: { manifest: VaultManifest; restoredMedia: string; directory: string;
  mappings: { source_pathname: string; target_pathname: string; target_sha256: string; target_bytes: number }[] }) {
  await privateDirectory(options.directory);
  const entries: Record<string, LocalRecoveryEntry> = Object.create(null);
  for (const entry of options.manifest.entries.filter(value => value.source === 'blob' && value.pathname.startsWith('ai/'))) {
    const path = join(options.restoredMedia, 'blob', entry.pathname);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes || entry.bytes > 32 * 1024 * 1024) fail('RESTORE_MEDIA_FILE_INVALID');
    const bytes = await readFile(path);
    if (sha(bytes) !== entry.sha256) fail('RESTORE_MEDIA_SHA_MISMATCH');
    const metadata = await sharp(bytes, { limitInputPixels: 8_500_000, failOn: 'error' }).metadata();
    const format = metadata.format === 'jpeg' ? 'jpeg' : metadata.format;
    if (!['png', 'webp', 'jpeg'].includes(format ?? '') || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) fail('RESTORE_RASTER_INVALID');
    const contentType = `image/${format}` as LocalRecoveryEntry['contentType'];
    const file = `${entry.sha256}.${format === 'jpeg' ? 'jpg' : format}`;
    const target = join(options.directory, file);
    try { await lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await copyFile(path, target); await chmod(target, 0o600); }
    if (sha(await readFile(target)) !== entry.sha256) fail('RESTORE_LOCAL_MEDIA_COPY_MISMATCH');
    entries[entry.pathname] = { file, byteLength: entry.bytes, sha256: entry.sha256, contentType };
  }
  for (const mapping of options.mappings) {
    const retained = entries[mapping.target_pathname];
    if (!retained || retained.sha256 !== mapping.target_sha256 || retained.byteLength !== mapping.target_bytes) fail('RESTORE_COMPACTION_TARGET_MISSING');
    entries[mapping.source_pathname] = retained;
  }
  await safeJson(join(options.directory, 'manifest.json'), { version: 1, entries });
  return { paths: Object.keys(entries).length, files: new Set(Object.values(entries).map(entry => entry.file)).size };
}

/** This patches only the disposable test copy, never the archived source or working project. */
export async function patchRestoreCopy(app: string) {
  const storage = `import 'server-only';\nimport { createLocalRecoveryReader } from '@/server/media/local-recovery';\nif(process.env.JESIE_RESTORE_GUARD!=='1'||!process.env.JESIE_RESTORE_MEDIA_ROOT)throw new Error('RESTORE_OFFLINE_GUARD_REQUIRED');\nconst readOffline=createLocalRecoveryReader({rootDirectory:process.env.JESIE_RESTORE_MEDIA_ROOT});\nexport async function getMediaBlob(pathname:string,_options:{useCache?:boolean}={}){if(pathname.startsWith('seo/'))return null;const stored=await readOffline(pathname);if(!stored)throw new Error('RESTORE_MEDIA_SOURCE_MISSING');return {statusCode:200 as const,stream:new Response(new Uint8Array(stored.bytes)).body!,blob:{size:stored.bytes.length,contentType:stored.contentType}};}\n`;
  const seoPath = join(app, 'src/server/seo/media.ts');
  const seo = await readFile(seoPath, 'utf8');
  const configured = "function storageConfigured() { return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID); }";
  if (!seo.includes(configured)) fail('RESTORE_SOURCE_STORAGE_GATE_CHANGED');
  const proxyPath = join(app, 'src/proxy.ts');
  try { await lstat(proxyPath); fail('RESTORE_SOURCE_PROXY_EXISTS_REVIEW_REQUIRED'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(join(app, 'src/server/media/storage.ts'), storage, { mode: 0o600 });
  await writeFile(seoPath, seo.replace(configured, "function storageConfigured() { return process.env.JESIE_RESTORE_GUARD==='1' && Boolean(process.env.JESIE_RESTORE_MEDIA_ROOT); }"));
  await writeFile(proxyPath, `import {NextResponse} from 'next/server';\nexport function proxy(){return NextResponse.json({code:'RESTORE_AUTOMATION_DISABLED'},{status:403,headers:{'Cache-Control':'private, no-store','X-Robots-Tag':'noindex'}});}\nexport const config={matcher:['/api/cron/:path*','/api/admin/ai/:path*','/api/admin/trends/:path*','/api/admin/seo/:path*','/api/admin/setup','/.well-known/workflow/:path*','/admin/ai/:path*','/admin/trends/:path*']};\n`);
  const healthDir = join(app, 'src/app/api/restore-health'); await mkdir(healthDir, { recursive: true });
  await writeFile(join(healthDir, 'route.ts'), `import {getDb} from '@/server/db';import {sql} from 'drizzle-orm';\nexport const dynamic='force-dynamic';export async function GET(){const db=await getDb().execute(sql\`SELECT inet_server_addr() AS address\`);const guard=(globalThis as typeof globalThis & {__jesieRestoreGuard?:{active:boolean;fetchRejected:number;socketRejected:number;dnsRejected:number}}).__jesieRestoreGuard;return Response.json({guard:guard??null,unixOnly:db.rows[0]?.address===null,credentialsAbsent:${JSON.stringify(secretNames)}.every(name=>!process.env[name]),preview:process.env.VERCEL_ENV==='preview'},{headers:{'Cache-Control':'private, no-store'}});}\n`);
}

type TableCapture = { table: string; keys: Record<string, unknown>[]; primary: string[]; count: number; digest: string };
async function captureTables(pool: Pool): Promise<TableCapture[]> {
  const names = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows as { tablename: string }[];
  const result: TableCapture[] = [];
  for (const item of names) {
    const primary = (await pool.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY array_position(i.indkey,a.attnum)`, [`public.${item.tablename}`])).rows.map(row => String(row.attname));
    if (!primary.length) fail('RESTORE_TABLE_PRIMARY_KEY_REQUIRED');
    const keys = (await pool.query(`SELECT jsonb_build_object(${primary.map(column => `'${column}',${quote(column)}::text`).join(',')}) AS key FROM ${quote(item.tablename)}`)).rows.map(row => row.key);
    const fingerprint = (await pool.query(`SELECT count(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) AS digest FROM ${quote(item.tablename)} t`)).rows[0];
    result.push({ table: item.tablename, keys, primary, count: fingerprint.count, digest: fingerprint.digest });
  }
  return result;
}
async function confirmOriginalRows(pool: Pool, capture: TableCapture[], allowFixtures = false) {
  const fixtureTables = new Set(['auth_user', 'auth_account', 'auth_session', 'auth_rate_limit', 'auth_event', 'editorial_recipe', 'editorial_version', 'editorial_audit']);
  for (const table of capture) {
    const predicate = table.primary.map(column => `t.${quote(column)}::text = k.value->>'${column}'`).join(' AND ');
    const current = (await pool.query(`SELECT count(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) AS digest FROM ${quote(table.table)} t WHERE EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) k WHERE ${predicate})`, [JSON.stringify(table.keys)])).rows[0];
    if (current.count !== table.count || current.digest !== table.digest) fail(`RESTORE_ORIGINAL_ROWS_CHANGED_${table.table.toUpperCase()}`);
    if (!allowFixtures || !fixtureTables.has(table.table)) {
      const entire = (await pool.query(`SELECT count(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) AS digest FROM ${quote(table.table)} t`)).rows[0];
      if (entire.count !== table.count || entire.digest !== table.digest) fail(`RESTORE_UNEXPECTED_TABLE_ROWS_${table.table.toUpperCase()}`);
    }
  }
}
function launch(command: string[], app: string, env: NodeJS.ProcessEnv, logPath: string) {
  const log = createWriteStream(logPath, { mode: 0o600, flags: 'wx' });
  const child = spawn('/usr/bin/sandbox-exec', ['-p', restoreSandboxProfile, ...command], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
  const done = new Promise<number>((resolveDone, reject) => { child.on('error', reject); child.on('exit', code => { log.end(); resolveDone(code ?? 1); }); });
  return { child, done };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) await delay(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}
type ApiRecipe = { id: string; revision: number; content: EditorialContent; deletedAt: string | null };
type RestoreReport = { [key: string]: unknown; http?: { recipePages: number; publicMediaSources: number; [key: string]: unknown } };

async function exerciseApi(options: { pool: Pool; base: string; report: RestoreReport }) {
  const request = (path: string, init: RequestInit = {}) => {
    if (!path.startsWith('/') || path.startsWith('//')) fail('RESTORE_HTTP_PATH_INVALID');
    return fetch(options.base + path, { redirect: 'manual', signal: AbortSignal.timeout(120_000), ...init });
  };
  const health = await request('/api/restore-health'); const healthBody = await health.json();
  assert.equal(health.status, 200); assert.equal(healthBody.guard?.active, true); assert.equal(healthBody.unixOnly, true);
  assert.equal(healthBody.credentialsAbsent, true); assert.equal(healthBody.preview, true);
  options.report.health = healthBody;
  const publications = (await options.pool.query("SELECT r.id,p.snapshot FROM editorial_recipe r JOIN editorial_publication p ON p.id=r.published_id WHERE r.deleted_at IS NULL AND r.publication_status='published' ORDER BY r.id")).rows as { id: string; snapshot: EditorialContent }[];
  const publicMedia = new Set<string>(); const variants = new Set<string>(); const pages: string[] = [];
  for (const publication of publications) {
    const recipe = publication.snapshot.recipe;
    for (const variant of Object.values(getRecipeImageVariants(recipe))) variants.add(variant.url);
    for (const locale of ['pl', 'en'] as const) if (recipe.slug[locale] && recipe.title[locale] && recipe.description[locale]) {
      const path = `/${locale}/recipes/${recipe.slug[locale]}`; const response = await request(path); const html = await response.text();
      assert.equal(response.status, 200); assert.match(html, /application\/ld\+json/); assert.match(html, /"@type":"Recipe"/);
      assert.match(html, /https:\/\/www\.jesie\.pl/); assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/);
      assert(html.includes('recipeIngredient')); assert(html.includes('recipeInstructions'));
      for (const match of html.matchAll(/https:\/\/www\.jesie\.pl(\/media\/recipes\/[^"\s<\\]+)/g)) variants.add(match[1].replaceAll('&amp;', '&'));
      pages.push(path);
    }
    for (const src of [recipe.image, ...Object.values(publication.snapshot.photos.ingredients).map(tile => tile.src), ...Object.values(publication.snapshot.photos.steps).map(tile => tile.src)]) if (typeof src === 'string' && src.startsWith('/')) publicMedia.add(src);
  }
  for (const path of ['/pl', '/en', '/robots.txt', '/sitemap.xml', '/pl/feed.xml', '/en/feed.xml']) {
    const response = await request(path); assert.equal(response.status, 200); await response.arrayBuffer();
  }
  const robots = await (await request('/robots.txt')).text(); assert.match(robots, /Disallow: \/\s/);
  for (const src of publicMedia) {
    for (const path of src.startsWith('/media/') ? [src, `${src}?w=320&d=2`] : [src]) {
      const response = await request(path); assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer()); const info = await sharp(bytes).metadata(); assert(info.width && info.height);
    }
  }
  for (const kind of ['hero', 'ingredient', 'step']) {
    const [sample] = (await options.pool.query('SELECT id FROM ai_asset WHERE kind=$1 ORDER BY id', [kind])).rows.filter(asset => publicMedia.has(`/media/${asset.id}`));
    if (sample) for (const width of [96, 160, 320, 480, 640, 960, 1280, 1600]) {
      const response = await request(`/media/${sample.id}?w=${width}&d=2`); assert.equal(response.status, 200);
      const info = await sharp(Buffer.from(await response.arrayBuffer())).metadata(); assert(info.width && info.width <= width);
    }
  }
  for (const path of variants) { const response = await request(path); assert.equal(response.status, 200); assert((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width); }
  const assets = (await options.pool.query('SELECT id,kind,blob_pathname,original_blob_pathname FROM ai_asset ORDER BY id')).rows;
  const privateAsset = assets.find(asset => asset.kind === 'hero' && !publicMedia.has(`/media/${asset.id}`)); if (!privateAsset) fail('RESTORE_PRIVATE_MEDIA_SAMPLE_REQUIRED');
  assert.equal((await request(`/media/${privateAsset.id}?w=160&d=2`)).status, 404);
  const anonAdmin = await request('/api/admin/recipes'); assert.equal(anonAdmin.status, 401);
  const actorId = randomUUID(); const password = randomBytes(24).toString('base64url'); const email = `restore-${actorId}@example.invalid`;
  await options.pool.query("INSERT INTO auth_user(id,name,email,role,disabled) VALUES($1,'Restore fixture',$2,'admin',false)", [actorId, email]);
  await options.pool.query("INSERT INTO auth_account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)", [randomUUID(), actorId, await hashPassword(password)]);
  const address = `2001:db8:${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}::1`;
  const signedIn = await request('/api/auth/sign-in/email', { method: 'POST', headers: { origin: options.base, 'content-type': 'application/json', 'x-forwarded-for': address }, body: JSON.stringify({ email, password }) });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); assert(cookie);
  const headers = { origin: options.base, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', cookie, 'x-forwarded-for': address };
  const adminMedia = await request(`/media/${privateAsset.id}?w=160&d=2`, { headers }); assert.equal(adminMedia.status, 200);
  assert.equal(adminMedia.headers.get('cache-control'), 'private, no-store'); await adminMedia.arrayBuffer();
  const conditional = await request(`/media/${privateAsset.id}?w=160&d=2`, { headers: { ...headers, 'if-none-match': adminMedia.headers.get('etag')! } }); assert.equal(conditional.status, 200); await conditional.arrayBuffer();
  const created = await request('/api/admin/recipes', { method: 'POST', headers, body: JSON.stringify({ title: 'Isolated restore fixture', originalText: 'Synthetic local fixture only.' }) }); assert.equal(created.status, 201);
  const fixtureId = (await created.json()).id;
  const fixturePath = `/api/admin/recipes/${fixtureId}`;
  let fixture = (await (await request(fixturePath, { headers })).json()).recipe as ApiRecipe;
  const content = structuredClone(publications[0].snapshot); content.recipe.id = fixtureId;
  content.recipe.slug = { pl: `restore-${fixtureId}`, en: `restore-${fixtureId}` }; content.recipe.image = `/media/${privateAsset.id}`;
  const save = async (next: EditorialContent) => {
    const response = await request(fixturePath, { method: 'PATCH', headers, body: JSON.stringify({ expectedRevision: fixture.revision, content: next }) }); assert.equal(response.status, 200); fixture = (await response.json()).recipe;
  };
  await save(content); const restoredVersion = fixture.revision; const originalHash = sha(Buffer.from(JSON.stringify(fixture.content)));
  const anonymousPreview = await request(`/pl/preview/${fixtureId}`); assert.equal(anonymousPreview.status, 307); assert.equal(anonymousPreview.headers.get('location'), '/admin/login');
  for (const path of [`/admin/recipes/${fixtureId}`, `/pl/preview/${fixtureId}`]) {
    const response = await request(path, { headers }); assert.equal(response.status, 200);
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/); await response.arrayBuffer();
  }
  const changed = structuredClone(fixture.content); changed.recipe.title.pl = 'Synthetic changed restore fixture'; await save(changed);
  const restored = await request(fixturePath + '/actions', { method: 'POST', headers, body: JSON.stringify({ action: 'restore', expectedRevision: fixture.revision, version: restoredVersion }) }); assert.equal(restored.status, 200); fixture = (await restored.json()).recipe;
  assert.equal(sha(Buffer.from(JSON.stringify(fixture.content))), originalHash);
  const trashed = await request(fixturePath, { method: 'DELETE', headers, body: JSON.stringify({ expectedRevision: fixture.revision }) }); assert.equal(trashed.status, 200); fixture = (await trashed.json()).recipe; assert(fixture.deletedAt);
  const revived = await request(fixturePath + '/actions', { method: 'POST', headers, body: JSON.stringify({ action: 'restore_deleted', expectedRevision: fixture.revision }) }); assert.equal(revived.status, 200); fixture = (await revived.json()).recipe; assert.equal(fixture.deletedAt, null);
  assert.equal(fixture.content.recipe.image, `/media/${privateAsset.id}`);
  assert.equal((await request(`/media/${privateAsset.id}?w=160&d=2`)).status, 404);
  assert.equal((await request('/pl/recipes/' + fixture.content.recipe.slug.pl)).status, 404);
  const invalidOrigin = await request(fixturePath, { method: 'PATCH', headers: { ...headers, origin: 'https://untrusted.invalid' }, body: JSON.stringify({ expectedRevision: fixture.revision, content: fixture.content }) }); assert.equal(invalidOrigin.status, 403);
  for (const path of ['/api/cron/trends', '/api/cron/trends/publish', '/api/cron/seo', '/api/admin/ai', '/api/admin/trends', '/api/admin/seo', '/.well-known/workflow/v1/flow']) assert.equal((await request(path, { headers })).status, 403);
  await options.pool.query('UPDATE auth_user SET disabled=true WHERE id=$1', [actorId]); assert.equal((await request('/api/admin/recipes', { headers })).status, 401);
  await options.pool.query('UPDATE auth_user SET disabled=false WHERE id=$1', [actorId]);
  const signedOut = await request('/api/auth/sign-out', { method: 'POST', headers, body: '{}' }); assert.equal(signedOut.status, 200); assert.equal((await request('/api/admin/recipes', { headers })).status, 401);
  options.report.http = { publishedRecipes: publications.length, recipePages: pages.length, publicMediaSources: publicMedia.size, namedVariantUrls: variants.size, privateMedia: true, adminAuth: true, disabledActor: true, csrf: true, historyRestore: true, trashRestore: true, automationBlocked: true, noRealRecipeEdits: true };
  return { pages, sample: pages.find(path => path.startsWith('/pl/'))!, fixtureId };
}

export async function browserDrill(options: { module: string; base: string; sample: string; work: string; report: RestoreReport }) {
  const chromium = (await import(pathToFileURL(join(options.module, 'index.mjs')).href)).chromium;
  const wrapper = join(options.work, 'restore-chrome-wrapper');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; await lstat(chrome);
  await writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -p '${restoreSandboxProfile}' '${chrome}' "$@"\n`, { mode: 0o700 });
  const chromeHome = join(options.work, 'chrome-home'); await privateDirectory(chromeHome);
  const browser = await chromium.launch({ headless: true, executablePath: wrapper, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: chromeHome }, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); let blockedExternal = 0;
    await context.route('**/*', (route: { request: () => { url: () => string }; abort: () => Promise<void>; continue: () => Promise<void> }) => { const url = new URL(route.request().url()); if (url.origin !== options.base) { blockedExternal++; return route.abort(); } return route.continue(); });
    const page = await context.newPage(); await page.goto(options.base + options.sample, { waitUntil: 'networkidle' });
    const hero = page.locator('.detail-hero img').first(); await hero.waitFor();
    assert.equal(await hero.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), true);
    const servings = page.locator('.servings-stepper output'); const before = Number(await servings.textContent());
    const quantities = await page.locator('.ingredient-description strong').allTextContents();
    await page.getByRole('button', { name: 'Więcej porcji', exact: true }).click(); await page.waitForTimeout(150);
    assert.equal(Number(await servings.textContent()), Math.min(24, before + 1));
    if (before < 24) assert.notDeepEqual(await page.locator('.ingredient-description strong').allTextContents(), quantities);
    const checkbox = page.locator('.detail-method input[type="checkbox"]').first(); await page.locator('.step-marker').first().click(); assert.equal(await checkbox.isChecked(), true);
    for (let y = 0; y < await page.evaluate(() => document.documentElement.scrollHeight); y += 700) { await page.evaluate((position: number) => window.scrollTo(0, position), y); await page.waitForTimeout(80); }
    await page.waitForFunction(() => Array.from(document.images).every(image => image.complete && image.naturalWidth > 0));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(options.work, 'recipe-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload({ waitUntil: 'networkidle' });
    assert.equal(Number(await servings.textContent()), Math.min(24, before + 1)); assert.equal(await checkbox.isChecked(), true);
    for (let y = 0; y < await page.evaluate(() => document.documentElement.scrollHeight); y += 600) { await page.evaluate((position: number) => window.scrollTo(0, position), y); await page.waitForTimeout(80); }
    await page.waitForFunction(() => Array.from(document.images).every(image => image.complete && image.naturalWidth > 0));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(options.work, 'recipe-mobile.png'), fullPage: true });
    const loadedFonts = await page.evaluate(async () => { await document.fonts.ready; return document.fonts.status; }); assert.equal(loadedFonts, 'loaded');
    assert.equal(blockedExternal, 0);
    options.report.browser = { desktop: true, mobile: true, heroLoaded: true, allDesktopAndMobileImagesLoaded: true, servingsChanged: true, quantitiesChanged: true, cookingProgressPersisted: true, fontsLoaded: true, externalRequests: blockedExternal };
  } finally { await browser.close(); }
}

const option = (name: string) => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
async function main() {
  const source = option('--app-source'), restoredMedia = option('--media-root'), manifestPath = option('--manifest'), work = option('--work'), socket = option('--pg-socket'), sourceDb = option('--source-db'), user = option('--pg-user'), playwright = option('--playwright');
  const pgPort = Number(option('--pg-port') ?? '5432'); const port = Number(option('--port') ?? '3198');
  if (![source, restoredMedia, manifestPath, work, socket, playwright].every(value => value && isAbsolute(value)) || !sourceDb || !user || !safeName(sourceDb) || !safeName(user)
    || !Number.isInteger(pgPort) || !Number.isInteger(port) || port < 1024 || port > 65535) fail('RESTORE_REQUIRED_ARGUMENTS_INVALID');
  const sourcePath = source!, mediaPath = restoredMedia!, workspace = work!, socketPath = socket!, modulePath = playwright!;
  if (sourcePath === process.cwd() || workspace === sourcePath || workspace.startsWith(sourcePath + '/')) fail('RESTORE_ARCHIVED_SOURCE_AND_SEPARATE_WORK_REQUIRED');
  try { await lstat(workspace); fail('RESTORE_WORK_DIRECTORY_ALREADY_EXISTS'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await privateDirectory(workspace);
  const report: RestoreReport = { version: 1, startedAt: new Date().toISOString(), productionCredentialsUsed: false, providerRequests: 0, productionMutations: 0, pristineRestoreDbModified: false };
  const reportPath = join(workspace, 'application-restore-result.private.json');
  const manifestBytes = await readFile(manifestPath!); const manifest = parseVaultManifest(JSON.parse(manifestBytes.toString('utf8'))); report.manifestSha256 = sha(manifestBytes);
  const maintenance = new Pool({ host: socketPath, port: pgPort, user, database: 'postgres', max: 1 });
  let sourcePool: Pool | undefined = new Pool({ host: socketPath, port: pgPort, user, database: sourceDb, max: 1 });
  const drillDb = `jesie_drill_${randomBytes(6).toString('hex')}`;
  let pool: Pool | undefined; let server: ReturnType<typeof launch> | undefined;
  try {
    assert.equal((await sourcePool.query('SELECT inet_server_addr() AS address')).rows[0].address, null);
    const pristine = await captureTables(sourcePool); report.pristineTables = pristine.map(({ table, count, digest }) => ({ table, count, digest }));
    await sourcePool.end(); sourcePool = undefined;
    await maintenance.query(`CREATE DATABASE ${quote(drillDb)} TEMPLATE ${quote(sourceDb)}`);
    pool = new Pool({ host: socketPath, port: pgPort, user, database: drillDb, max: 2 });
    await confirmOriginalRows(pool, pristine);
    const app = join(workspace, 'app');
    await cp(sourcePath, app, { recursive: true, filter: path => !['node_modules', '.next', '.vercel', '.git', 'output', '.workflow-data'].some(name => path === join(sourcePath, name) || path.startsWith(join(sourcePath, name) + '/')) && !path.split('/').some(part => part.startsWith('.env') && part !== '.env.example') });
    await symlink(join(process.cwd(), 'node_modules'), join(app, 'node_modules'));
    const hotMediaRoot = manifest.roots.find(root => root.category === 'application' && root.label === 'app-private-media');
    if (!hotMediaRoot) fail('RESTORE_HOT_MEDIA_ROOT_REQUIRED');
    await cp(join(mediaPath, 'local', hotMediaRoot.label), join(app, 'private-media'), { recursive: true, force: false, errorOnExist: true });
    report.privateRecoveryBundleRestored = true;
    const mappings = (await pool.query('SELECT source_pathname,target_pathname,target_sha256,target_bytes FROM media_compaction')).rows;
    const offlineMedia = join(workspace, 'offline-media'); report.offlineMedia = await prepareOfflineMedia({ manifest, restoredMedia: mediaPath, directory: offlineMedia, mappings });
    const assets = (await pool.query('SELECT blob_pathname,original_blob_pathname FROM ai_asset')).rows;
    const closure = JSON.parse(await readFile(join(offlineMedia, 'manifest.json'), 'utf8')).entries;
    for (const asset of assets) for (const path of [asset.blob_pathname, asset.original_blob_pathname].filter(Boolean)) assert(closure[path]);
    report.registeredArchivesAndFinalsVerified = assets.length;
    await patchRestoreCopy(app);
    const guardLogs = join(workspace, 'guard-logs'); await privateDirectory(guardLogs);
    const guard = join(workspace, 'restore-egress-guard.cjs'); await copyFile(resolve('scripts/restore-egress-guard.cjs'), guard);
    const url = new URL(`postgresql://${user}@localhost/${drillDb}`); url.searchParams.set('host', socketPath); url.searchParams.set('port', String(pgPort));
    const env = restoreEnvironment({ databaseUrl: url.toString(), socketPath: join(socketPath, `.s.PGSQL.${pgPort}`), port, guard, guardLogs, offlineMedia, authSecret: randomBytes(48).toString('base64url') });
    report.isolation = { osSandbox: true, preload: true, environmentAllowlist: true, productionSecretsAbsent: secretNames.every(name => !env[name]), testCopyPatches: ['offline media reader', 'local-only SEO source gate', 'disabled automation Proxy', 'loopback-only diagnostic endpoint'] };
    console.log(JSON.stringify({ stage: 'restored_application_build', tables: pristine.length, assets: assets.length }));
    const build = launch([process.execPath, join(app, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], app, env, join(workspace, 'build.private.log'));
    const heartbeat = setInterval(() => console.log(JSON.stringify({ stage: 'restored_application_build_running' })), 30_000);
    let buildCode: number; try { buildCode = await build.done; } finally { clearInterval(heartbeat); }
    if (buildCode !== 0) fail('RESTORE_APPLICATION_BUILD_FAILED'); report.build = 'PASS';
    server = launch([process.execPath, join(app, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], app, env, join(workspace, 'server.private.log'));
    const base = `http://127.0.0.1:${port}`; let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) { try { const response = await fetch(base + '/api/restore-health', { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } } catch { /* Server startup is local and bounded. */ } await delay(200); }
    if (!ready) fail('RESTORE_APPLICATION_SERVER_UNAVAILABLE');
    console.log(JSON.stringify({ stage: 'restored_application_http_checks' }));
    const api = await exerciseApi({ pool, base, report });
    console.log(JSON.stringify({ stage: 'restored_application_browser_checks' }));
    await browserDrill({ module: modulePath, base, sample: api.sample, work: workspace, report });
    await confirmOriginalRows(pool, pristine, true);
    sourcePool = new Pool({ host: socketPath, port: pgPort, user, database: sourceDb, max: 1 });
    await confirmOriginalRows(sourcePool, pristine); report.originalRowIntegrity = 'PASS';
    await stop(server.child); await server.done;
    const guards = [];
    for (const file of await readdir(guardLogs)) if (/^guard-\d+-\d+\.private\.json$/.test(file)) guards.push(JSON.parse(await readFile(join(guardLogs, file), 'utf8')));
    assert(guards.length > 0); assert(guards.every(value => value.active));
    const rejected = guards.reduce((sum, value) => sum + value.fetchRejected + value.socketRejected + value.dnsRejected, 0); assert.equal(rejected, 0);
    report.egress = { guardProcesses: guards.length, externalAttemptsRejected: rejected, externalRequestsAllowed: 0, osSandboxPolicyVerifiedSeparately: true };
    report.status = 'PASS'; report.finishedAt = new Date().toISOString(); await safeJson(reportPath, report);
    console.log(JSON.stringify({ ok: true, status: 'PASS', report: reportPath, recipePages: report.http?.recipePages, media: report.http?.publicMediaSources }));
  } catch (error) {
    report.status = 'FAILED'; report.safeFailure = error instanceof Error && /^[A-Z0-9_]{1,120}$/.test(error.message) ? error.message : 'RESTORE_ASSERTION_FAILED'; report.finishedAt = new Date().toISOString();
    await safeJson(reportPath, report); throw new Error(String(report.safeFailure));
  } finally { if (server) await stop(server.child); await pool?.end(); await sourcePool?.end(); await maintenance.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(JSON.stringify({ ok: false, code: error instanceof Error && /^[A-Z0-9_]{1,120}$/.test(error.message) ? error.message : 'RESTORE_HARNESS_FAILED' })); process.exitCode = 1; });
