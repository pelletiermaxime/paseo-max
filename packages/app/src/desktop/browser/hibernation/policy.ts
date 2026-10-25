export interface WorkspaceBrowserPolicy {
  workspaceKey: string;
  inactiveAfterMs: number;
}

/** The caller supplies time; user viewing and automation are independent activity. */
export class BrowserHibernationPolicy {
  private readonly policies = new Map<string, Map<string, number>>();
  private readonly activity = new Map<string, number>();
  private readonly visible = new Map<string, Set<object>>();
  private readonly leases = new Map<string, number>();
  private readonly keptAwake = new Set<string>();

  public set(owner: string, policy: WorkspaceBrowserPolicy, now: number): void {
    const policies = this.policies.get(policy.workspaceKey) ?? new Map<string, number>();
    policies.set(owner, policy.inactiveAfterMs);
    this.policies.set(policy.workspaceKey, policies);
    if (!this.activity.has(policy.workspaceKey)) this.activity.set(policy.workspaceKey, now);
  }

  public removeOwner(owner: string): void {
    for (const workspaceKey of this.policies.keys()) this.remove(owner, workspaceKey);
  }

  public remove(owner: string, workspaceKey: string): void {
    const policies = this.policies.get(workspaceKey);
    if (!policies) return;
    policies.delete(owner);
    if (policies.size > 0) return;
    this.policies.delete(workspaceKey);
    this.activity.delete(workspaceKey);
  }

  public view(workspaceKey: string, token: object, now: number): () => void {
    const viewers = this.visible.get(workspaceKey) ?? new Set<object>();
    viewers.add(token);
    this.visible.set(workspaceKey, viewers);
    this.touch(workspaceKey, now);
    return () => {
      viewers.delete(token);
      if (viewers.size === 0) this.visible.delete(workspaceKey);
    };
  }

  public isVisible(workspaceKey: string): boolean {
    return this.visible.has(workspaceKey);
  }

  public touch(workspaceKey: string, now: number): void {
    this.activity.set(workspaceKey, now);
  }

  public lease(browserId: string): () => void {
    this.leases.set(browserId, (this.leases.get(browserId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.leases.get(browserId) ?? 1) - 1;
      if (count === 0) this.leases.delete(browserId);
      else this.leases.set(browserId, count);
    };
  }

  public keepAwake(browserId: string, enabled: boolean): void {
    if (enabled) this.keptAwake.add(browserId);
    else this.keptAwake.delete(browserId);
  }

  public eligible(input: { workspaceKey: string; browserId: string; now: number }): boolean {
    const policies = this.policies.get(input.workspaceKey);
    if (!policies || this.visible.has(input.workspaceKey)) return false;
    if (this.leases.has(input.browserId) || this.keptAwake.has(input.browserId)) return false;
    const timeout = Math.max(...policies.values());
    const lastActivity = this.activity.get(input.workspaceKey) ?? input.now;
    return input.now - lastActivity >= timeout;
  }

  public get hasPolicies(): boolean {
    return this.policies.size > 0;
  }
}

export const browserHibernationPolicy = new BrowserHibernationPolicy();
