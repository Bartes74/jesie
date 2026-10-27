# Automatic media and database maintenance

Production remains on Vercel Blob and Neon. `/api/cron/media` runs every hour at
minute 15 UTC and requires the existing `CRON_SECRET`. It creates one checkpoint
per UTC date and resumes saved progress after failures. The scheduled route only
dispatches a durable Workflow; expensive work runs in bounded Node steps.

Private, immutable delivery variants cover registered photos' responsive sizes,
recipe/social formats and normalized full heroes. The key binds immutable asset
identity, source path, target and renderer version. A database lease prevents
concurrent rendering; byte hashes and independent readback verify stored files.
Each registered-photo response still checks its current public/private
authorization. Legacy raster images under `public/images` use native responsive
delivery through `/media/static`, and their five recipe/social formats also use
private immutable source-addressed receipts and pixel objects under
`media-variants/static-webp-delivery-v1`. These receipts survive deployments;
source hashes, dimensions and byte hashes are checked before reuse. Concurrent
first requests on different instances may render the same static target, but
conditional writes preserve one immutable receipt. If cache storage fails, the
retained source remains the fallback. No paid image generation is involved.

Background prewarming prepares at most about 200 new variants per daily pass
(the final two-asset batch may exceed that slightly). Fully prepared assets are
skipped on the next pass. On-demand preparation remains available for every
declared target. This prevents unused historical photo sizes from delaying data
backups or creating a large compute burst.

Each backup captures a consistent read-only PostgreSQL snapshot, including
history, Trash, authentication and operational tables. Raw PostgreSQL JSON row
strings preserve numeric precision. The exact pre/post schema bundle is frozen
with the checkpoint. All data is compressed and AES-256-GCM encrypted before
being written to the independent private Blob store `jesie-backup-produkcja`.
The key is a sensitive Vercel environment variable; independent escrow remains
in the established macOS Keychain backup entry. Never log or commit the key.

All live Blob objects and the four explicit bundled media roots are backed up.
Identical bytes share one encrypted content-addressed object. An unchanged exact
source version reuses its proof for up to seven days, then reads, decrypts and
hashes it again. Source storage and backup storage must be different stores.
The catalogue preserves editing archives, masters, compaction mappings, recovery
files and unknown objects. It never deletes source media by age or popularity.

A checkpoint becomes complete only after actual PostgreSQL restoration into a
new isolated Neon database. Table hashes/counts, sequence state and structural
catalogue must match. Original owner/ACL/role metadata is retained encrypted;
the verification copy explicitly uses the current owner. The verifier checks
database name, source/target separation, owner and ownership marker before
dropping its own temporary database. An unmarked database is retained rather
than deleted; a new scope allows the backup to continue.

Retention keeps 30 daily and 12 monthly verified restore points plus the latest
good point. Only an older superseded checkpoint's database, frozen schema,
catalogue and manifest may expire, after a newer verified restore. Deletes use
the recorded ETag, are reconciled by readback, and never touch content-addressed
media. Cleanup failures retain extra copies and are retried on subsequent days.

Copying runs at up to four concurrent objects, grouped by a 64 MiB aggregate
source-size budget. An unusually large individual object runs alone. Successful
siblings commit before a failed object is retried; cursors advance only after
the whole page is saved.

`/admin/settings` shows the last complete backup, restore verification and saved
variant count. No routine action or approval is required. The copies share the
Vercel account's availability; they do not replace the existing independent
offline disaster-recovery vaults.

After a future schema migration, regenerate the exact schema bundle before the
deployment. The runtime refuses to call a mismatched schema a verified restore:

```sh
NODE_OPTIONS=--conditions=react-server npx tsx scripts/generate-backup-schema.ts /private/path/production.env
npm run test:media-maintenance
```

For migrations 0024–0025, the checked-in bundle includes `reader_feedback` and the
expanded metrics constraints, including both public plan routes. Its baseline and new fingerprints were verified in a private
local PostgreSQL 18 cluster, followed by a real restore of synthetic feedback and
metric rows. Recheck this bundle without reading application credentials or
rewriting files:

```sh
npx tsx scripts/update-kitchen-backup-schema.ts --verify-only
npm run test:backup-schema
```

This opt-in integration test is separate from `test:media-maintenance`. It
requires PostgreSQL 18 tools (`initdb`, `pg_ctl`, `pg_dump`, `postgres`) in `PATH`
or `MEDIA_BACKUP_TEST_PG_BIN=/path/to/postgresql18/bin` on a Unix system. An
already running PostgreSQL server is not needed; the test creates and removes
its own private local cluster. Missing/wrong-major tools produce an explicit
`PG18_TOOLS_REQUIRED` setup hint and do not affect the ordinary unit tests.

Deploy the matching bundle and a new backup-worker version together with
migration 0025. A worker from the previous deployment cannot validate a newly
captured post-migration schema; recover with the normal fenced dispatch/retry,
not by bypassing fingerprints. Let a pending pre-migration snapshot freeze its
matching old schema before the migration, or preserve the previous deployment's
DDL for that snapshot. Completed older backups retain their frozen encrypted
schema and remain restorable; do not regenerate or overwrite them.

Configuration: `MEDIA_BACKUP_ENABLED=1`, `MEDIA_BACKUP_STORE_ID`,
`MEDIA_BACKUP_READ_WRITE_TOKEN`, `MEDIA_BACKUP_KEY_ID`,
`MEDIA_BACKUP_ENCRYPTION_KEY` (32-byte base64), plus the existing source Blob,
database and cron credentials. Disabling the flag stops new maintenance work;
it never deletes existing backups. Sensitive plaintext is never passed through
Workflow arguments, results, errors or logs.
