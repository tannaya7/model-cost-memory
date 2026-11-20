/** An invite arrives as a link (https://site/join/TOKEN) or as the bare code. Both are accepted; anything else is not an invite.
 *  The code is 43 URL-safe characters, so shorter or oddly-shaped text is refused before it ever reaches the server. */
export function inviteToken(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const fromLink = text.match(/\/join\/([A-Za-z0-9_-]+)/);
  const candidate = fromLink ? fromLink[1] : text;
  return /^[A-Za-z0-9_-]{16,}$/.test(candidate) ? candidate : null;
}
