/**
 * Mount the 路由系统 center-column takeover panel, mirroring dsh-mnemon's
 * workspace-mount.tsx: a React root appended to the conversation column,
 * shown via `data-dsh-router-active` on <html>, and coordinated with the
 * other sidebar panels (taskboard / ssh / mnemon) through the shared
 * `dsh-panel-activate` event.
 */
import { createRoot, type Root } from 'react-dom/client'
import { ROUTER_ACTIVE_ATTR } from '../shared.ts'
import { RouterView } from './RouterView.tsx'
import { mountRouterSidebarEntry } from './sidebar-entry.ts'
import { RouterWorkspaceController } from './workspace-controller.ts'

const CONVERSATION_COLUMN_SELECTOR =
  '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const SIDEBAR_CONTEXT_SELECTOR =
  '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

function mountPanel(controller: RouterWorkspaceController): () => void {
  function Panel(): JSX.Element {
    // 不改 document.title：这是宿主页面（会话）的标题，插件不该动它。
    return <RouterView onBack={() => controller.close()} />
  }

  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined && container.isConnected) return
    if (container !== undefined) {
      root?.unmount()
      root = undefined
      container = undefined
    }
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshRouterView = ''
    container.className = 'dshr-panelView'
    column.append(container)
    root = createRoot(container)
    root.render(<Panel />)
  }

  const waitObserver = new MutationObserver(ensure)
  waitObserver.observe(document.body, { childList: true, subtree: true })

  let suppressCompatibilityClose = false
  const applyActive = (): void => {
    if (!controller.getSnapshot().open) {
      document.documentElement.removeAttribute(ROUTER_ACTIVE_ATTR)
      return
    }
    // Announce the other panels so they close; mirror dsh-mnemon's
    // compatibility broadcast (taskboard/ssh listen to 'ssh'/'taskboard').
    suppressCompatibilityClose = true
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'ssh' }))
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'taskboard' }))
    suppressCompatibilityClose = false
    document.documentElement.setAttribute(ROUTER_ACTIVE_ATTR, '')
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'router' }))
  }

  const onOtherPanelActivate = (event: Event): void => {
    if (suppressCompatibilityClose || !controller.getSnapshot().open) return
    const detail = (event as CustomEvent<unknown>).detail
    if (detail === 'taskboard' || detail === 'ssh' || detail === 'mnemon') controller.close()
  }

  const onSidebarContextClick = (event: MouseEvent): void => {
    if (!controller.getSnapshot().open) return
    const target = event.target
    if (target instanceof Element && target.closest(SIDEBAR_CONTEXT_SELECTOR) !== null) controller.close()
  }

  document.addEventListener('click', onSidebarContextClick, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherPanelActivate)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onSidebarContextClick, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherPanelActivate)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ROUTER_ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}

/** Mount the sidebar row and its stateful center-column workspace as one unit. */
export function mountRouterWorkspace(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const controller = new RouterWorkspaceController()
  const disposeEntry = mountRouterSidebarEntry(controller)
  const disposePanel = mountPanel(controller)
  return () => {
    disposePanel()
    disposeEntry()
  }
}
