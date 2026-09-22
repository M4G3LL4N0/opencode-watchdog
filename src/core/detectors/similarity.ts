const VOLATILE_KEY_RE = /^(sessionID|messageID|assistantMessageID|callID|toolCallID|id|tmpID|fileID|timestamp|time|startedAt|createdAt|updatedAt)$/;

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .trim();
}

export function tokenize(s: string): string[] {
  return normalizeText(s).split(/\s+/).filter((t) => t.length > 0);
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}

export function sentenceSplit(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^\W+$/.test(s) && /[\p{L}\p{N}]/u.test(s));
  const out: string[] = [];
  for (const p of parts) {
    const t = tokenize(p);
    if (t.length > 0) out.push(t.join(" "));
  }
  return out;
}

export function canonicalKey(input: unknown): string {
  if (input == null) return "{}";
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(rec).sort()) {
        if (VOLATILE_KEY_RE.test(k)) continue;
        const value = norm(rec[k]);
        if (value !== undefined) out[k] = value;
      }
      return out;
    }
    if (typeof v === "number") return Math.round(v * 100_000) / 100_000;
    if (typeof v === "string") return v.trim();
    return v;
  };
  try {
    return JSON.stringify(norm(input));
  } catch {
    return "{}";
  }
}

export function sanitize(snippet: string, maxLen = 200): string {
  if (!snippet) return "";
  let out = snippet.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > maxLen) out = out.slice(0, maxLen) + "…";
  return out;
}

const SECRET_RE =
  /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|api[_-]?key["'\s:=]+[A-Za-z0-9._~+/=-]{8,}|Authorization\s*:\s*[A-Za-z0-9._~+/=-]{8,})/gi;

export function redact(text: string): string {
  if (!text) return text;
  return text.replace(SECRET_RE, "[REDACTED]");
}