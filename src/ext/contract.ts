/**
 * 扩展 (Ext) 通用契约 —— dsh-router 的「扩展插件」扩展点（不是供应商）。
 *
 * 分工（2026-09 重构：核心只做管理，不做拦截）：
 *   - **dsh-router 核心 = 管理面**：持有 `router.ext` 注册表（发现）、渲染面板与
 *     `/router/api/ext`（展示）、代存开关与插件数据（`router.extStore` →
 *     `<dataDir>/ext.json`）。核心**不挂 `tools/execute`、不裁决、不改写**。
 *   - **扩展插件 = 执行面**：自己挂监听、自己问 `isEnabled`、自己按 ready 裁决、
 *     自己短路执行。怎么改一条命令是插件的**私事**，不在本契约里。
 *
 * 为什么把拦截从核心挪走：
 *   `tools/execute` 是任何插件都能自己挂的 around-dispatch waterfall（插件 ctx 不在
 *   agent scope 下就能收到全部派发）。核心代挂只在一个消费者（rtk）时是纯亏损：为留
 *   40 行委派逻辑，付了共享表 + inject 广播 + 契约两处同步的代价。核心归位成管理面
 *   后，扩展插件与 dsh-router 只在**注册表 + 存储**两处耦合。
 *
 * ponytail: 天花板 —— 核心代挂原本顺带解决「多个扩展插件各自挂监听会互相踩 / 顺序
 *   不可控」。这个保护现在没了；目前只有 rtk 一家消费，无所谓。**第二家 ext 出现时
 *   要重新收敛顺序**（升级路径：核心暴露一个按顺序委派的共享工具方法，而不是收回拦截）。
 *
 * 契约要点：
 *   - 扩展器只有**声明**（id / name / description）+ `getState()`；核心拿这些渲染面板。
 *   - `getState()` 只报**运行时事实**（ready 是否可用、detail 说明），不报开关。
 *   - **开关与数据归核心持久化**（`router.extStore` → `<dataDir>/ext.json`），插件不自己
 *     file IO —— 落盘位置由核心锚定（不跟 cwd 跑），读写经核心，插件无状态。
 */
import type { Context } from '@deepseek-ai/cordis'

/** 扩展器唯一 id（注册键）。 */
export type ExtId = string

/**
 * 扩展器当前状态（**运行时事实**，由插件现算，不持久化）。
 *
 * 注意：`enabled` 不在这里 —— 开关状态归核心持久化（`<dataDir>/ext.json`），
 * 插件只负责做事 + 报自己是否可用。核心把两者合并后再给面板用。
 */
export interface ExtState {
  /** 运行时是否就绪（如 RTK 二进制是否可用）；false 时即使开启也不生效。 */
  ready: boolean
  /** 不就绪时的一句话说明（如「本机未装 rtk」），面板红字显示。 */
  detail?: string
}

/**
 * 注册到 `router.ext` 表的扩展器实现。核心（面板/API）只认这几个成员，
 * 插件可以携带更多内部状态。
 */
export interface RouterExt {
  /** 扩展器 id，也是 `router.ext` 表里的注册键。 */
  readonly id: ExtId
  /** 面板显示名（如「RTK」）。 */
  readonly name: string
  /** 面板副标题说明。 */
  readonly description?: string
  /** 卡片/详情图标的 logo URL（可选；缺省用默认图标）。 */
  readonly icon?: string
  /**
   * 这个扩展是**随核心分发**（`builtin`）还是**独立安装的插件**（不标 = plugin）。
   *
   * 为什么需要这个标记：随核心分发的扩展同时是插件页原生「包含的组件」里的**一行**
   * （自带宿主管的开关），独立安装的扩展是各自 bundle 的行。插件页那个自绘的
   * 「路由组件」节只该列后者 —— 与内置供应商的处理完全一样：已经有原生行的东西，
   * 再在下面列一遍就是同一个东西显示两处。
   */
  readonly source?: 'builtin'
  /**
   * 扩展自带的**子开关**（可选；不声明 = 只有总开关）。
   *
   * 为什么需要：有些扩展的「开/关」不是一件事而是**几件独立的事** —— 例如分层
   * 提示词有 14 个准则分类，每条都该能单独关。硬塞进一个总开关 = 要么全给、
   * 要么全不给。
   *
   * ⚠️ **与总开关的关系**：子开关是**叠加**在总开关之上的，总开关关 ⇒ 全部子开关
   *   一起失效（但**不清零**用户的子开关选择）。详情页在总开关关时把它们显示为
   *   禁用而不是隐藏 —— 隐藏会让用户以为它们不存在。
   *
   * ⚠️ **值存哪**：核心**不认识**这些子开关的语义，只负责搬运。落盘一律走
   *   `ExtStoreService.writeData`（`data` 抽屉），由扩展自己读回。核心不替扩展
   *   存一份 —— 那样会变成两份可能漂移的真相。
   */
  readonly controls?: ExtControl[]
  /**
   * 改一个子开关（面板调用；可选 —— 没有 `controls` 就不需要）。
   *
   * ⚠️ **为什么由扩展自己写、核心不代劳**：子开关的落盘形状归扩展所有
   *   （本仓是 `data.categories[id]`），核心一旦代写就得认识那个形状 ——
   *   换个扩展就是换个形状，核心会变成「认识所有扩展的私有数据格式」的地方。
   *   核心只负责：把 `{ controlId, on }` 递进来，并把**成功/失败**如实回给面板。
   *
   * @param controlId - 要改的子开关 id。
   * @param on - 目标状态。
   * @returns 落盘结果。返回 false 时核心回 400，且**不写盘**。
   */
  setControl?(controlId: string, on: boolean): boolean
  /** 当前运行时状态（ready + 不就绪时的说明）。 */
  getState(): ExtState
  /** 卸载清理（表删除时由 dsh-router 调用，可选）。 */
  dispose?(): void
}

/**
 * 一个可独立开关的子项（如准则的某一条）。
 *
 * ⚠️ `id` 是**持久化键**（落进 `data` 抽屉），**改名会让用户已保存的选择丢失**。
 */
export interface ExtControl {
  /** 稳定 id（持久化键）。 */
  readonly id: string
  /** 面板显示名。 */
  readonly title: string
  /** 当前是否开启（扩展自算：默认值 + 用户已存的选择）。 */
  readonly on: boolean
  /** 一句话说明这一条管什么（面板副行，可选）。 */
  readonly detail?: string
  /**
   * 这一条的**原文**（可选）—— 面板点开即可读到。
   *
   * 为什么值得加：不给出原文的话，用户是在**盲切** —— 只看到「结构」「交付」
   * 这样的名字，不知道它到底写了什么，也无从判断该不该关掉这一条。给出原文
   * ⇒「看内容 → 决定开关」这个动作才成立。
   */
  readonly body?: string
}

/** 面板/API 用的一条扩展器信息 = 核心存的开关 + 插件报的运行时事实。 */
export interface ExtInfo {
  id: string
  name: string
  description?: string
  /** 卡片/详情图标 logo URL（可选）。 */
  icon?: string
  /** 核心持久化的开关（默认关）。 */
  enabled: boolean
  /** 插件报的运行时就绪状态。 */
  ready: boolean
  /** 不就绪时的说明（面板红字）。 */
  detail?: string
}

/** `router.ext` 共享聚合表：`{ [extId]: RouterExt }`（同一 live 对象可追加）。 */
export interface RouterExtService {
  [extId: string]: RouterExt
}

/**
 * 扩展的存储面（核心 provide，插件 inject）。
 *
 * 插件**不自己 file IO**：落盘位置由核心用 `dataDirOf(ctx.baseUrl)` 锚定（不跟
 * process.cwd() 跑），读写都经核心，同一文件、同一次原子写。
 *
 * 落盘形状：`<dataDir>/ext.json` = `{ "<id>": { "enabled": boolean, "data": unknown } }`
 */
export interface ExtStoreService {
  /** 是否开启（未记录过 = 默认关）。 */
  isEnabled(id: string): boolean
  /** 置开关（面板/API 调）。 */
  setEnabled(id: string, enabled: boolean): void
  /** 读插件自己的数据块（没有 = undefined）。 */
  readData<T = unknown>(id: string): T | undefined
  /** 写插件自己的数据块（覆盖；与 enabled 同文件原子落盘）。 */
  writeData(id: string, value: unknown): void
}

/** 读取当前 router.ext 表（同一 live 对象，可追加）——扩展插件用它注册自己。 */
export function currentExts(ctx: Context): RouterExtService | undefined {
  const c = ctx as unknown as {
    get?: (key: string) => unknown
    router?: { ext?: RouterExtService }
  }
  return (c.get?.('router.ext') ?? c.router?.ext) as RouterExtService | undefined
}

/** 读取扩展存储服务——扩展插件用它读开关、读写自己存的数据。 */
export function currentExtStore(ctx: Context): ExtStoreService | undefined {
  const c = ctx as unknown as {
    get?: (key: string) => unknown
    router?: { extStore?: ExtStoreService }
  }
  return (c.get?.('router.extStore') ?? c.router?.extStore) as ExtStoreService | undefined
}
