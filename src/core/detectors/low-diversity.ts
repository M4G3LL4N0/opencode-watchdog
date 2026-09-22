import { finding } from "./detector.js";
import { tokenize } from "./similarity.js";

export interface WordDiversityOptions {
  minTokens: number;
  topUnigramRatio: number;
  topBigramRatio: number;
}

export class WordDiversityDetector {
  constructor(private readonly opts: WordDiversityOptions = { minTokens: 200, topUnigramRatio: 0.35, topBigramRatio: 0.5 }) {}

  analyze(text: string, now: number) {
    const tokens = tokenize(text);
    const hits: ReturnType<typeof finding>[] = [];
    if (tokens.length < this.opts.minTokens) return hits;

    const unigrams = new Map<string, number>();
    const bigrams = new Map<string, number>();
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      unigrams.set(t, (unigrams.get(t) ?? 0) + 1);
      if (i + 1 < tokens.length) {
        const b = `${t} ${tokens[i + 1]!}`;
        bigrams.set(b, (bigrams.get(b) ?? 0) + 1);
      }
    }
    let topUnigram = { token: "", count: 0 };
    for (const [t, c] of unigrams) if (c > topUnigram.count) topUnigram = { token: t, count: c };
    let topBigram = { token: "", count: 0 };
    for (const [t, c] of bigrams) if (c > topBigram.count) topBigram = { token: t, count: c };

    const unigramRatio = topUnigram.count / tokens.length;
    const bigramRatio = bigrams.size > 0 ? topBigram.count / (tokens.length - 1) : 0;

    if (unigramRatio >= this.opts.topUnigramRatio || bigramRatio >= this.opts.topBigramRatio) {
      hits.push(
        finding({
          detector: "low_diversity",
          severity: "composite",
          trigger: `low word diversity (top unigram "${topUnigram.token}" = ${(unigramRatio * 100).toFixed(0)}% of ${tokens.length} tokens)`,
          count: tokens.length,
          weight: 0.4,
          excerpt: topUnigram.token.length > 0 ? topUnigram.token.slice(0, 60) : undefined,
          measure: { tokens: tokens.length, unigramRatio, bigramRatio, topUnigram: topUnigram.token, topBigram: topBigram.token },
          at: now,
        }),
      );
    }
    return hits;
  }
}