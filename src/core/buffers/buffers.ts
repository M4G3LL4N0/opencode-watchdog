export interface Timestamped {
  at: number;
}

export class RingBuffer<T> {
  private items: T[] = [];
  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error("capacity must be positive");
  }

  push(item: T): T | undefined {
    let evicted: T | undefined;
    this.items.push(item);
    if (this.items.length > this.capacity) {
      evicted = this.items.shift();
    }
    return evicted;
  }

  get all(): T[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }
}

export class RollingWindow<T extends Timestamped> {
  private entries: T[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly capacity: number = 10_000,
  ) {}

  push(entry: T, now: number): void {
    if (!entry || typeof entry.at !== "number") return;
    this.prune(now);
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  prune(now: number): void {
    const cutoff = now - this.windowMs;
    let remove = 0;
    while (remove < this.entries.length && this.entries[remove]!.at < cutoff) remove++;
    if (remove > 0) this.entries.splice(0, remove);
  }

  count(now: number): number {
    this.prune(now);
    return this.entries.length;
  }

  within(now: number): T[] {
    this.prune(now);
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }

  get last(): T | undefined {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1] : undefined;
  }
}

export class BoundedString {
  private buffer = "";
  constructor(private readonly maxChars: number) {}

  append(text: string): void {
    if (!text) return;
    this.buffer += text;
    if (this.buffer.length > this.maxChars) {
      this.buffer = this.buffer.slice(this.buffer.length - this.maxChars);
    }
  }

  set(text: string): void {
    this.buffer = text.length > this.maxChars ? text.slice(text.length - this.maxChars) : text;
  }

  tail(length: number): string {
    return this.buffer.slice(Math.max(0, this.buffer.length - length));
  }

  slice(start: number, end?: number): string {
    return end === undefined ? this.buffer.slice(start) : this.buffer.slice(start, end);
  }

  get text(): string {
    return this.buffer;
  }

  get length(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = "";
  }
}