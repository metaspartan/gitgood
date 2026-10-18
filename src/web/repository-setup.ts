function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function pushInstructions(url: string, branch: string): string {
  const ref = branch.trim() || "main";
  return `git remote add origin ${shellArgument(url)}\ngit branch -M ${shellArgument(ref)}\ngit push -u origin ${shellArgument(ref)}`;
}
