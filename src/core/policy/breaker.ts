export type BreakerState = "closed" | "open";

export interface TripOutcome {
  allowed: boolean;
  openedNow: boolean;
}

export class SessionBreaker {
  private state: BreakerState = "closed";
  private tripLog: number[] = [];
  private actedAt: number | null = null;

  constructor(
    private readonly cooldownMs = 60_000,
    private readonly windowMs = 600_000,
  ) {}

  /** True when the circuit is open OR we are inside the action cooldown. */
  isOpen(now: number): boolean {
    if (this.state === "open") return true;
    return this.actedAt !== null && now - this.actedAt < this.cooldownMs;
  }

  stateName(): BreakerState {
    return this.state;
  }

  /** Timestamp of the first trip in the cycle that opened (or would open) the circuit. */
  openedSince(): number | undefined {
    if (this.tripLog.length === 0) return undefined;
    return this.tripLog[0];
  }

  tripCount(): number {
    return this.tripLog.length;
  }

  /** Record a confirmed trip. The second trip inside the recovery window opens the circuit. */
  recordTripDetailed(now: number): TripOutcome {
    if (this.state === "open") return { allowed: false, openedNow: false };
    if (this.isOpen(now)) return { allowed: false, openedNow: false };
    this.tripLog.push(now);
    this.actedAt = now;
    this.prune(now);
    let openedNow = false;
    if (this.tripLog.length >= 2) {
      this.state = "open";
      openedNow = true;
    }
    return { allowed: true, openedNow };
  }

  recordTrip(now: number): boolean {
    return this.recordTripDetailed(now).allowed;
  }

  reset(): void {
    this.state = "closed";
    this.tripLog = [];
    this.actedAt = null;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    const remaining = this.tripLog.filter((t) => t >= cutoff);
    this.tripLog = remaining;
  }
}