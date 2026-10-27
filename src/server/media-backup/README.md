# Cloud checkpoint primitives

The maintenance workflow owns scheduling, leases, inventory progress and the SQL
ledger. This directory supplies bounded Node functions. It never starts AI
generation, approves content, publishes recipes or deletes live media.

`snapshotBackup(runId)` creates one encrypted, consistent PostgreSQL JSON
snapshot and freezes the matching pre-data/post-data restore schema in the same
checkpoint. Every table proof uses actual ordered rows, counts and SHA-256.
Raw PostgreSQL JSON row strings retain numeric/bigint precision. Database rows,
DDL, original ACL/owner/role metadata and media references stay inside encrypted
Blob objects; the returned receipt contains metadata only.

`newRestoreScope(runId)` creates the identity to persist before calling
`verifyRestore(runId, scope)`. Verification reads the frozen schema from the
backup store, creates a distinct temporary database on the configured Neon
server, restores schema/data/sequences, checks table hashes and structural
catalogs, and removes only its own database. Cleanup requires the exact name,
owner, comment marker and source-connection identity. An unconfirmed database is
preserved rather than adopted or dropped. No source schema or source table data
is changed. Owner/ACL adaptation to the verifier's account is explicit; the
original security catalog remains in the encrypted snapshot.

`backupMediaPage(cursor)` reads a bounded inventory page, copies exact source
bytes to the independent private store, downloads the copy, authenticates and
decrypts it, and checks byte count/SHA-256. Equal byte streams share a
content-addressed encrypted object. A response lost after a create is reconciled
by reading the same deterministic path. Creates use `allowOverwrite:false` and
`addRandomSuffix:false`. Application immutability does not claim provider WORM.
Persist returned inventory and proofs before advancing a page cursor.

`finalizeBackup(runId, inventory, proofs, restore, catalogReceipt?)` requires
complete version-matched inventory/proofs, reference closure and an actual
successful restore with confirmed cleanup. It writes one encrypted immutable
manifest containing database, frozen schema, optional archive catalog and media
receipts. A retry adopts the first matching manifest without rewriting its
timestamps. Historical literal paths are retained separately; current assets,
effective compaction targets and ready delivery variants are required. Verified
application-bundle files may cover historical aliases. Bundle metadata must
still match a fresh verified read; arbitrary other source stores are rejected.

## Configuration

Enable only after provisioning an independent **private** backup Blob store:

- `MEDIA_BACKUP_ENABLED=1`
- `MEDIA_BACKUP_STORE_ID`, `MEDIA_BACKUP_READ_WRITE_TOKEN`
- `MEDIA_BACKUP_KEY_ID`: stable rotation/version label
- `MEDIA_BACKUP_ENCRYPTION_KEY`: canonical base64 for exactly 32 random bytes
- Existing source `BLOB_STORE_ID`/`BLOB_READ_WRITE_TOKEN` and `DATABASE_URL`

The key is server-only. Keep a separately recoverable escrow copy in the
owner's password manager or offline secure storage before enabling checkpoints.
Do not put it in the backup, manifest, source control, workflow arguments,
command output or a browser-visible environment variable. Rotation uses a new
key ID and path namespace; retain old escrow keys while their checkpoints exist.

Default bounds: 64 MiB per media object, 128 MiB uncompressed database snapshot,
one million rows, 180 seconds per snapshot/restore operation and 25 files per
page. The maintenance caller may use smaller pages. Optional configuration is
validated and bounded through `MEDIA_BACKUP_MAX_OBJECT_BYTES`,
`MEDIA_BACKUP_MAX_SNAPSHOT_BYTES`, `MEDIA_BACKUP_MAX_SNAPSHOT_ROWS`,
`MEDIA_BACKUP_MAX_SNAPSHOT_DURATION_MS`, `MEDIA_BACKUP_PAGE_SIZE`.

The direct Neon connection verifies TLS. PostgreSQL large objects, foreign or
materialized relations, and inherited/partitioned tables require a native dump
strategy and stop this format before an incomplete snapshot is accepted.

## Schema bundle

After each migration, the deployment includes these server-only files:

- `schema/pre-data.sql`: matching PostgreSQL-major `pg_dump --schema-only
  --section=pre-data --no-owner --no-acl`
- `schema/post-data.sql`: corresponding `--section=post-data`
- `schema/manifest.json`: `{format:1,serverMajor,preDataSha256,postDataSha256,
  schemaFingerprint}`

The fingerprint is `snapshotSchemaFingerprint(proof)` using
`database-proof.ts`. Both source and restored proof sessions normalize timezone,
row-security mode and search path. A missing/mismatched bundle leaves the
encrypted snapshot intact and never marks restoration verified. Successful
checkpoints keep their own encrypted schema bundle, so future deployments do
not change their restoration contract.

Migration `0024-kitchen-experience` adds `reader_feedback` and expands the
anonymous metrics constraints; `0025-plan-metrics` preserves those dimensions and
also permits `/pl/plan` and `/en/plan`. The deployment bundle was reconstructed from the
previous checked-in DDL in a private local PostgreSQL 18 cluster, checked against
the previous manifest fingerprint, migrated locally and accepted only after a
real restore with matching table hashes and structural catalogues. No application
DSN, production database, provider service or cloud backup is used by this tool:

```sh
npx tsx scripts/update-kitchen-backup-schema.ts --verify-only
npm run test:backup-schema
```

This is a separate opt-in integration check, outside `test:media-maintenance`.
It requires PostgreSQL **18** executables `initdb`, `pg_ctl`, `pg_dump` and
`postgres` on a Unix system. Put their shared bin directory in `PATH`, or set
`MEDIA_BACKUP_TEST_PG_BIN=/path/to/postgresql18/bin` for either command. Every
executable's major version is checked; missing or incompatible tools fail with
`PG18_TOOLS_REQUIRED` and a setup hint. No pre-existing/running local server is
required: the tool creates and removes its own private cluster and test database.
For example, a Homebrew installation can use
`MEDIA_BACKUP_TEST_PG_BIN=/opt/homebrew/opt/postgresql@18/bin npm run test:backup-schema`;
Homebrew paths are not embedded in the runtime.

`--verify-only` never rewrites the bundle. Without that flag the migration-specific
tool advances the previous bundle through migrations 0024–0025, writes the manifest
last and leaves an already current bundle unchanged. It rejects production
execution and launches PostgreSQL with TCP disabled, a private Unix socket and
an environment without application/provider credentials.

Deploy migration 0025, the matching bundle and the new version of the backup Node
workers together. New post-migration checkpoints must run on the new deployment;
an older worker still carrying the previous bundle cannot verify the new schema.
Use the normal fenced dispatch/retry mechanism to start current workers, and
never bypass fingerprint checks or mark a mismatched restore as verified. Before
migration, let an already captured checkpoint freeze its matching schema bundle;
if it has not done so, retain the old deployment's DDL for that old snapshot
rather than attaching migration-0025 DDL to it. Completed older checkpoints keep
their own encrypted DDL and remain restorable without rewriting their objects.

## Offline tests

Run the `*.test.ts` files in this directory with `tsx --test` and
`NODE_OPTIONS=--conditions=react-server`. The integration test creates a new
private local Unix-socket PostgreSQL cluster, uses synthetic data and real
`pg_dump` schema files, and removes that cluster. It reads no application DSN
or provider credentials. Its binary path can be configured through
`MEDIA_BACKUP_TEST_PG_BIN`.

The actual restore test covers bigint/numeric/bytea, generated and identity
columns, sequence state, constraints, functions, triggers and RLS. Other tests
cover authentication failures, ciphertext tampering, immutable response-loss
recovery, page bounds, stale aliases, closure, wrong target/owner/marker and
metadata-only workflow receipts.
