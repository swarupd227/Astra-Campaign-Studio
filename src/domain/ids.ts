import { randomUUID } from "node:crypto";

/** Short, prefixed, human-scannable ids for artifacts, campaigns and eval runs. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/**
 * A pluggable clock. Injectable so tests and replays are deterministic
 * (the real system uses the system clock; tests pass a fixed one).
 */
export interface Clock {
  now(): string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export function fixedClock(iso: string): Clock {
  return { now: () => iso };
}
