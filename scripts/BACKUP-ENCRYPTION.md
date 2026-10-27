# Encrypted jesie.pl backups

`encrypt-backup.ts` streams AES-256-GCM with a fresh 12-byte nonce and a 16-byte
authentication tag. Its versioned header is authenticated too. A plaintext
restore becomes visible under its final name only after authentication succeeds.
Existing outputs are never overwritten; new files are regular files with mode
`0600`. Neither the key nor plaintext is printed in arguments or logs.

The native helper is compiled once at:

`/Users/master/Library/Application Support/jesie-backups/tools/backup-keychain`

Only this stable executable is trusted to read the newly provisioned generic
password entry `jesie-backup-2026` / `aes256gcm-v1`. It accesses no other keychain
item, replaces no existing secret, disables interactive prompts in its own
process and does not enable cloud synchronization. Recompiling or replacing the
binary may require renewed Keychain authorization; do not do it automatically.

From the repository root, using the existing Node 22 runtime:

```sh
node_modules/.bin/tsx scripts/encrypt-backup.ts ensure-key
node_modules/.bin/tsx scripts/encrypt-backup.ts encrypt --input=/absolute/checkpoint.tar --output=/absolute/checkpoint.tar.aesgcm
node_modules/.bin/tsx scripts/encrypt-backup.ts decrypt --input=/absolute/checkpoint.tar.aesgcm --output=/absolute/restored-checkpoint.tar
```

Output JSON contains only format/algorithm, byte counts, file SHA-256, nonce,
authentication tag and the Keychain service/account names. Nonces and tags are
public encryption metadata. Save the file SHA and checkpoint manifest together
with the encrypted copy, then decrypt into a separate private directory and
verify the original file SHA. File verification does not replace the full
database-and-media application restore test.

The file format is 8 ASCII bytes `JESIEBKP`, one version byte `1`, the 12-byte
nonce, ciphertext, and the final 16-byte GCM tag. All 21 header bytes are AAD.

## Recovery after loss of this Mac

The encrypted copies on two disks are recoverable now through this Mac's
Keychain. Losing the Mac and its Keychain also loses access unless the owner has
retained the 32-byte recovery key separately. This is not an independent,
off-site recovery-key backup. Do not copy the entire login Keychain, SSH keys or
other credentials as a workaround.

`export-key --output=/absolute/new-recovery-key.bin` is an explicit capability
for an operator-approved private destination. It creates a `0600` binary file
without printing its bytes. It is not part of normal backup/encryption and must
not be run automatically or stored inside the archive it unlocks. Keep that key
in a separately protected location controlled by the owner.

On a replacement Mac, compile the reviewed helper at its stable private path,
then feed that existing binary key to the helper's `create` mode through stdin,
before generating any replacement key. `create` never overwrites an existing
entry. Verify decryption and the checkpoint SHA before enabling any workers.
Do not invoke the helper's raw `read` mode in a terminal or tool transcript;
`encrypt-backup.ts` captures its output privately in an internal pipe.

If Keychain is locked or an application permission requires a password, the
helper returns a safe numeric status and stops. It changes no global Keychain,
account, FileVault or operating-system permission setting.
