/**
 * Client half of dsh-router.
 *
 * 挂载点是「设置 → 路由」（官方 `settings.section` 座位），不再是侧边栏
 * DOM 注入 + 中心栏劫持。`slots` / `locale` 由宿主运行时提供（profile 的
 * node_modules 里 @deepseek-ai 是空的：这些包不入 node_modules，按
 * package.json 的 dsh.client.inject 声明即可）。
 *
 * 拿不到 slots 时（老宿主）回退到原来的中心栏面板，不至于整个插件失效。
 */
import { mountRouterWorkspace } from './workspace-mount.tsx'
import { RouterSettingsSection } from './settings-section.tsx'
import { registerSettingsNavIcon } from './settings-nav-icon.ts'
import './router.css'

/**
 * 设置导航里这一页的显示名。同时是注册 label 和「认领图标」时匹配的文案，
 * 两处必须一致 —— 认领逻辑按可见文案找自己那一行（见 settings-nav-icon.ts）。
 */
const SECTION_LABEL = '路由'

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

/** 挂载「设置 → 路由」页；拿不到 slots 时返回 undefined 表示跳过。 */
function mountSettingsSection(ctx: Ctx): (() => void) | undefined {
  const slots = ctx.slots
  if (slots === undefined) return undefined
  // order 10 = 与「模型」「远程访问」同值，靠注册顺序定先后，实测排成
  //   模型 → 路由 → 远程访问（正是要的位置）。
  // 排序规则（宿主实现）：priority ?? 0 优先，再 order ?? 0，数值升序，
  //   同值保持注册顺序。所以想插在两个同 order 的条目中间是做不到的——
  //   试过 9.99（跑到模型上面）、10.001/10.05/11（都跑到远程访问后面）。
  //   只能取同值，让注册顺序决定。
  return slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'dsh-router',
    order: 10,
    label: SECTION_LABEL,
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
  // 换掉宿主的默认齿轮（契约没有 icon 字段，只能注册后认领自己的行）
  ctx.effect(() => registerSettingsNavIcon(SECTION_LABEL), 'dsh-router: settings nav icon')
}
