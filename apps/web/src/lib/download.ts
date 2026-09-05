/** Offers `bytes` as a file download (Creator console artifacts). Browser only. */
export function downloadBytes(
  name: string,
  bytes: Uint8Array | string,
  type = "application/octet-stream",
): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
