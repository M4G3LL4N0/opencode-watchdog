import { BoundedString } from "../buffers/buffers.js";
import type { DetectorFinding } from "./detector.js";
import { DuplicateSentenceDetector } from "./duplicate-sentence.js";
import { NarrationDetector } from "./near-duplicate-narration.js";
import { ShortPatternDetector } from "./short-pattern.js";
import { WordDiversityDetector } from "./low-diversity.js";
import type { WatchdogConfig } from "../../config/config.js";

const MAX_BUFFER_CHARS = 120_000;
const DIVERSITY_WINDOW_CHARS = 24_000;

export class TextChannel {
  private acc = new BoundedString(MAX_BUFFER_CHARS);
  private point = 0;
  private lastAnalyzedFull: string | null = null;
  private pattern: ShortPatternDetector;
  private diversity: WordDiversityDetector;
  private dupSentence: DuplicateSentenceDetector;
  private narration: NarrationDetector;
  private lastActivityAt = 0;
  private readonly dupSentenceThreshold: number;

  constructor(cfg: WatchdogConfig) {
    this.pattern = new ShortPatternDetector(cfg.shortPatternMaxLength, cfg.shortPatternHardRepeat);
    this.diversity = new WordDiversityDetector();
    this.dupSentenceThreshold = cfg.duplicateSentenceThreshold;
    this.dupSentence = new DuplicateSentenceDetector(this.dupSentenceThreshold);
    this.narration = new NarrationDetector();
  }

  onDelta(delta: string, now: number): DetectorFinding[] {
    this.acc.append(delta);
    this.lastActivityAt = now;
    return this.pattern.inspect(this.acc.tail(Math.min(24_000, this.acc.length)), now);
  }

  onSnapshot(text: string, now: number): DetectorFinding[] {
    if (text === this.lastAnalyzedFull) return [];
    const prefix = this.acc.slice(0, this.point);
    if (!text.startsWith(prefix)) this.point = 0;
    this.acc.set(text);
    if (this.point > this.acc.length) this.point = this.acc.length;
    this.lastAnalyzedFull = text;
    this.lastActivityAt = now;
    return this.pattern.inspect(this.acc.tail(Math.min(24_000, this.acc.length)), now);
  }

  idleSeconds(now: number): number {
    if (this.lastActivityAt === 0) return Number.POSITIVE_INFINITY;
    return (now - this.lastActivityAt) / 1000;
  }

  flush(now: number, lastActionAt: number): DetectorFinding[] {
    const hits: DetectorFinding[] = [];
    const pending = this.acc.slice(this.point);
    if (pending.trim().length > 0) {
      hits.push(...this.diversity.analyze(this.acc.tail(Math.min(DIVERSITY_WINDOW_CHARS, this.acc.length)), now));
      this.dupSentence.addText(pending, now);
      this.narration.onUtterance(pending, now, lastActionAt);
      this.point = this.acc.length;
    }
    hits.push(...this.dupSentence.find(now));
    hits.push(...this.narration.find(now));
    return hits;
  }

  reset(): void {
    this.acc.clear();
    this.point = 0;
    this.lastAnalyzedFull = null;
    this.dupSentence = new DuplicateSentenceDetector(this.dupSentenceThreshold);
    this.narration = new NarrationDetector();
  }
}