// storage.local behind one serialized write queue. Only the background page writes.

import type { KeyValueStore } from "../core/ports";

export class BrowserStore implements KeyValueStore {
  private queue: Promise<void> = Promise.resolve();

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  set(items: Record<string, unknown>): Promise<void> {
    return this.enqueue(() => browser.storage.local.set(items));
  }

  remove(keys: string[]): Promise<void> {
    return this.enqueue(() => browser.storage.local.remove(keys));
  }

  clear(): Promise<void> {
    return this.enqueue(() => browser.storage.local.clear());
  }

  /** Everything in storage, after pending writes have finished. */
  async all(): Promise<Record<string, unknown>> {
    await this.queue;
    return browser.storage.local.get(null);
  }
}
