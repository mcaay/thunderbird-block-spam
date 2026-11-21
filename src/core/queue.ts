// A queue that runs one job at a time. Shared by all triggers of the mail pipeline.
// It lives in memory only: an interrupted run simply continues on the next tick.

export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly waiting = new Set<string>();
  private active = 0;

  /** True while a job is running or waiting. */
  get busy(): boolean {
    return this.active > 0;
  }

  /**
   * Adds a job. When a key is given and a job with the same key is still waiting
   * to start, the new job is dropped and false is returned.
   */
  add(job: () => Promise<void>, key?: string): boolean {
    if (key !== undefined) {
      if (this.waiting.has(key)) {
        return false;
      }
      this.waiting.add(key);
    }
    this.active += 1;
    this.tail = this.tail.then(async () => {
      if (key !== undefined) {
        this.waiting.delete(key);
      }
      try {
        await job();
      } catch (error) {
        console.error("Block Spam: job failed", error);
      } finally {
        this.active -= 1;
      }
    });
    return true;
  }

  /** Resolves when every job added so far has finished. */
  idle(): Promise<void> {
    return this.tail;
  }
}
