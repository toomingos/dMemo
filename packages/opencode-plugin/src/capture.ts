// Text-extraction + light hygiene helpers used by the capture path. Kept
// pure/side-effect-free so unit tests exercise them without any OpenCode
// context or DmemoSession at all.

export interface TextPartLike {
  type: string;
  text?: string;
}

export interface MessagePartsLike {
  info: { role: string; id?: string };
  parts: TextPartLike[];
}

/** Concatenate every `text` part's content for a role, in order. */
export function extractText(parts: TextPartLike[] | undefined): string {
  if (!parts || parts.length === 0) return '';
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
    .trim();
}

/** Pull the most recent message of a given role out of a session message list. */
export function lastMessageOfRole(
  messages: MessagePartsLike[] | undefined,
  role: string
): MessagePartsLike | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info.role === role) return messages[i];
  }
  return undefined;
}

const SECRET_RE = /(sk-[a-zA-Z0-9]{10,}|0x[a-fA-F0-9]{64}|-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----)/g;

/** Best-effort redaction of obvious secrets before anything is captured
 * into memory (API keys, private key material). Not a security boundary —
 * dMemo's actual privacy guarantee is end-to-end encryption at the storage
 * layer (D2/D9); this only avoids needlessly persisting obvious secrets
 * in plaintext-shaped memory text. */
export function redact(text: string): string {
  return text.replace(SECRET_RE, '[redacted]');
}

/** Build the verbatim memory text for a captured turn. */
export function buildTurnText(userText: string, assistantText: string): string {
  const u = redact(userText).trim();
  const a = redact(assistantText).trim();
  if (!a) return u;
  return `User: ${u}\nAssistant: ${a}`;
}
