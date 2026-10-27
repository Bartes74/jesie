# Plan metrics migration 0025

`0025-plan-metrics` adds `/pl/plan` and `/en/plan` to the two path CHECK
constraints on `seo_usage_daily`. Existing paths, events, sources and rows stay
valid. Recipe-only actions remain restricted to recipe URLs. The resolver now
recognizes the plan page without querying recipes or collections. No query,
shopping selection, meal identifier or visitor identifier is stored.

Run only against the intentionally selected database, after migration 0024:

```sh
npx tsx scripts/migrate-plan-metrics.ts /private/path/selected.env
npx tsx scripts/migrate-plan-metrics.ts /private/path/selected.env --verify-only
```

The runner reads DSNs only from that file, prefers `DATABASE_URL_UNPOOLED` or
`POSTGRES_URL_NON_POOLING`, and refuses a Neon `-pooler` hostname. It checks the
0024 ledger hash, takes the existing migration advisory lock, uses transaction
local `lock_timeout=5s` and `statement_timeout=60s`, and commits SQL and the
SHA-256 ledger entry together. A changed applied migration fails closed. The
second command uses a read-only transaction and checks the hash and validated
plan constraints. Run the first command only with deployment authorization.

`npm run db:migrate -- /private/path/selected.env` includes 0025 after 0024; the
dedicated runner above is the minimal command for an already migrated database.

The changed CHECK definitions change the backup structural fingerprint. Ship the
matching checked-in schema bundle and new backup workers with this migration.
Allow an in-flight old checkpoint to freeze its old DDL first; completed older
backups retain their own frozen encrypted schema and remain restorable. Do not
attach new DDL to an old snapshot or bypass fingerprint checks.

Local-only verification (no application DSNs or production/provider access):

```sh
NODE_OPTIONS=--conditions=react-server npx tsx --test src/lib/usage-metrics.test.ts src/server/seo/metrics.test.ts
npx tsx scripts/update-kitchen-backup-schema.ts --verify-only
npm run test:backup-schema
```

The last two commands require local PostgreSQL 18 tools in `PATH` or
`MEDIA_BACKUP_TEST_PG_BIN=/path/to/postgresql18/bin`. They create and remove a
private Unix-socket cluster, validate the shipped fingerprint, exercise old and
new allowed paths and rejected private paths, and verify a real isolated restore.
Without `--verify-only`, the updater advances the checked-in 0024 bundle through
0025 locally and writes it only after restore verification; it reads no env file.
