# Media archive catalog and conservative retention

No module in this directory exposes Blob deletion. Media GC is a dry-run plan;
editing originals, final masters, compact redirects, masks, recovery sources and
unknown objects are retained. Unreferenced does not mean disposable.

Integration APIs:

- `loadArchiveReferenceSnapshot(query, recoveryRegistry)` requires an already-open
  `REPEATABLE READ READ ONLY` or `SERIALIZABLE READ ONLY` PostgreSQL transaction.
  It reads all recipes including Trash, all immutable versions/publications,
  ingredient reuse, job input/results, photo batches, trends, recipe recovery,
  compaction mappings and the optional `media_delivery_variant` table.
- `readBundledRecoveryRegistry()` supplies the three exact recovery manifests.
  Consume them inside the encrypted snapshot step; do not serialize the raw
  registry or database contents as workflow events.
- `buildArchiveCatalog(sourceStoreId, blobs, snapshot)` accepts safe metadata
  `{pathname,size,etag,uploadedAt}` and returns classifications, reference IDs and
  a deterministic graph hash. `complete` means reference-source coverage;
  `referencedPathsAbsentFromInventory` must be satisfied by independently verified
  application-bundle aliases before backup closure. GC conservatively preserves
  everything while any referenced primary path is absent.
- `copyBundledMediaPage({cursor,pageSize,destination,encryption})` handles at most
  five files from the four explicit source roots. It delegates encryption,
  immutable content-addressed writes and exact-byte readback/restore to the shared
  backup primitives. Filesystem paths remain internal; metadata uses virtual
  `sourceStoreId: applicationbundle`, `app-public/...` and `app-private/...` names.
- `readBundledMediaAliasPage({cursor,pageSize})` returns the same bounded metadata
  page without writes. Canonical Blob aliases require matching SHA-256 and byte
  length from a known recovery manifest and the actual regular file. Provider
  backups verify their receipt manifest but acquire no invented Blob aliases.

The bundle cursor fingerprint contains deployment identity plus sorted virtual
path/size metadata, not device/inode/mtime. Exact bytes have SHA-256 ETags and a
stable virtual `uploadedAt` of 1970-01-01. OS timestamps and inode checks only
detect races within one local read. A changed deployment must restart the bundle
inventory/cursor; encrypted content-addressed objects remain reusable.

Include `public/images/**` and all three `private-media/*-recovery/**` directories
in the backup route/workflow's output tracing. Missing required roots/manifests,
symlinks, oversized files, changed files or invalid hashes fail closed. Hidden
files, secrets/configuration and files outside these explicit roots have no
backup namespace.

`planArchiveGc` additionally requires a fresh complete graph (15 minutes), exact
strong ETags, an independent encrypted copy with readback and media restore proof
(24 hours), and 30 days of unchanged quarantine. Only exact known derivative
versions can reach `eligible_for_review`; `deletionEnabled` remains false.

`planSnapshotRetention` independently retains 30 daily and 12 monthly restore
points per snapshot kind, plus the latest good point. Pending, failed, unrestored,
unverified and content-addressed media objects are always retained. A superseded
snapshot requires a strictly newer good snapshot with fresh readback and restore
proof. For PostgreSQL, `restoreVerified` means a real isolated PostgreSQL restore;
JSON validation or encrypted-byte decryption alone is insufficient. The function
returns a plan and never performs deletion.
