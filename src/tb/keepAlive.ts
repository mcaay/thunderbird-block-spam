// Keeps the non-persistent background page alive while a long job runs, by calling a
// cheap extension API every 20 seconds. Without it the page could be suspended in
// the middle of a network request.

const INTERVAL_MS = 20 * 1000;

let holders = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** Starts holding the page awake. Returns the function that releases the hold. */
export function hold(): () => void {
  holders += 1;
  if (timer === null) {
    timer = setInterval(() => {
      void browser.runtime.getPlatformInfo().catch(() => undefined);
    }, INTERVAL_MS);
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    holders -= 1;
    if (holders === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export async function withKeepAlive<T>(run: () => Promise<T>): Promise<T> {
  const release = hold();
  try {
    return await run();
  } finally {
    release();
  }
}
