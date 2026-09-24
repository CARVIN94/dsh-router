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
import { RouterComponentsSection } from './RouterComponentsSection.tsx'
import { registerSettingsNavIcon } from './settings-nav-icon.ts'
import { rewriteRouterModelHint } from './model-hint-copy.ts'
import { LastHitDock } from './LastHitDock.tsx'
import { ROUTER_API_BASE } from '../shared.ts'
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

/**
 * 挂载输入框底部的「最近命中」徽章：注册到官方 `conversation.composer.dock`
 * （kind: list, scope: session —— 即宿主 composer 卡片底部操作行
 * `.uV2eYG_dock` 里、原生上下文环旁边的位置）。
 * scope 为 session 时宿主给组件注入 `sessionId`，据此按**当前会话**取命中。
 *
 * **仅宿主 >= 0.1.7 才挂**：composer.dock 这个座位在 0.1.5 也在，但渲染在
 * InputBar 之后的独立块（位置不对），只有 0.1.7 才放进底部操作行。座位名相同
 * 没法靠契约区分，故先问核心 `/router/api/health` 的 `lastHitDock` 支持位。
 * @returns 清理函数；不支持或宿主无 slots 时为空操作
 */
function mountLastHitDock(ctx: Ctx, supported: boolean): () => void {
  const slots = ctx.slots
  if (slots === undefined || !supported) return () => {}
  return slots.inject('conversation.composer.dock', () => slots.register({
    name: 'conversation.composer.dock',
    id: 'dsh-router-last-hit',
    order: 10,
  }, LastHitDock))
}

/**
 * 问核心是否支持「最近命中」徽章（宿主 >= 0.1.7）。
 * 网络/解析失败一律当**不支持**——宁可不显示，也不在 0.1.5 上摆错位置。
 */
async function fetchLastHitDockSupport(): Promise<boolean> {
  try {
    const res = await fetch(`${ROUTER_API_BASE}/health`)
    if (!res.ok) return false
    const body = (await res.json()) as { lastHitDock?: unknown }
    return body.lastHitDock === true
  } catch {
    return false
  }
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

/**
 * 官方插件页（设置 → 插件）里 dsh-router-core 详情页的「路由组件」一节。
 *
 * 为什么走 `plugins.detail.section` 而不是官方那个「包含的组件」：后者的行由
 * 宿主从**本 bundle 自己的 cordis.patch.yml** 算出来，跨 bundle 没有注入通道，
 * 而子插件（codebuddy / ext-rtk …）必须保持各自独立安装。官方给的位置就是这一
 * 个槽位（渲染在原生行列表之后）。槽位不存在的老宿主上 `inject` 不会触发，
 * 自动不挂——不引入硬 client inject。
 */
function mountComponentsSection(ctx: Ctx): (() => void) | undefined {
  const slots = ctx.slots
  if (slots === undefined) return undefined
  return slots.inject('plugins.detail.section', () => slots.register({
    name: 'plugins.detail.section',
    id: 'dsh-router-components',
    order: 10,
  }, RouterComponentsSection))
}

export function apply(ctx: Ctx): void {
  // 「最近命中」徽章：走官方 conversation.composer.dock（scope: session → 组件
  // props 注入 sessionId，按当前会话取命中）。**仅宿主 >= 0.1.7 才挂**——
  // composer.dock 在 0.1.5 渲染位置不对，先问核心拿支持位，避免摆错位置。
  // 查询是异步的，拿到结果（无论成败）再决定注册与否。
  void fetchLastHitDockSupport().then((supported) => {
    ctx.effect(() => mountLastHitDock(ctx, supported), 'dsh-router: last-hit dock')
  })
  const disposeSettings = mountSettingsSection(ctx)
  if (disposeSettings === undefined) {
    // 老宿主（无 slots）：回退到侧边栏入口 + 中心栏面板
    console.warn('[dsh-router] 宿主未提供 slots，回退到侧边栏面板')
    ctx.effect(() => mountRouterWorkspace(), 'dsh-router: routing system workspace')
    return
  }
  ctx.effect(() => disposeSettings, 'dsh-router: settings section')
  const disposeComponents = mountComponentsSection(ctx)
  if (disposeComponents !== undefined) {
    ctx.effect(() => disposeComponents, 'dsh-router: plugin page components')
  }
  // 换掉宿主的默认齿轮（契约没有 icon 字段，只能注册后认领自己的行）
  ctx.effect(() => registerSettingsNavIcon(SECTION_LABEL), 'dsh-router: settings nav icon')
  // 设置-模型 里 Router 卡片的那句死路提示 → 正确说法（同样只能认领后就地改写）
  ctx.effect(() => rewriteRouterModelHint(), 'dsh-router: models provider hint copy')
}
