import type { PluginWorkspaceResources } from "@getpaseo/plugin/client";

export function useBrowserHibernated(_browserId: string | null): boolean {
  return false;
}

export function createWorkspaceResources(_input: {
  serverId: string;
  ownerId: string;
  signal: AbortSignal;
}): PluginWorkspaceResources | undefined {
  return undefined;
}

export function viewBrowserWorkspace(_input: {
  serverId: string;
  workspaceId: string;
}): () => void {
  return () => {};
}

export function getSleepingBrowserIds(): ReadonlySet<string> {
  return new Set();
}
export async function waitForBrowserHibernation(_browserId: string): Promise<void> {}
export function wakeBrowser(_browserId: string): void {}
export function forgetBrowserHibernation(_browserId: string): void {}
