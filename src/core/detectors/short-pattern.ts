import { finding } from "./detector.js";
import { sanitize } from "./similarity.js";

function scanTail(text: string, maxPatternLength: number, minRepeats: number): { pattern: string; repeats: number } | null {
  const maxScan = Math.min(text.length, maxPatternLength * minRepeats + maxPatternLength);
  const tail = text.slice(-maxScan);
  for (let L = maxPatternLength; L >= 1; L--) {
    for (let offset = 0; offset < L; offset++) {
      const base = tail.length - offset;
      if (base < L * minRepeats) continue;
      const chunk = tail.slice(base - L, base);
      if (chunk.length !== L) continue;
      let repeats = 0;
      let pos = base - L;
      while (pos >= 0 && tail.slice(pos, pos + L) === chunk) {
        repeats++;
        pos -= L;
      }
      if (repeats >= minRepeats) {
        return { pattern: chunk, repeats };
      }
    }
  }
  return null;
}

export class ShortPatternDetector {
  private lastFindingAt = 0;

  constructor(
    private readonly maxPatternLength: number,
    private readonly hardRepeatThreshold: number,
  ) {}

  get latestAt(): number {
    return this.lastFindingAt;
  }

  inspect(text: string, now: number) {
    const hits: ReturnType<typeof finding>[] = [];
    const result = scanTail(text, this.maxPatternLength, this.hardRepeatThreshold);
    if (result) {
      this.lastFindingAt = now;
      hits.push(
        finding({
          detector: "short_pattern",
          severity: "hard",
          trigger: `repeated short pattern "${sanitize(result.pattern, 12)}" (${result.repeats} contiguous repeats)`,
          count: result.repeats,
          weight: 1,
          excerpt: sanitize(result.pattern, 12),
          measure: { patternLength: result.pattern.length, repeats: result.repeats },
          at: now,
        }),
      );
    }
    return hits;
  }
}