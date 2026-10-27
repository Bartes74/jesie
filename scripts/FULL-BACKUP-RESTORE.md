# Full jesie.pl recovery checkpoint

The `full-2026-10-14` checkpoint has independent copies on the project volume
and the Mac's internal volume. A checkpoint includes the consistent PostgreSQL
custom dump, its structural and row proofs, schema/migrations, application
source, fonts/static assets, complete media inventory with exact original
filenames, compaction mappings, private drafts/history/Trash, and encrypted
application configuration. No entire user Keychain or SSH directory is copied.

`portable-full-2026-10-14.tar.aesgcm` contains the immutable data checkpoint.
The accompanying `verification-evidence.tar.aesgcm` retains restore reports,
checksums and the final reviewed backup/test scripts. After extracting the source
archive, use the `tooling/scripts/` overlay from that evidence package when
rerunning the drill; its last change checks every lazily loaded desktop/mobile
image before taking a full-page screenshot. Application runtime files are the
unchanged source snapshot, not patched production files.

The database reference export comes from the same read-only PostgreSQL snapshot
as the dump. Blob is not transactionally coupled to PostgreSQL: the media capture
checks all required effective Blob paths and repeats inventory until stable.
Additional captured objects are retained, including in-flight/recovery objects.

Two forms are retained deliberately: an operational, private, read-only
SHA-256 media vault, and a portable AES-256-GCM encrypted checkpoint archive.
Only exact byte duplicates share a vault object. The former legacy backup
filenames can become a verified compatibility index after independent restore
tests. The running application's media remain ordinary separate files.

## Restore without contacting production

1. Read `BACKUP-ENCRYPTION.md` first. Decrypt the portable checkpoint to a new
   private directory with `encrypt-backup.ts`; verify the archive SHA against its
   independent receipt before extracting. Never load the archived production
   environment into a test app.
2. Decrypt `database.dump.private.aesgcm` and restore with `backup-db.ts` into a
   temporary PostgreSQL cluster listening only on a Unix socket. Verify table
   hashes, sequence state and structural/security metadata against the proof.
   The local drill omits production owner/ACL assignments explicitly; the dump
   retains them for a separately controlled real recovery.
3. Verify the media manifest with `media-backup-vault.ts verify` and reconstruct
   it with `restore` into an empty directory. It restores all original names as
   independent regular files, including private media and historical backups.
4. Decrypt and extract `application-source-final.tar.aesgcm`. Verify every file
   against `source-manifest-final.private.json`. Rebuild dependencies from the
   captured package lock with a compatible Node runtime. No production build
   output or dependency binaries are required in the archive.
5. Run `verify-restored-application.ts` with this clean source, restored media,
   manifest and the local socket-only database. It creates its own database
   clone and disposable source copy. It uses an offline media adapter, a fresh
   synthetic authentication secret and synthetic test account. Real provider,
   Blob, cron, IndexNow and Vercel credentials are absent. Both an OS network
   sandbox and JavaScript egress guard restrict communication to the explicit
   test HTTP port and database socket. Automation routes fail closed.
6. Require a PASS report for the actual build, public PL/EN pages, structured
   data, full/responsive media, authenticated private media, editor/history,
   draft/Trash restore and desktop/mobile cooking interactions. Original rows,
   all jobs/assets/cost ledgers and the pristine restored database must remain
   unchanged. Preserve reports before deleting temporary test trees.

Keep automatic publishing, photo generation, trends and IndexNow disabled during
any subsequent real recovery until an operator has reviewed restored state and
credentials. This drill never invokes a paid provider, submits a workflow,
publishes a recipe or writes to production storage/database.

## Key and retention limits

The encryption key currently exists only in a dedicated new item in this Mac's
Keychain. Two disk archives are recoverable through it now, but they are not an
off-site key backup. Recovery after losing this Mac requires the owner to retain
the key separately in a protected location; key export is an explicit operation
and has not been performed automatically. FileVault and billing are unchanged.

Retain both independent encrypted checkpoint copies, their SHA receipts, media
manifests and restore evidence. Operational vault objects are still readable
private files and must remain while legacy compatibility links refer to them.
Never remove an original merely because its recipe is unpublished, in Trash,
superseded or associated with an unfinished job. Remove only exact duplicate
legacy copies with the guarded `dedup-apply` command, or our newly created
temporary plaintext restore directories after complete verification.
