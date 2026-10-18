export function referenceHref(owner: string, repo: string, raw: string): string | null {
  const m = /^(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#(\d+)$/.exec(raw);
  if (!m) return null;
  const [, refOwner, refRepo, numRaw] = m;
  const num = Number(numRaw);
  if (!Number.isSafeInteger(num) || num < 1) return null;
  const targetOwner = refOwner ?? owner;
  const targetRepo = refRepo ?? repo;
  return `/${encodeURIComponent(targetOwner)}/${encodeURIComponent(targetRepo)}/issues/${num}`;
}
