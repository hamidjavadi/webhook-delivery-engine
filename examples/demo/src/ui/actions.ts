export type ClipboardWriter = (value: string) => Promise<void>;

export async function copyToClipboard(
  value: string,
  writeText?: ClipboardWriter,
): Promise<boolean> {
  try {
    const write = writeText ?? ((text: string) => navigator.clipboard.writeText(text));
    await write(value);
    return true;
  } catch {
    return false;
  }
}
