/**
 * 系统提示词**段落级**总控的纯逻辑与清单缓存 —— 把整体系统提示词拆成
 * 每一段（`harness:identity`、`tool:write`、`plan:policy` …），面板分组列出、
 * 逐段开关，关掉的段在装配时被过滤掉（`index.ts` 的 waterfall）。
 *
 * ════════════════════════════════════════════════════════════════════
 * 清单从哪来：`assemble()` 的真实产物，不写死宿主段名表
 * ════════════════════════════════════════════════════════════════════
 * 段名只有个别是宿主导出常量（`harness:identity`、`deployment:persona-*`），
 * 其余（`tool:*`、`mcp:*`、第三方插件段）都埋在各自插件里 —— 写死清单必然漂移。
 * 装配 waterfall（`system-prompt/assemble`）每轮都携带**全量已排序段落**，
 * 顺路缓存一份就是面板的事实源；apply 时预热一次 assemble，没开始对话也有清单。
 *
 * ⚠️ 清单是**最近一次装配的快照**（近似）：`assemble()` 不带 scope 时只含
 * global 段，真实对话是 agent scope；且多会话并发时缓存归"最后一次装配"。
 * 面板展示可接受，**开关判定不受影响** —— 过滤按段名，名字缺席时无害跳过。
 *
 * ════════════════════════════════════════════════════════════════════
 * 开关的生效面：waterfall 删段，不碰别人的注册
 * ════════════════════════════════════════════════════════════════════
 * 宿主没有"禁用别人的段"的 API。两条路里选了 waterfall：`assemble()` 的
 * 监听器返回值是权威结果（宿主源码 `return transformed`，complete 段除外），
 * 删掉的段不会被恢复。同名覆盖（scoped section 返回 `''`）只适合"顶掉某一个
 * 已知名字"，对同层自己注册的段还会 throw —— 删段才是对全部段通用的开关。
 */
import type { PromptExtData } from './render.ts'

/** 面板控制条 id 的段前缀（**传输层编码**；落盘用裸段名，不带前缀）。 */
export const SECTION_CONTROL_PREFIX = 'sec:'

/**
 * 自己的准则段：**不进清单、不被过滤**。
 *
 * 它已有独立的开关体系（扩展总开关 + 14 个分类开关）——再列一条"段开关"
 * 就是同一件事的第二个开关，两边状态会漂移；过滤它还会让分类开关看起来
 * 失效（段没了，分类怎么切都看不到效果）。
 */
export const OWN_SECTION_NAME = 'dsh-router-ext-prompt:guideline'

/**
 * 段名前缀 → 面板分组名。**未知前缀原样当组名**（不硬编全部前缀）：
 * 宿主还会加新段（`web:`、`structured:`…），映射漏了顶多组名不雅，
 * 条目照常列出照常开关 —— 映射表漂移不允许变成"段消失"。
 */
const GROUP_LABELS: Record<string, string> = {
  harness: '开场身份',
  deployment: '部署人设',
  plan: '计划模式',
  team: '团队',
  tool: '工具说明',
  mcp: 'MCP 服务',
  context: '运行上下文',
  ui: '界面与交付',
}

/** 一条已装配的段（面板清单用）。 */
export interface SectionEntry {
  /** 段注册名（稳定；也是开关的落盘键）。 */
  name: string
  /** 面板副行显示的原文（装配时 provider 现算的结果，**未做 `{{变量}}` 插值**）。 */
  text: string
}

/** `controlId`（`sec:…`）→ 段名；非段条目返回 null。 */
export function sectionNameOf(controlId: string): string | null {
  return controlId.startsWith(SECTION_CONTROL_PREFIX) ? controlId.slice(SECTION_CONTROL_PREFIX.length) : null
}

/** 段名 → 面板控制条 id。 */
export function sectionControlId(name: string): string {
  return SECTION_CONTROL_PREFIX + name
}

/**
 * 段名的分组名。
 *
 * 前缀是段命名的既成事实（`tool:bash`、`plan:policy`）；同时认**无冒号的整名**
 * （`mcp-resource-servers` 这种宿主段没有冒号，按整名查映射表）。
 * 两级都查不到 ⇒ 有冒号用前缀当组名、无冒号归「其他」—— 映射表漏了顶多
 * 组名不雅，条目照常列出、照常开关。
 */
export function groupLabelOf(name: string): string {
  const i = name.indexOf(':')
  const head = i >= 0 ? name.slice(0, i) : name
  return GROUP_LABELS[head] ?? (i >= 0 ? head : '其他')
}

/** 面板条目标题：去掉组前缀的部分（`tool:write` → `write`；无冒号 = 全名）。 */
export function sectionTitleOf(name: string): string {
  const i = name.indexOf(':')
  return i >= 0 ? name.slice(i + 1) : name
}

/**
 * 当前被关掉的段名集合。**只认显式 `false`** —— 缺项是"没碰过"（默认开），
 * 与 `resolveEnabledCategories` 对 `undefined` 的处置同一纪律。
 */
export function disabledSectionNames(data: PromptExtData | undefined): Set<string> {
  const out = new Set<string>()
  const saved = data?.sections
  if (!saved) return out
  for (const [name, on] of Object.entries(saved)) if (on === false) out.add(name)
  return out
}

/**
 * 过滤掉关闭的段（保序）。自己那段**恒放行**（理由见 `OWN_SECTION_NAME`）。
 *
 * ⚠️ 名字不在清单里的关闭项静默跳过：宿主段随版本增删，旧数据里的名字
 * 失效是正常生命周期，报错只会把面板变成红字噪音。
 */
export function filterSections<T extends { name: string }>(sections: readonly T[], off: ReadonlySet<string>): T[] {
  // ⚠️ 条件是 `===` **或** 没被关 —— 我第一版写成 `!== OWN && !off.has(...)`，
  //   把"是自己的段"当成了排除条件：结果是**准则段每次都被删掉**，而
  //   tool:write 这些反倒留着。方向写反不会抛错，只会让面板看起来全开、
  //   prompt 里准则凭空消失（本条判据就是靠两个方向同时断言抓出来的）。
  return sections.filter((s) => s.name === OWN_SECTION_NAME || !off.has(s.name))
}

/**
 * 段清单缓存：waterfall 监听器是**唯一写入者**（装配路径顺路喂），
 * 面板 controls getter 只读。分组与排序都在读取端做 —— 缓存保持
 * 装配原序（`assemble` 已按 order/name 排好），组的次序自然等于 prompt 次序。
 */
export function createSectionCache(): {
  /** 用一次装配结果刷新（整表替换；自己的段不进清单）。 */
  update: (sections: readonly { name: string; text: string }[]) => void
  /** 当前清单（拷贝，防调用方改缓存内部）。 */
  list: () => SectionEntry[]
} {
  let entries: SectionEntry[] = []
  return {
    update(sections) {
      entries = sections
        .filter((s) => s.name !== OWN_SECTION_NAME)
        .map((s) => ({ name: s.name, text: s.text }))
    },
    list() {
      return entries.map((e) => ({ ...e }))
    },
  }
}

/** 一个分组（组名 + 组内条目，组内保持清单序）。 */
export interface SectionGroup {
  label: string
  items: SectionEntry[]
}

/**
 * 按段名前缀分组；**组的先后 = 首次出现序**（清单已按 prompt 序 ⇒ 组序即
 * 段落在 prompt 里的先后）——不按字母重排，面板顺序与模型看到的顺序一致。
 */
export function groupSections(list: readonly SectionEntry[]): SectionGroup[] {
  const out: SectionGroup[] = []
  const byLabel = new Map<string, SectionGroup>()
  for (const item of list) {
    const label = groupLabelOf(item.name)
    let g = byLabel.get(label)
    if (!g) {
      g = { label, items: [] }
      byLabel.set(label, g)
      out.push(g)
    }
    g.items.push(item)
  }
  return out
}
