# Media storage and recovery

Registered photographs remain private. Public access is granted only by an active
published recipe; drafts and Trash keep the existing administrator checks.

## Delivery sizes and retention

The browser requests `/media/<asset-id>?w=<width>&d=2` at one of 96, 160, 320, 480,
640, 960, 1280 or 1600 pixels. The same route checks active publication or the
administrator session for every kind and size of photograph, and checks
publication again after rendering or a cache lookup. Draft responses use
`private, no-store`; public responses retain the existing five-minute CDN window,
with exact-content ETags for conditional reads. Full-frame links keep the
original `/media/<asset-id>` address.

Delivery WebP uses quality 84 for a dish, 80 for an ingredient and 82 for a step,
with full-quality alpha. It resizes without enlargement or additional crops.
A hero keeps its existing complete, centred vessel. Thumbnails are generated
directly from pixels rather than first encoding a lossless full-resolution
presentation master. Their cache is the response CDN and a bounded 24 MiB /
128-entry process cache; it never adds thumbnail files to Blob or database
records. Every process-cache hit repeats authorization.

| Placement | CSS display / delivery policy |
| --- | --- |
| Ingredient list and small editor rows | About 80 px; `sizes=80px`, variants capped at 320 px for dense displays. |
| Recipe cards | Actual one-, two- or three-column width; up to 960 px. |
| Homepage and recipe hero | Actual responsive container width; up to 1600 px, eager/high priority. |
| Recipe steps | Actual method-column width; up to 1600 px, lazy loading. |
| Studio results, batch tiles and editor previews | Container-specific sizes, 160–1280 px caps; lazy loading. |
| Search/social/Pinterest | Existing named 1600×1200, 1600×900, 1200×1200, 1200×630 and 1000×1500 variants. |
| Full view / editing | Retained complete source and final master; thumbnails do not replace either. |

Retention must distinguish an editing source from a final master. A SAM source
can be opaque while its final `web-v1.webp` contains the reviewed cutout alpha.
That final master is not reconstructible from the source alone without its
exact mask and transformation recipe. Keep both where they differ; unchanged
studio photos already share one lossless file. Preserve version history,
publication references, ingredient-library reuse, Trash restoration and
uncertain or accepted provider results. Only derivative caches and proven
identical encodings with a verified restore manifest are cleanup candidates.

The 14 October audit found 868,726,093 bytes in Blob and a 27,328,512-byte database.
The two inspected local media roots occupy the same filesystem: an off-app
directory is useful recovery storage, but its location alone does not establish
an independent backup. All deployed recovery image files have a SHA-256-verified
off-app copy; this is not a full database or application restore test. Detailed
evidence and cleanup classification are in
`output/verification/media-optimization-2026-10-14/`. Review a fresh reference and
hash inventory before cleanup; do not apply an old list automatically.

## Bounded public delivery during the observed Neon quota incident

The emergency public snapshot captured on 13 October at 15:50:52 UTC expires
on 14 October at the same time. Only the exact observed PostgreSQL `53000`
quota error can activate its media fallback. Successful database reads remain
authoritative, including a withdrawal or an unpublished photograph.

The separately pinned media registry contains 197 source assets referenced by
the 18 anonymous public recipe DTOs and verified again by the anonymous image
audit. Every emergency request checks its exact asset ID, photo kind and public
recipe reference. No planned recipe or administrative route acquires fallback
access. The fixed snapshot clock is checked again after image preparation, and
emergency responses have no CDN retention time.

`private-media/quota-public-recovery` retains only the 102 required copies absent
from the existing published recovery bundle. Its regular-file reader verifies
the byte count, SHA-256 and raster MIME type before returning any bytes. The other
95 source assets use the existing verified copies. Hero presentation, supported
responsive widths and versioned recipe image variants use the ordinary image
renderer. No new photo is generated and no derivative or database record is
written. Corruption, expiration, unrelated errors and unlisted IDs fail closed.

New editing archives use full-resolution lossless WebP with exact alpha and RGB.
Unchanged studio photographs share that file with their delivery image. Social,
search and responsive variants are generated on demand and cached by the response
CDN for five minutes; they no longer refill the source store.

Before a new paid photo or mask submission, the worker verifies Blob read access
and at least 64 MiB of capacity. It does not spend on a new provider request while
the store is suspended or nearly full. Already accepted receipts can still be
read again, without buying another photograph.

`BLOB_STORAGE_LIMIT_BYTES` sets the local storage safety guard in whole bytes;
when absent it conservatively defaults to 1,000,000,000 bytes. This is an
application guard, not a detected Vercel plan quota. Set it explicitly after
verifying the existing plan and storage budget; the worker still reserves 64 MiB
and checks fresh read access. Empty, fractional, unsafe or too-small explicit
values block paid submissions instead of falling back to a different limit.

## Existing photographs

Apply `scripts/migrate-media-compaction.ts` before deploying the storage reader.
The append-only `media_compaction` table redirects an old internal pathname to
its verified WebP. Asset history, provider receipts and `/media/<id>` URLs remain
unchanged. Use the maintenance script from the repository root:

```sh
npm run media:compact -- --env=.env.production.local
npm run media:compact -- --env=.env.production.local --apply --reserve-week --backup=/absolute/private/backup
```

The first command only lists the plan. The second processes files one at a time:
it saves a private local source backup, verifies all decoded RGBA pixels, uploads
and verifies the replacement, writes an append-only redirect, then removes the
redundant stored encoding. It never overwrites an existing file. A failed read,
hash mismatch or insufficient temporary capacity stops the operation. An
interrupted run can resume with the same backup directory. Keep the `.source`,
`.webp` and JSON proof files together; the verified replacement can be restored
from its matching `.webp` file without changing any asset or publication record.

`--reserve-week` stops once at least 350 MB of headroom is available. Future
capacity depends on the actual photographs and needs periodic maintenance.

## Recovery checkpoint: 13 October 2026

The owner activated Vercel Pro later on 13 October and authorised immediate
continuation. A real Blob read and a unique diagnostic write succeeded; the
diagnostic file was then removed. Verified lossless compaction saved 165,434,143
bytes across 98 encodings, with original private copies and exact decoded-pixel
proofs preserved. The existing conservative capacity guard remains unchanged.
All 209 published-image delivery checks passed after storage access returned.
Earlier Hobby suspension observations below are historical.

The provider recovery manifest now retains a 22nd completed result: the corrected
Labraks white-wine image, bound to its exact job and receipt. A transport failure
after provider completion did not trigger another paid request. The original PNG
and its lossless WebP have identical decoded RGBA pixels. The same job was
completed from the verified private backup using
`scripts/recover-accepted-photo-backup.mts`, which forbids provider credentials
and provider network requests. Its default dry run verifies the current actor,
recipe revision, packet generation, original budget and source SHA-256; `--apply`
saves through the existing photo formatter and asset registration. Owner approval
and publication remain separate actions.

92 reproducible SEO caches were purged, saving 41,544,250 bytes. Sources were
preserved. Vercel still reports this store suspended until 14 October 2026;
deleting caches does not immediately remove that provider suspension.

21 already completed fal.ai results have verified local backups: 18 for the six
weekly packages and three for Labraks. Their lossless
recovery copies in `private-media/provider-recovery` are included only in the
server workflow bundle and are excluded from Git. They have no public file route.
Each file is bound to its exact job and immutable provider request receipt and
checked against its size and SHA-256 before use. These copies let the existing
photo packages resume after storage access returns even if a provider image
URL expires. They neither create a new generation nor approve a publication.

Detailed recovery and the aggregate 105 USD authorization are recorded in
`output/editorial/week-2026-10-13/resume-checklist.private.json`. Do not restart
the six packages as new packages or change their budget limits.

The separate Labraks authorization is its original USD 19.60 photograph package,
not part of the weekly USD 105 allowance. Its checkpoint and updated future task
are in `output/verification/storage-labraks-2026-10-13`. Copies of all 21 provider
results and 98 published recovery files were independently SHA-256 verified in
`/Volumes/Projekty/jesie-private-media-backup` before further cleanup.

On 13 October, a fresh audit found 33 auxiliary `recovered-original.png` caches
with exact immutable SAM archive bindings, equal nonempty strong ETags and sizes,
no direct or literal references and no active consumers. A final metadata HEAD of
each cache and its retained archive preceded conditional deletion using `ifMatch`.
This saved another 159,025,322 bytes, reducing usage to 814,886,507 bytes. Every
registered original and delivery photograph, all 33 retained archives and four
sole-source recovery files remain stored. These cache removals do not restore
provider access while the store is suspended.

`scripts/purge-recovery-cache.ts` requires a fresh audited manifest and repeats
database binding/reference checks, metadata verification and conditional deletion.
It records restoration paths and every completed deletion. Do not replay an old
manifest or classify other files by size, age or publication state alone. Direct
SHA-256 of suspended Blob contents is not claimed; immutable source bindings and
strong representation validators classify these files as reconstructible cache.
The deployed retained-first reader already uses the preserved archives. Future
photograph compaction still verifies decoded pixels, local backups and uploaded
replacements before removing an old encoding.

## Public delivery during a storage suspension

Verified copies of existing published photographs can be packaged in
`private-media/published-recovery`. They stay outside `public/` and are included
only in the required server functions. The manifest maps an existing internal
pathname to a content-addressed file, its byte count, SHA-256 and real MIME type.
The reader validates those values on every read; it never exposes a filesystem
path as a new public URL. Existing publication, withdrawal and admin checks
continue to guard `/media/<id>` and recipe image variants.

Recovery uses exact archived bytes or replays the recorded image transformations
from existing provider receipts, checking the registered dimensions and stored
byte count. Missing or expired sources remain unavailable; a different photograph
must not replace them. Source history, recipe snapshots and the storage quota are
unchanged. An absent manifest falls back to Blob; a corrupt present copy fails
closed. CDN-only variants skip optional Blob caches even when the store refuses
reads, so bundled static photographs remain usable too.
