/**
 * Client half of dsh-router.
 *
 * 挂载点是「设置 → 路由系统」（官方 `settings.section` 座位），不再是侧边栏
 * DOM 注入 + 中心栏劫持。`slots` / `locale` 由宿主运行时提供（profile 的
 * node_modules 里 @deepseek-ai 是空的：这些包不入 node_modules，按
 * package.json 的 dsh.client.inject 声明即可）。
 *
 * 拿不到 slots 时（老宿主）回退到原来的中心栏面板，不至于整个插件失效。
 */
import { mountRouterWorkspace } from './workspace-mount.tsx'
import { RouterSettingsSection } from './settings-section.tsx'
import './router.css'

/**
 * 必须声明：Cordis 的 ctx 是 Proxy，未声明就访问 `ctx.slots` 会直接抛
 * `cannot get property "slots" without inject`（实测错误，不是理论风险）——
 * 连 `ctx.slots === undefined` 这种防御性判断都跑不到，getter 先炸。
 */
export const inject: string[] = ['slots']

interface SlotsFace {
  inject: (key: string, cb: () => unknown) => () => void
  register: (reg: Record<string, unknown>, component: unknown) => unknown
}

interface Ctx {
  slots?: SlotsFace
  effect: (fn: () => (() => void) | void, label?: string) => void
}

/** 挂载「设置 → 路由系统」页；拿不到 slots 时返回 undefined 表示跳过。 */
function mountSettingsSection(ctx: Ctx): (() => void) | undefined {
  const slots = ctx.slots
  if (slots === undefined) return undefined
  return slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'dsh-router',
    order: 60,
    label: '路由系统',
  }, RouterSettingsSection))
}

export function apply(ctx: Ctx): void {
  const disposeSettings = mountSettingsSection(ctx)
  if (disposeSettings === undefined) {
    // 老宿主（无 slots）：回退到侧边栏入口 + 中心栏面板
    console.warn('[dsh-router] 宿主未提供 slots，回退到侧边栏面板')
    ctx.effect(() => mountRouterWorkspace(), 'dsh-router: routing system workspace')
    return
  }
  ctx.effect(() => disposeSettings, 'dsh-router: settings section')
}
