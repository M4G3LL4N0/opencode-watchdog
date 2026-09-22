import { finding } from "./detector.js";
import { jaccard, tokenize } from "./similarity.js";

interface Utterance {
  tokens: string[];
  at: number;
  lastActionAt: number;
}

interface NarrationGroup {
  repTokens: string[];
  occurrences: number;
  lastMemberAt: number;
  firstAt: number;
  shown: boolean;
}

export class NarrationDetector {
  private recent: Utterance[] = [];
  private groups: NarrationGroup[] = [];

  constructor(
    private readonly similarity = 0.86,
    private readonly threshold = 4,
    private readonly windowMs = 200_000,
    private readonly maxRecent = 24,
  ) {}

  onUtterance(text: string, now: number, lastActionAt: number): void {
    const tokens = tokenize(text);
    if (tokens.length < 3) return;
    this.prune(now);
    this.record(tokens, now, lastActionAt);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.recent.length > 0 && this.recent[0]!.at < cutoff) this.recent.shift();
    this.groups = this.groups.filter((g) => now - g.lastMemberAt <= this.windowMs);
  }

  private record(tokens: string[], at: number, lastActionAt: number): void {
    let matched: NarrationGroup | undefined;
    for (const g of this.groups) {
      if (jaccard(g.repTokens, tokens) >= this.similarity && lastActionAt <= g.lastMemberAt) {
        matched = g;
        break;
      }
    }
    let group: NarrationGroup;
    if (matched) {
      group = matched;
      group.occurrences++;
      group.lastMemberAt = at;
    } else {
      group = { repTokens: tokens, occurrences: 1, lastMemberAt: at, firstAt: at, shown: false };
      this.groups.push(group);
    }
    this.recent.push({ tokens, at, lastActionAt });
    if (this.recent.length > this.maxRecent) this.recent.shift();
  }

  find(now: number) {
    const hits: ReturnType<typeof finding>[] = [];
    this.prune(now);
    for (const g of this.groups) {
      if (g.occurrences >= this.threshold && !g.shown) {
        g.shown = true;
        hits.push(
          finding({
            detector: "near_duplicate_narration",
            severity: "composite",
            trigger: `near-duplicate narration repeated ${g.occurrences} times with no action between`,
            count: g.occurrences,
            weight: 0.6,
            excerpt: g.repTokens.join(" ").slice(0, 120),
            measure: { occurrences: g.occurrences, sample: g.repTokens.slice(0, 10).join(" ") },
            at: now,
          }),
        );
      }
    }
    return hits;
  }

  reset(): void {
    this.recent = [];
    this.groups = [];
  }
}