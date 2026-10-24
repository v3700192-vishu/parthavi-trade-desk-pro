export function createSharedRefresh({ maxInFlightLingerMs = 60000 } = {}) {
  const inflight = new Map();

  return function sharedRefresh(key, loader, timeoutMs = 15000) {
    const current = inflight.get(key);
    if (current) return current.promise;

    let timeoutId = null;
    let cleanupId = null;
    const work = Promise.resolve().then(loader);
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        timeoutId = null;
        reject(new Error("Shared refresh timed out: " + key));
      }, timeoutMs);
    });
    const promise = Promise.race([work, timeout]);
    const entry = { promise };
    inflight.set(key, entry);

    const cleanup = () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (cleanupId !== null) clearTimeout(cleanupId);
      if (inflight.get(key) === entry) inflight.delete(key);
    };

    // A response timeout must not release the key while its underlying provider
    // request is still running; doing so spawned overlapping copies every poll.
    // Retire the entry when the real work settles, with a backstop for stuck work.
    work.then(cleanup, cleanup);
    cleanupId = setTimeout(() => {
      if (inflight.get(key) === entry) inflight.delete(key);
    }, Math.max(maxInFlightLingerMs, timeoutMs * 4));

    return promise;
  };
}
