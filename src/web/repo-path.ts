export function joinRepoPath(baseDir: string, relative: string): string {
  const segments: string[] = [];
  for (const part of `${baseDir ? `${baseDir}/` : ""}${relative}`.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}
