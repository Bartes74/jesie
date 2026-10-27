# Media vault and restore

`media-backup-vault.ts` is an offline recovery tool. Its only remote operations
are Blob `list` and `get`. It does not submit photographs, alter PostgreSQL,
upload files, delete remote objects, approve recipes or publish them.

The vault contains one immutable file per exact SHA-256 under
`objects/sha256/<first-two-hex-digits>/<sha256>`. Each checkpoint manifest retains
every original Blob pathname and every local filename, root, source/final/proof
byte count and hash. Distinct source pixels, reviewed final alpha and historical
encodings remain distinct objects. Exact duplicate bytes share one object.
Recovery bundles and application photographs remain regular, separate files in
the running application. They are never hardlinked or consolidated into the
vault.

Every export includes the complete live Blob inventory, not only photographs
referenced by public recipes. Its default local roots are `public/`,
`private-media/` and `/Volumes/Projekty/jesie-private-media-backup`. They include
private drafts, history, Trash and provider recovery media. All existing legacy
proof files and originals are retained. Files are copied rather than linked;
vault objects are read-only and the private directories have mode `0700`.

Example commands, run from the repository root with the configured Node runtime:

```sh
npx tsx scripts/media-backup-vault.ts export \
  --env=.env.production.local \
  --vault=/Volumes/Projekty/jesie-backup-vault \
  --checkpoint=2026-10-14-full \
  --references=/absolute/private/db-media-references.private.json

npx tsx scripts/media-backup-vault.ts verify \
  --manifest=/Volumes/Projekty/jesie-backup-vault/checkpoints/2026-10-14-full/manifest.private.json

npx tsx scripts/media-backup-vault.ts mirror \
  --manifest=/Volumes/Projekty/jesie-backup-vault/checkpoints/2026-10-14-full/manifest.private.json \
  --destination-vault='/Users/master/Library/Application Support/jesie-backups/vault'

npx tsx scripts/media-backup-vault.ts restore \
  --manifest=/Volumes/Projekty/jesie-backup-vault/checkpoints/2026-10-14-full/manifest.private.json \
  --destination=/absolute/empty/restore-directory
```

The references JSON may contain the complete asset/job/history reference export
from the same PostgreSQL snapshot as the database dump. If it contains
`requiredBlobPathnames: string[]`, each name must be an effective physical Blob
pathname after resolving `media_compaction.source_pathname` to its target. A
missing required object stops finalization. The complete JSON is retained by
hash and is restored under `metadata/db-media-references.private.json`.

Blob is listed before and after reads until the inventory is stable. Interrupted
exports can reuse their verified progress records. Final manifests are immutable;
start a new checkpoint label for a subsequent snapshot. The manifest distinguishes
capture start/end and PostgreSQL reference provenance; it does not claim an
atomic transaction spanning PostgreSQL and Blob. Every captured current or
historical Blob object remains in the checkpoint. A new in-flight photograph
after the PostgreSQL snapshot can appear as an additional object safely.

Restoration reconstructs ordinary independent files under:

- `blob/<original Blob pathname>`;
- `local/app-public/<original public path>`;
- `local/app-private-media/<original private-media path>`;
- `local/legacy-media-backup/<original archived filename>`.

The destination must be empty. Every reconstructed file is hashed again and a
`restore-receipt.private.json` records the exact manifest digest and real storage
device. Copy the reconstructed application roots into the matching clean source
checkout; restore the separately encrypted PostgreSQL dump and configuration
using the database backup runbook. The vault alone is not a complete application
or database backup. Restored Blob files are an offline artifact; this tool does
not write them to a provider or enable public access.

## Consolidating the former backup directory

After full service restoration and media restore tests succeed on two distinct
volumes, the old backup directory can become a compatibility index. The command
requires both media restore receipts and verifies both reconstructed legacy trees,
the vault and current originals before replacing any source. It then atomically
replaces each legacy regular file with a relative symlink to the verified
read-only vault object. Every original filename remains readable; a new restore
can reconstruct its original regular file at any time. Only this explicit
`legacy` root is eligible; application roots are forbidden. Interrupted
consolidation can resume after verifying existing links and remaining sources.

```sh
npx tsx scripts/media-backup-vault.ts dedup-plan \
  --manifest=/Volumes/Projekty/jesie-backup-vault/checkpoints/2026-10-14-full/manifest.private.json \
  --legacy-root=/Volumes/Projekty/jesie-private-media-backup

npx tsx scripts/media-backup-vault.ts dedup-apply \
  --manifest=/Volumes/Projekty/jesie-backup-vault/checkpoints/2026-10-14-full/manifest.private.json \
  --legacy-root=/Volumes/Projekty/jesie-private-media-backup \
  --restore-receipt=/absolute/usb/restore/restore-receipt.private.json \
  --second-restore-receipt=/absolute/internal/restore/restore-receipt.private.json
```

Future exports accept only legacy symlinks that resolve to verified objects in
the same vault; arbitrary symlinks and symlinks in application roots fail closed.
Future compaction maintenance should write its new proofs to a new private
timestamped backup directory, rather than overwrite the read-only checkpoint
index. Retain both independent vault copies, database/configuration checkpoints,
application source and manifests. Temporary restore test directories may be
removed after their verification reports and full-service evidence are retained.
Neither age nor current publication state is a deletion criterion.
