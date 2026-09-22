export interface RecoveryOptions {
  maxAutomaticRecoveries: number;
  recoveryWindowMs: number;
}

export class RecoveryPolicy {
  private usedAt: Map<string, number[]> = new Map();

  constructor(private readonly opts: RecoveryOptions) {}

  canRecover(sessionID: string, now: number): boolean {
    this.prune(sessionID, now);
    const used = this.usedAt.get(sessionID) ?? [];
    return used.length < this.opts.maxAutomaticRecoveries;
  }

  recordRecovery(sessionID: string, now: number): void {
    const list = this.usedAt.get(sessionID) ?? [];
    list.push(now);
    this.usedAt.set(sessionID, list);
  }

  disabledUntil(sessionID: string, now: number): number {
    this.prune(sessionID, now);
    const used = this.usedAt.get(sessionID) ?? [];
    if (used.length < this.opts.maxAutomaticRecoveries) return 0;
    const oldest = used[0] ?? 0;
    return oldest + this.opts.recoveryWindowMs;
  }

  private prune(sessionID: string, now: number): void {
    const list = this.usedAt.get(sessionID);
    if (!list) return;
    const cutoff = now - this.opts.recoveryWindowMs;
    const remaining = list.filter((t) => t >= cutoff);
    if (remaining.length > 0) this.usedAt.set(sessionID, remaining);
    else this.usedAt.delete(sessionID);
  }

  reset(sessionID: string): void {
    this.usedAt.delete(sessionID);
  }
}