export const MAX_QUOTA_BYTES = 1024 ** 5;

export function parseQuotaInput(input: string): number | null {
  const text = input.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) throw new Error("Enter a whole number of bytes, 0 for unlimited, or leave empty for the instance default.");
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > MAX_QUOTA_BYTES) throw new Error("Quota must be between 0 and 1 PiB.");
  return value;
}
