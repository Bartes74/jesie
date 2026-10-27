/** Copy the exact private image bytes into a repeatable standard upload body. */
export function createPrivatePhotoBody(bytes: Uint8Array, contentType: string): Blob {
  return new Blob([new Uint8Array(bytes)], { type: contentType });
}
