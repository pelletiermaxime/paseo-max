import { create } from "zustand";
import type { PluginWorkspaceResources } from "@getpaseo/plugin/client";
import { getDesktopHost } from "@/desktop/host";
import { useBrowserStore } from "@/desktop/browser/store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { getResidentBrowserWebview, removeResidentBrowserWebview } from "../resident-webviews";
import { browserHibernationPolicy } from "./policy";

export const useBrowserHibernation = create<{
  sleeping: ReadonlySet<string>;
  keptAwake: ReadonlySet<string>;
}>(() => ({ sleeping: new Set(), keptAwake: new Set() }));

export function useBrowserHibernated(browserId: string | null): boolean {
  return useBrowserHibernation((state) => browserId !== null && state.sleeping.has(browserId));
}

let timer: ReturnType<typeof setInterval> | null = null;
let checking = false;
let listening = false;
const guestIds = new WeakMap<HTMLElement, number>();
const pending = new Map<
  string,
  {
    workspaceKey: string;
    completion: Promise<void>;
    cancel: () => void;
  }
>();

export function getSleepingBrowserIds(): ReadonlySet<string> {
  return useBrowserHibernation.getState().sleeping;
}

export async function waitForBrowserHibernation(browserId: string): Promise<void> {
  await pending.get(browserId)?.completion;
}

export function setBrowserKeepAwake(browserId: string, enabled: boolean): void {
  browserHibernationPolicy.keepAwake(browserId, enabled);
  if (enabled) pending.get(browserId)?.cancel();
  const keptAwake = new Set(useBrowserHibernation.getState().keptAwake);
  if (enabled) keptAwake.add(browserId);
  else keptAwake.delete(browserId);
  useBrowserHibernation.setState({ keptAwake });
}

export function wakeBrowser(browserId: string): void {
  const sleeping = new Set(useBrowserHibernation.getState().sleeping);
  if (!sleeping.delete(browserId)) return;
  useBrowserHibernation.setState({ sleeping });
}

export function forgetBrowserHibernation(browserId: string): void {
  pending.get(browserId)?.cancel();
  browserHibernationPolicy.keepAwake(browserId, false);
  const state = useBrowserHibernation.getState();
  if (!state.sleeping.has(browserId) && !state.keptAwake.has(browserId)) return;
  const sleeping = new Set(state.sleeping);
  const keptAwake = new Set(state.keptAwake);
  sleeping.delete(browserId);
  keptAwake.delete(browserId);
  useBrowserHibernation.setState({ sleeping, keptAwake });
}

export function viewBrowserWorkspace(input: { serverId: string; workspaceId: string }): () => void {
  const workspaceKey = buildWorkspaceTabPersistenceKey(input);
  if (!workspaceKey) return () => {};
  const release = browserHibernationPolicy.view(workspaceKey, {}, Date.now());
  cancelIneligibleAttempts();
  const setVisibility = getDesktopHost()?.browser?.setWorkspaceVisibility;
  void setVisibility?.({ workspaceId: input.workspaceId, visible: true }).catch((error) => {
    console.warn("[browser-hibernation] Could not register workspace visibility", error);
  });
  return () => {
    release();
    browserHibernationPolicy.touch(workspaceKey, Date.now());
    if (!browserHibernationPolicy.isVisible(workspaceKey)) {
      void setVisibility?.({ workspaceId: input.workspaceId, visible: false }).catch((error) => {
        console.warn("[browser-hibernation] Could not release workspace visibility", error);
      });
    }
  };
}

export function createWorkspaceResources(input: {
  serverId: string;
  ownerId: string;
  signal: AbortSignal;
}): PluginWorkspaceResources | undefined {
  const bridge = getDesktopHost()?.browser;
  if (
    !bridge?.prepareHibernation ||
    !bridge.hibernate ||
    !bridge.cancelHibernation ||
    !bridge.onHibernated ||
    !bridge.setWorkspaceVisibility
  )
    return undefined;
  if (!listening) {
    // A committed Chromium close can finish after plugin disposal or our deadline.
    // Keep this listener for the renderer's lifetime so late closes are reconciled.
    bridge.onHibernated(browserHibernated);
    listening = true;
  }
  const owner = JSON.stringify([input.serverId, input.ownerId]);
  input.signal.addEventListener(
    "abort",
    () => {
      browserHibernationPolicy.removeOwner(owner);
      cancelIneligibleAttempts();
      updateTimer();
    },
    { once: true },
  );
  return {
    setPolicy(policy) {
      if (input.signal.aborted) return;
      const workspaceId = policy.workspaceId.trim();
      const timeout = policy.browserTabs.hibernateAfterWorkspaceInactiveMs;
      const validTimeout = timeout === null || (Number.isSafeInteger(timeout) && timeout >= 1_000);
      if (!workspaceId || !validTimeout) throw new Error("Invalid workspace browser policy");
      const workspaceKey = buildWorkspaceTabPersistenceKey({
        serverId: input.serverId,
        workspaceId,
      });
      if (!workspaceKey) throw new Error("Invalid workspace browser policy");
      if (timeout === null) browserHibernationPolicy.remove(owner, workspaceKey);
      else
        browserHibernationPolicy.set(owner, { workspaceKey, inactiveAfterMs: timeout }, Date.now());
      cancelIneligibleAttempts();
      updateTimer();
    },
  };
}

function cancelIneligibleAttempts(): void {
  for (const [browserId, attempt] of pending) {
    if (
      !browserHibernationPolicy.eligible({
        workspaceKey: attempt.workspaceKey,
        browserId,
        now: Date.now(),
      })
    ) {
      attempt.cancel();
    }
  }
}

function browserHibernated(input: {
  browserId: string;
  webContentsId: number;
  url: string;
  title: string;
}): void {
  const webview = getResidentBrowserWebview(input.browserId);
  if (!webview || !useBrowserStore.getState().browsersById[input.browserId]) return;
  if (readGuestId(webview) !== input.webContentsId) return;
  useBrowserStore.getState().updateBrowser(input.browserId, {
    url: input.url,
    title: input.title,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
  });
  removeResidentBrowserWebview(input.browserId);
  markBrowserSleeping(input.browserId);
}

function markBrowserSleeping(browserId: string): void {
  const sleeping = useBrowserHibernation.getState().sleeping;
  if (sleeping.has(browserId)) return;
  const nextSleeping = new Set(sleeping);
  nextSleeping.add(browserId);
  useBrowserHibernation.setState({ sleeping: nextSleeping });
}

function readGuestId(webview: HTMLElement): number | undefined {
  try {
    if ("getWebContentsId" in webview && typeof webview.getWebContentsId === "function") {
      const id: unknown = webview.getWebContentsId();
      if (typeof id === "number") guestIds.set(webview, id);
    }
  } catch {
    // Electron can reject guest access after destroyed; use its pre-close identity.
  }
  return guestIds.get(webview);
}

function hibernateBrowser(
  workspaceKey: string,
  browserId: string,
  webview: HTMLElement,
): Promise<void> {
  const bridge = getDesktopHost()?.browser;
  const prepare = bridge?.prepareHibernation;
  const commit = bridge?.hibernate;
  const cancel = bridge?.cancelHibernation;
  if (!prepare || !commit || !cancel) return Promise.resolve();
  readGuestId(webview);
  const attemptId = globalThis.crypto.randomUUID();
  const controller = new AbortController();
  const cancelled = new Promise<void>((resolve) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        resolve();
        void cancel(attemptId).catch((error) =>
          console.warn("[browser-hibernation] Could not cancel attempt", error),
        );
      },
      { once: true },
    );
  });
  const deadline = setTimeout(() => controller.abort(), 4_000);
  const operation = (async () => {
    if (!(await prepare({ browserId, attemptId }))) return;
    const eligible = browserHibernationPolicy.eligible({
      workspaceKey,
      browserId,
      now: Date.now(),
    });
    if (controller.signal.aborted || !eligible || getResidentBrowserWebview(browserId) !== webview)
      return;
    await commit(attemptId);
  })();
  const completion = Promise.race([operation, cancelled]).finally(() => {
    clearTimeout(deadline);
    controller.abort();
    pending.delete(browserId);
  });
  pending.set(browserId, { workspaceKey, completion, cancel: () => controller.abort() });
  return completion;
}

function updateTimer(): void {
  if (!browserHibernationPolicy.hasPolicies && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (browserHibernationPolicy.hasPolicies && timer === null) {
    timer = setInterval(() => {
      void hibernateInactiveBrowsers();
    }, 5_000);
  }
}

async function hibernateInactiveBrowsers(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    for (const [workspaceKey, layout] of Object.entries(
      useWorkspaceLayoutStore.getState().layoutByWorkspace,
    )) {
      for (const tab of collectAllTabs(layout.root)) {
        if (tab.target.kind !== "browser") continue;
        const browserId = tab.target.browserId;
        const eligible = browserHibernationPolicy.eligible({
          workspaceKey,
          browserId,
          now: Date.now(),
        });
        if (!eligible) continue;
        const webview = getResidentBrowserWebview(browserId);
        if (!webview) {
          // Restored tabs may reach the timeout without ever creating a guest.
          markBrowserSleeping(browserId);
          continue;
        }
        await hibernateBrowser(workspaceKey, browserId, webview);
      }
    }
  } catch (error) {
    console.warn("[browser-hibernation] Could not hibernate inactive browser", error);
  } finally {
    checking = false;
  }
}
