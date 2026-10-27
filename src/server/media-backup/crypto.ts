import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { backupLabelPattern, CloudBackupError, type BackupEncryption } from './types';

const magic = Buffer.from('JESIECBK', 'ascii');
const nonceBytes = 12;
const tagBytes = 16;
const maximumHeaderBytes = 2048;
export const encryptedBackupOverheadLimit = maximumHeaderBytes + 4 + magic.length + nonceBytes + tagBytes;

export const backupDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function validateEncryption(encryption: BackupEncryption, context: string) {
  if (!Buffer.isBuffer(encryption.key) || encryption.key.length !== 32 || !backupLabelPattern.test(encryption.keyId)
    || !/^[A-Za-z0-9_./-]{1,1000}$/.test(context)) throw new CloudBackupError('BACKUP_KEY_CONFIGURATION');
}

/** Fresh nonce for each attempted create; the committed ciphertext is immutable. */
export function encryptBackupBytes(plaintext: Buffer, encryption: BackupEncryption, context: string): Buffer {
  validateEncryption(encryption, context);
  const metadata = Buffer.from(JSON.stringify({ version: 1, algorithm: 'AES-256-GCM', keyId: encryption.keyId, context }));
  if (metadata.length > maximumHeaderBytes) throw new CloudBackupError('BACKUP_ENVELOPE_INVALID');
  const length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
  const nonce = randomBytes(nonceBytes);
  const header = Buffer.concat([magic, length, metadata, nonce]);
  const cipher = createCipheriv('aes-256-gcm', encryption.key, nonce, { authTagLength: tagBytes });
  cipher.setAAD(header);
  return Buffer.concat([header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** Never returns unauthenticated plaintext, even if the body/header has changed. */
export function decryptBackupBytes(ciphertext: Buffer, encryption: BackupEncryption, context: string, maximumBytes: number): Buffer {
  validateEncryption(encryption, context);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || ciphertext.length > maximumBytes + encryptedBackupOverheadLimit
    || ciphertext.length < magic.length + 4 + nonceBytes + tagBytes || !ciphertext.subarray(0, magic.length).equals(magic)) throw new CloudBackupError('BACKUP_ENVELOPE_INVALID');
  const length = ciphertext.readUInt32BE(magic.length);
  const metadataEnd = magic.length + 4 + length;
  const headerEnd = metadataEnd + nonceBytes;
  if (!length || length > maximumHeaderBytes || headerEnd + tagBytes > ciphertext.length) throw new CloudBackupError('BACKUP_ENVELOPE_INVALID');
  try {
    const metadata = JSON.parse(ciphertext.subarray(magic.length + 4, metadataEnd).toString('utf8'));
    if (metadata.version !== 1 || metadata.algorithm !== 'AES-256-GCM' || metadata.keyId !== encryption.keyId || metadata.context !== context) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', encryption.key, ciphertext.subarray(metadataEnd, headerEnd), { authTagLength: tagBytes });
    decipher.setAAD(ciphertext.subarray(0, headerEnd));
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - tagBytes));
    const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(headerEnd, ciphertext.length - tagBytes)), decipher.final()]);
    if (plaintext.length > maximumBytes) throw new Error();
    return plaintext;
  } catch { throw new CloudBackupError('BACKUP_AUTHENTICATION_FAILED'); }
}
