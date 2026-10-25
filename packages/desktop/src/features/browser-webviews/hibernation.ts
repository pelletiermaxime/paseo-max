import type { WebContents } from "electron";

const closingGuests = new WeakSet<object>();

type HibernationGuest = Pick<WebContents, "isDestroyed" | "once" | "removeListener" | "close">;

/** The caller resolves only a guest owned by the requesting host window. */
export async function hibernateBrowserGuest(input: {
  guest: HibernationGuest;
  canHibernate?: () => boolean;
  authorize?: () => Promise<boolean>;
  signal?: AbortSignal;
  onClosed?: () => void;
  timeoutMs?: number;
  now?: () => number;
  scheduleTimeout?: (expire: () => void, milliseconds: number) => () => void;
}): Promise<boolean> {
  const { guest } = input;
  const canHibernate = input.canHibernate ?? (() => true);
  const now = input.now ?? (() => performance.now());
  const timeoutMs = input.timeoutMs ?? 3_000;
  const expiresAt = now() + timeoutMs;
  if (closingGuests.has(guest) || input.signal?.aborted) return false;

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let closing = false;
    const cancelTimeout = (input.scheduleTimeout ?? scheduleTimeout)(
      () => finished(false),
      timeoutMs,
    );
    function finished(closed: boolean): void {
      if (settled) return;
      settled = true;
      cancelTimeout();
      input.signal?.removeEventListener("abort", aborted);
      resolve(closed);
    }
    function clearClosing(): void {
      if (!closing) return;
      closing = false;
      guest.removeListener("destroyed", destroyed);
      closingGuests.delete(guest);
    }
    function destroyed(): void {
      clearClosing();
      // close() cannot be recalled after Chromium starts closing. Reconcile
      // a late destruction even when the caller's bounded wait has expired.
      input.onClosed?.();
      finished(true);
    }
    function aborted(): void {
      finished(false);
    }
    function eligible(): boolean {
      return (
        !settled &&
        now() < expiresAt &&
        !closingGuests.has(guest) &&
        !guest.isDestroyed() &&
        canHibernate()
      );
    }
    async function authorizeAndClose(): Promise<void> {
      if (!eligible()) return finished(false);
      if (input.authorize && !(await input.authorize())) return finished(false);
      if (!eligible()) return finished(false);
      closing = true;
      closingGuests.add(guest);
      guest.once("destroyed", destroyed);
      // Inactive unpinned tabs are discarded, including unsaved page state. Pinning
      // is the explicit opt-out; page beforeunload handlers cannot block the policy.
      guest.close({ waitForBeforeUnload: false });
    }
    input.signal?.addEventListener("abort", aborted, { once: true });
    void authorizeAndClose().catch((error: unknown) => {
      clearClosing();
      if (settled) return;
      settled = true;
      cancelTimeout();
      input.signal?.removeEventListener("abort", aborted);
      reject(error);
    });
  });
}

function scheduleTimeout(expire: () => void, milliseconds: number): () => void {
  const timer = setTimeout(expire, milliseconds);
  return () => clearTimeout(timer);
}

interface HibernationRequest {
  hostId: number;
  attemptId: string;
  guest: HibernationGuest;
  canHibernate: () => boolean;
  onClosed: () => void;
}

/** A guest closes only after its renderer rechecks the current policy. */
export class BrowserHibernationRequests {
  private readonly attempts = new Map<
    string,
    {
      hostId: number;
      controller: AbortController;
      commit: (authorized: boolean) => void;
      completion: Promise<boolean>;
    }
  >();

  public prepare(input: HibernationRequest): Promise<boolean> {
    const key = JSON.stringify([input.hostId, input.attemptId]);
    if (this.attempts.has(key)) throw new Error("Duplicate hibernation attempt");
    const controller = new AbortController();
    const authorization = deferred<boolean>();
    const ready = deferred<boolean>();
    const completion = hibernateBrowserGuest({
      ...input,
      signal: controller.signal,
      authorize: () => {
        ready.resolve(true);
        return authorization.promise;
      },
    }).finally(() => {
      this.attempts.delete(key);
    });
    this.attempts.set(key, {
      hostId: input.hostId,
      controller,
      commit: authorization.resolve,
      completion,
    });
    // prepare owns preparation errors; commit also observes the same completion.
    void completion.then(() => ready.resolve(false), ready.reject);
    return ready.promise;
  }

  public async commit(hostId: number, attemptId: string): Promise<void> {
    const attempt = this.attempts.get(JSON.stringify([hostId, attemptId]));
    if (!attempt) return;
    attempt.commit(true);
    await attempt.completion;
  }

  public cancel(hostId: number, attemptId: string): void {
    this.attempts.get(JSON.stringify([hostId, attemptId]))?.controller.abort();
  }

  public cancelHost(hostId: number): void {
    for (const attempt of this.attempts.values()) {
      if (attempt.hostId === hostId) attempt.controller.abort();
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
