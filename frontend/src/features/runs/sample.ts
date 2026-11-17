/** Plain, countable facts about a task's calls, and which example calls to show. No randomness, no AI. */

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/** The longest run of opening words shared by at least half of the previews (and at least two) (two words or more), or null. */
export function commonStart(previews: (string | null | undefined)[], minWords = 2): string | null {
  const list = previews.filter((p): p is string => !!p && p.trim() !== "").map(words);
  if (list.length < 2) return null;
  const need = Math.max(2, Math.ceil(list.length / 2));
  const longest = Math.max(...list.map((w) => w.length));
  for (let k = longest; k >= minWords; k--) {
    const counts = new Map<string, number>();
    for (const w of list) {
      if (w.length < k) continue;
      const key = w.slice(0, k).join(" ");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let best: string | null = null;
    for (const [key, n] of counts) if (n >= need && (best === null || key < best)) best = key;
    if (best) return best;
  }
  return null;
}

/** The median word count of the previews, only when none was cut at the preview limit (so the size is real). */
export function typicalWords(previews: (string | null | undefined)[], limit = 240): number | null {
  const list = previews.filter((p): p is string => !!p && p.trim() !== "");
  if (list.length === 0 || list.some((p) => p.length >= limit)) return null;
  const counts = list.map((p) => words(p).length).sort((a, b) => a - b);
  const mid = Math.floor(counts.length / 2);
  return counts.length % 2 ? counts[mid] : Math.round((counts[mid - 1] + counts[mid]) / 2);
}

export interface SummaryFacts {
  calls: number;
  tokensIn: number;
  previews: (string | null | undefined)[];
}

/** The honest summary lines. `tokens` is true when the size is given in tokens (so tokens need explaining). */
export function summaryLines(f: SummaryFacts): { sent: string; typical: string | null; tokens: boolean } {
  const sent = `Your app sent ${f.calls.toLocaleString("en")} AI ${f.calls === 1 ? "call" : "calls"} here in the last 30 days.`;
  const start = commonStart(f.previews);
  const w = typicalWords(f.previews);
  const hasPreviews = f.previews.some((p) => !!p);
  let typical: string | null = null;
  let tokens = false;
  if (hasPreviews && (start || w != null)) {
    if (w != null) typical = `${start ? `A typical prompt starts "${start}" and` : "A typical prompt"} is about ${w} ${w === 1 ? "word" : "words"}.`;
  }
  if (typical === null && f.calls > 0 && f.tokensIn > 0) {
    const n = Math.round(f.tokensIn / f.calls);
    typical = `${start ? `A typical prompt starts "${start}" and` : "A typical prompt"} is about ${n.toLocaleString("en")} tokens.`;
    tokens = true;
  }
  return { sent, typical, tokens };
}

interface Call {
  created_at: string;
  prompt_preview?: string | null;
}

const newest = <T extends Call>(a: T[]) => [...a].sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at));
const wordSet = (s: string | null | undefined) => new Set(words((s ?? "").toLowerCase()));

/** (i) the latest correct call; (ii) of the latest 20 correct calls, the one sharing the fewest words with (i)
 * (ties: the longest prompt, then the newest); needs two correct calls. */
export function pickPassExamples<T extends Call>(pass: T[]): { typical: T | null; different: T | null } {
  const list = newest(pass).slice(0, 20);
  if (list.length === 0) return { typical: null, different: null };
  const typical = list[0];
  if (list.length < 2) return { typical, different: null };
  const base = wordSet(typical.prompt_preview);
  let different: T | null = null;
  let bestShared = Infinity;
  let bestLen = -1;
  for (const r of list.slice(1)) {
    const set = wordSet(r.prompt_preview);
    let shared = 0;
    for (const w of set) if (base.has(w)) shared++;
    const len = (r.prompt_preview ?? "").length;
    if (shared < bestShared || (shared === bestShared && len > bestLen)) {
      different = r;
      bestShared = shared;
      bestLen = len;
    }
  }
  return { typical, different };
}
