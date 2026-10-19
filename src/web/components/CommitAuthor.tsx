import type { ReactNode } from "react";
import { Avatar } from "../components.tsx";
import { Link } from "../router.tsx";
import type { Commit } from "../types.ts";

export function hueFromString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) % 360;
  return hash;
}

export function CommitAuthor({ author, size = "sm" }: { author: Commit["author"]; size?: "sm" | "lg" }): ReactNode {
  const name = author.name || author.email || "unknown";
  const avatar = (
    <Avatar
      size={size}
      user={{
        username: author.username ?? (author.email || name),
        display_name: name,
        avatar_hue: author.avatar_hue ?? hueFromString(author.email || name),
      }}
    />
  );
  if (!author.username) {
    return (
      <span className="commit-author" title={author.email ? `${name} <${author.email}>` : name}>
        {avatar}
        <span className="commit-author-name">{name}</span>
      </span>
    );
  }
  return (
    <Link to={`/${author.username}`} className="commit-author is-linked" title={`${name} (${author.username})`}>
      {avatar}
      <span className="commit-author-name">{author.username}</span>
    </Link>
  );
}
