export interface RouterWorkspaceSnapshot {
  open: boolean
}

/** Small framework-neutral state holder shared by the sidebar row and panel. */
export class RouterWorkspaceController {
  private snapshot: RouterWorkspaceSnapshot = { open: false }
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): RouterWorkspaceSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  open(): void { this.setOpen(true) }
  close(): void { this.setOpen(false) }
  toggle(): void { this.setOpen(!this.snapshot.open) }

  private setOpen(open: boolean): void {
    if (this.snapshot.open === open) return
    this.snapshot = { open }
    for (const listener of this.listeners) listener()
  }
}
