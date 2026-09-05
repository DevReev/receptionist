import { poolFull } from './errors.ts';

/** Capped browser concurrency. Excess degrades as 429 retries, never corruption. */
export class Pool {
  #active = 0;
  #max: number;
  constructor(max: number) {
    this.#max = max;
  }


  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#max) throw poolFull();
    this.#active += 1;
    try {
      return await fn();
    } finally {
      this.#active -= 1;
    }
  }
}
