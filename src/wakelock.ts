/** Keep the screen awake while listening. Fails silently where unsupported. */

let sentinel: WakeLockSentinel | null = null;
let wanted = false;

async function acquire(): Promise<void> {
  if (!wanted || sentinel || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => {
      if (sentinel === lock) sentinel = null;
    });
    if (wanted) sentinel = lock;
    else void lock.release().catch(() => {});
  } catch {
    // Denied, low battery, or unsupported: the app works without it.
  }
}

export function keepAwake(): void {
  wanted = true;
  void acquire();
}

export function allowSleep(): void {
  wanted = false;
  const lock = sentinel;
  sentinel = null;
  void lock?.release().catch(() => {});
}

// The browser drops the lock whenever the page is hidden.
document.addEventListener('visibilitychange', () => void acquire());
