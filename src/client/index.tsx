/**
 * Client half of dsh-router: mounts the 路由系统 sidebar entry and its
 * center-column panel. Pure DOM + fetch — no injected DSH services needed:
 * the panel reads /router/api/* (same-origin), which the host half serves.
 */
import { mountRouterWorkspace } from './workspace-mount.tsx'
import './router.css'

/** No hard service dependencies; the web shell injects react/cordis. */
export const inject: string[] = []

/** Mount the routing-system workspace once the browser context is ready. */
export function apply(ctx: { effect: (fn: () => () => void, label?: string) => void }): void {
  ctx.effect(
    () => mountRouterWorkspace(),
    'dsh-router: routing system workspace',
  )
}
