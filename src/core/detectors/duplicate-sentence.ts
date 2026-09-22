import { finding } from "./detector.js";
import { jaccard, sentenceSplit, tokenize } from "./similarity.js";

interface SentenceEntry {
  norm: string;
  tokens: string[];
  at: number;
}

interface GroupCount {
  key: string;
  occurrences: number;
  lastAt: number;
}

export class DuplicateSentenceDetector {
  private entries: SentenceEntry[] = [];
  private groups: GroupCount[] = [];

  constructor(
    private readonly threshold: number,
    private readonly windowMs = 120_000,
    private readonly similarity = 0.9,
    private readonly maxEntries = 300,
  ) {}

  addText(text: string, now: number): number {
    let added = 0;
    for (const norm of sentenceSplit(text)) {
      const tokens = tokenize(norm);
      if (tokens.length < 2) continue;
      this.entries.push({ norm, tokens, at: now });
      added++;
      if (this.entries.length > this.maxEntries) this.entries.shift();
    }
    this.prune(now);
    this.recountGroups(now);
    return added;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.entries.length > 0 && this.entries[0]!.at < cutoff) this.entries.shift();
  }

  private recountGroups(now: number): void {
    const groups = new Map<string, GroupCount>();
    for (let i = 0; i < this.entries.length; i++) {
      const a = this.entries[i]!;
      let key = a.norm;
      const candidate = this.groups.find((g) => g.key === key) ?? undefined;
      if (candidate && candidate.lastAt >= a.at - 1) {
        key = candidate.key;
      }
      const group = groups.get(key);
      if (group) {
        group.occurrences++;
        group.lastAt = a.at;
      } else {
        groups.set(key, { key, occurrences: 1, lastAt: a.at });
      }
    }
    this.groups = [...groups.values()].filter((g) => g.occurrences >= 2);
  }

  queryCount(normSentence: string, now: number): number {
    this.prune(now);
    this.recountGroups(now);
    const tokens = tokenize(normSentence);
    if (tokens.length === 0) return 0;
    let best = 0;
    for (const e of this.entries) {
      if (jaccard(e.tokens, tokens) >= this.similarity) best++;
    }
    return best;
  }

  find(now: number) {
    const hits: ReturnType<typeof finding>[] = [];
    this.prune(now);
    this.recountGroups(now);
    for (const g of this.groups) {
      if (g.occurrences >= this.threshold) {
        hits.push(
          finding({
            detector: "duplicate_sentence",
            severity: "composite",
            trigger: `sentence repeated ${g.occurrences} times ("${g.key.slice(0, 60)}")`,
            count: g.occurrences,
            weight: 0.9,
            excerpt: typeof g.key === "string" ? g.key.slice(0, 120) : undefined,
            measure: { occurrences: g.occurrences, sentence: g.key.slice(0, 100) },
            at: now,
          }),
        );
      }
    }
    return hits;
  }
}