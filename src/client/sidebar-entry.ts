/**
 * Mount a self-healing sidebar entry for the 路由系统 (Routing System),
 * placed directly ABOVE dsh-mnemon's 记忆系统 entry when that is present.
 *
 * The DOM pattern mirrors dsh-mnemon's sidebar-entry.ts: an official-style
 * row under the New Session row, with a MutationObserver keeping it in place
 * as the shell re-renders. We deliberately order the family selector so the
 * router entry sits above the memory entry.
 */
import { ROUTER_ENTRY_SELECTOR, ROUTER_TITLE } from '../shared.ts'
import type { RouterWorkspaceController } from './workspace-controller.ts'

/** Other plugin families that occupy the same sidebar region. */
const FAMILY_SELECTOR =
  '[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-mnemon-entry], [data-dsh-router-entry]'

/** The entry we want to sit above (dsh-mnemon's 记忆系统), when present. */
const ABOVE_TARGET_SELECTOR = '[data-dsh-mnemon-entry]'

function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>(
    '[data-pane="sidebar"], [class*="sidebarCol"], .dshDesktopUpstreamSidebar',
  )
  if (column === null) return undefined
  return column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
    ?? (column.firstElementChild as HTMLElement | undefined)
}

function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

function createIcon(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const icon = document.createElementNS(namespace, 'svg')
  icon.setAttribute('viewBox', '0 0 16 16')
  icon.setAttribute('width', '18')
  icon.setAttribute('height', '18')
  icon.setAttribute('fill', 'none')
  icon.setAttribute('stroke', 'currentColor')
  icon.setAttribute('stroke-width', '1.5')
  icon.setAttribute('stroke-linecap', 'round')
  icon.setAttribute('stroke-linejoin', 'round')
  icon.setAttribute('aria-hidden', 'true')
  // A simple node-graph "route" glyph: three dots joined by two paths.
  const c1 = document.createElementNS(namespace, 'circle')
  c1.setAttribute('cx', '3.5'); c1.setAttribute('cy', '3.5'); c1.setAttribute('r', '1.6')
  const c2 = document.createElementNS(namespace, 'circle')
  c2.setAttribute('cx', '12.5'); c2.setAttribute('cy', '3.5'); c2.setAttribute('r', '1.6')
  const c3 = document.createElementNS(namespace, 'circle')
  c3.setAttribute('cx', '8'); c3.setAttribute('cy', '12.5'); c3.setAttribute('r', '1.6')
  const p1 = document.createElementNS(namespace, 'path')
  p1.setAttribute('d', 'M5.1 3.5h6.8')
  const p2 = document.createElementNS(namespace, 'path')
  p2.setAttribute('d', 'M3.5 5.1v4.3c0 1.7 2 2.2 3 2.4')
  const p3 = document.createElementNS(namespace, 'path')
  p3.setAttribute('d', 'M12.5 5.1v4.3c0 1.7-2 2.2-3 2.4')
  icon.append(c1, c2, c3, p1, p2, p3)
  return icon
}

function createEntry(controller: RouterWorkspaceController): { entry: HTMLButtonElement; label: HTMLSpanElement } {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshRouterEntry = ''
  entry.className = 'dshr-entry'
  const icon = document.createElement('span')
  icon.className = 'dshr-entryIcon'
  icon.append(createIcon())
  const label = document.createElement('span')
  label.className = 'dshr-entryLabel'
  entry.append(icon, label)
  entry.addEventListener('click', () => { controller.toggle() })
  return { entry, label }
}

function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement === root) return true
  const row = button.closest('[class*="logoRow"]')
  const base = row !== null && row.parentElement === root ? row : button
  const family = Array.from(root.children).filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element.matches(FAMILY_SELECTOR),
  )
  // Prefer to sit directly above dsh-mnemon's entry; otherwise after the
  // last known family entry, else after the New Session row.
  const aboveTarget = Array.from(root.children).find(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element.matches(ABOVE_TARGET_SELECTOR),
  )
  let anchor: Element | null
  if (aboveTarget !== undefined) {
    anchor = aboveTarget
  } else {
    anchor = family.at(-1)?.nextElementSibling ?? base.nextElementSibling
  }
  root.insertBefore(entry, anchor)
  return true
}

/** Mount a self-healing 路由系统 entry above the 记忆系统 row. */
export function mountRouterSidebarEntry(
  controller: RouterWorkspaceController,
): () => void {
  const { entry, label } = createEntry(controller)
  let root: HTMLElement | undefined
  let placed = false

  const syncLabel = (): void => {
    if (entry.getAttribute('aria-label') !== ROUTER_TITLE) entry.setAttribute('aria-label', ROUTER_TITLE)
    if (entry.title !== ROUTER_TITLE) entry.title = ROUTER_TITLE
    if (label.textContent !== ROUTER_TITLE) label.textContent = ROUTER_TITLE
  }

  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) placed = placeEntry(root, entry)
  })

  const tryPlace = (): void => {
    syncLabel()
    if (root !== undefined && !root.isConnected) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed && document.body.contains(entry)) return
    if (placed) {
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) rootObserver.observe(root, { childList: true, subtree: true })
  }

  const waitObserver = new MutationObserver(tryPlace)
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const syncActive = (): void => {
    if (controller.getSnapshot().open) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const unsubscribe = controller.subscribe(syncActive)
  syncActive()
  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribe()
    entry.remove()
  }
}
