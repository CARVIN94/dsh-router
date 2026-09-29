/**
 * 分层提示词扩展（`router.ext` 侧）测试 —— 锁住四件事：
 *   1. 登记进 `router.ext` 表，带上可显示的身份（名字/说明/就绪）；
 *   2. **幂等**：同一个 id 已在表里就不顶掉别人的登记；
 *   3. `source: 'builtin'`（随核心分发 ⇒ 插件页的原生行，自绘节不重复列）；
 *   4. **准则段落真的挂上了** —— ext-test 没有这一条，本扩展多做执行面，必须验。
 *
 * 为什么第 4 条不可省：扩展的「卡片出现与否」取决于它在不在这张表里，而**准则
 * 有没有进 prompt** 取决于段落挂没挂 —— 两者是**不同的失效**，都静默且都不报错。
 * 只测登记会漏掉「卡片亮着、准则没进 prompt」这个最难查的情况。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPromptExt, EXT_PROMPT_ID } from './plugin.ts'
import { apply, name as CORDIS_NAME, inject as CORDIS_INJECT } from './index.ts'
import { PROMPT_SECTION_NAME } from './mount.ts'
import { PROMPT_CATEGORIES } from './content.ts'
import type { RouterExtService } from '../ext/contract.ts'

test('扩展器带上面板要用的身份', () => {
  const ext = createPromptExt({ isSystemPromptReady: () => true })
  assert.equal(ext.id, EXT_PROMPT_ID)
  assert.equal(ext.name, '分层提示词')
  assert.equal(ext.source, 'builtin', '随核心分发必须标 builtin，否则插件页会重复列它')
})

test('★ `description` 故意不设：详情页下面就是清单，再写一句是冗余', () => {
  // ⚠️ 这条断言换过一次**理由**（2026-09-29）：原来它写的是
  //   「没有说明，插件页那一行就没有副标题」——**那个前提是错的**。
  //   插件页「包含的组件」那一行的副标题来自 `locale/*.json`（宿主 readPluginMeta
  //   读的），**不是** `RouterExt.description`。所以那条断言在钉一个错误的事实。
  //
  //   真正要守的是：详情页已经逐条列出标题/开关/原文 ⇒ 上面的说明句是冗余，
  //   且写死 `${PROMPT_CATEGORIES.length}` 会与真实分类数漂移。
  //   `locale/*.json` 那条说明仍然必要（不开这一行，无从知道它是干什么的）——
  //   由下面那条用例单独守。
  const ext = createPromptExt({ isSystemPromptReady: () => true })
  assert.equal(ext.description, undefined, '详情页有了逐条清单，说明句就是重复事实')
})

test('★ 插件页那一行的说明仍然在（来自 locale，不是 description）', () => {
  // 「删 description」不等于「把说明也删了」：宿主读的是 locale 资源。
  // 只写 host 半边的话，这一行会**没有副标题** —— 而不打开就不知道它是干什么的。
  const locale = JSON.parse(
    readFileSync(new URL('./locale/zh.json', import.meta.url), 'utf8'),
  ) as { meta?: { title?: string; description?: string } }
  assert.ok((locale.meta?.title ?? '').length > 0, 'locale 缺 title')
  assert.ok((locale.meta?.description ?? '').length > 0, '插件页那一行没有副标题')
})

test('注入：systemPrompt 不可用 ⇒ 报 not ready（不能静默不生效）', () => {
  const ext = createPromptExt({ isSystemPromptReady: () => false })
  const st = ext.getState()
  assert.equal(st.ready, false, '无处注入却报就绪 = 卡片亮着、准则没进 prompt')
  assert.ok((st.detail ?? '').length > 0, '不报还不说原因 = 面板上无从判断')
})

test('cordis 身份与 patch 里声明的 id 逐字相同（否则 loader 认不出这一行）', () => {
  assert.equal(CORDIS_NAME, 'dsh-router-ext-prompt')
})

test('★ patch 里真的声明了这一行，且 id/name 逐字对得上', () => {
  // ⚠️ **必须真读 patch 文件**：只断言自己的常量的话，patch 写错了照样全绿
  //    —— 判据不碰被它守的东西，等于没守。
  //    症状会非常隐蔽：构建通过、测试通过、装上后插件页**没有这一行**。
  const patch = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
  const block = patch.match(
    new RegExp(`- id: ${CORDIS_NAME}\\s*\\n\\s*name: '([^']+)'(\\s*\\n\\s*(disabled:.*)?)?\\n`),
  )
  assert.ok(block, `cordis.patch.yml 里没有 id=${CORDIS_NAME} 的行`)
  assert.equal(block![1], 'dsh-router-core/ext-prompt', 'patch 的 name 必须是能解析的子路径说明符')
})

test('★ 那一行默认开启（用户 2026-09-29 拍板：装上就该有准则）', () => {
  // `disabled: true` = 行默认关 ⇒ loader 不 import ⇒ 卡片不出现。
  // 用户要求**默认开启**（准则是每次协作都要的基础设施，不是可选增强）。
  // 内置供应商的三行同样不带 disabled —— 保持一致。
  const patch = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
  const block = patch.match(
    new RegExp(`- id: ${CORDIS_NAME}[^]*?\\n(\\s*name: '([^']+)'\\n)([^\\n]*)`),
  )
  assert.ok(block, 'patch 里找不到这一行')
  assert.doesNotMatch(
    block![3] ?? '',
    /disabled:\s*true/,
    '这一行带 disabled: true ⇒ 装上后默认没有准则（与用户拍板相反）',
  )
})

test('分类表非空且 id 唯一（内容层塌了就等于扩展什么都不注入）', () => {
  assert.ok(PROMPT_CATEGORIES.length > 0)
  const ids = PROMPT_CATEGORIES.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('★ 扩展自报子开关：每条分类一项，且状态取自已保存的选择', () => {
  const data = { categories: { identity: false, structure: false } }
  const ext = createPromptExt({ isSystemPromptReady: () => true, store: fakeStore(data) })
  const controls = ext.controls ?? []
  assert.equal(controls.length, PROMPT_CATEGORIES.length, '每条分类都要在面板上可见')
  const byId = new Map(controls.map((c) => [c.id, c]))
  assert.equal(byId.get('identity')?.on, false, '用户关掉的必须在面板显示为关')
  assert.equal(byId.get('structure')?.on, false)
  assert.equal(byId.get('ladder')?.on, true, '没碰过的走 defaultOn')
  for (const c of controls) assert.ok(c.title.length > 0, `${c.id} 没有显示名`)
})

test('★ 注入：面板点一下 ⇒ 落盘只改那一个键，data 抽屉里别的字段不丢', () => {
  const store = fakeStore({ categories: { identity: true }, other: 'keep-me' })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  assert.equal(ext.setControl?.('identity', false), true)
  const after = store.readData<Record<string, unknown>>('')
  assert.deepEqual(after?.categories, { identity: false })
  assert.equal(after?.other, 'keep-me', '整块重写把 data 抽屉里别的字段抹了')
})

test('注入：未知 controlId ⇒ 返回 false（核心据此回 400，不写盘）', () => {
  const store = fakeStore({ categories: { identity: true } })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  assert.equal(ext.setControl?.('__evil__', true), false)
  assert.deepEqual(store.readData<Record<string, unknown>>('')?.categories, { identity: true }, '失败的写入不该留下任何痕迹')
})

test('注入：没有 data 块时 setControl 返回 false（而不是新建一个空块）', () => {
  const ext = createPromptExt({ isSystemPromptReady: () => true, store: fakeStore(undefined) })
  assert.equal(ext.setControl?.('identity', false), false,
    '没有已存数据就写 ⇒ 会把用户的其它 data 覆盖掉')
})

/**
 * 假 store：**整块替换**语义。
 *
 * ⚠️ 这一点是判据能不能抓住违规的关键（2026-09-29 实测踩过）：我第一版用
 * `Object.assign(data, value)` —— **合并**。而真实的 `ExtStore.writeData` 是
 * `this.byId[id] = { …, data: value }`，**整块替换**。
 * 合并的假实现让「只改一个键」与「整块重写」**观测上完全一样** ⇒
 * 注入「整块重写」时测试照样全绿。判据被自己的替身骗了。
 */
function fakeStore(initial: Record<string, unknown> | undefined) {
  const box = { data: initial }
  return {
    isEnabled: () => true,
    setEnabled: () => {},
    readData: <T,>(_id: string) => box.data as T | undefined,
    writeData: (_id: string, value: unknown) => { box.data = value as Record<string, unknown> },
  } as unknown as import('../ext/contract.ts').ExtStoreService
}

test('★ 每个子开关都带原文（不给出就是在盲切：只看名字没法判断该不该关）', () => {
  const ext = createPromptExt({ isSystemPromptReady: () => true, store: fakeStore({ categories: {} }) })
  for (const c of ext.controls ?? []) {
    assert.ok(typeof c.body === 'string' && c.body.length > 0, `${c.id} 没有原文`)
    // 原文必须是这一条**自己的**正文，不是标题、也不是全集
    const cat = PROMPT_CATEGORIES.find((x) => x.id === c.id)
    assert.equal(c.body, cat?.body, `${c.id} 的原文与内容层不一致`)
  }
})

test('★ 声明了 inject 数组：apply 要在 service 就绪之后才被调用', () => {
  // ⚠️⚠️ **这条是整个扩展曾经失效的那一处**（2026-09-29 实测修的 bug）：
  //   原实现是「在 apply 里 `ctx.inject([\'systemPrompt\'], cb)`」。本机 cordis 4.0.4
  //   实测（本机 cordis 4.0.4）：`ctx.inject(deps, cb)` 的回调**不是同步触发**
  //   （要等下一个异步点），而 apply 是**同步函数** ⇒ 返回时回调还没发生，
  //   真实加载路径不保证之后还有机会去等它 ⇒ **准则一次都没进过 prompt**。
  //
  //   ⚠️ 我第一版把机制写成「要等 ctx.start()」——**那是错的**，`start` 不在
  //   Context 的公开面上。结论不依赖这个细节。
  //
  //   症状极具迷惑性：面板一切正常（卡片、14 条 controls、开关、原文全在），
  //   只有模型看不到 —— 因为面板读的是 `router.ext` 表，prompt 读的是
  //   `ctx.systemPrompt`，**两条路完全独立**。
  //
  //   正解：导出 `inject` 数组，cordis 据此把整个 apply **推迟**到 service 就绪后
  //   （对照 `dsh-client-ui-deliverables` 等真实使用者）。
  assert.ok(Array.isArray(CORDIS_INJECT), '没有导出 inject 数组')
  assert.ok(CORDIS_INJECT.includes('systemPrompt'),
    'inject 里必须列 systemPrompt —— 否则 apply 跑在它就绪之前，section 挂不上')
  assert.ok(CORDIS_INJECT.includes('router.ext'), 'inject 里必须列 router.ext')
})

test('★ 真 cordis 上：apply 之后 section 真的挂上了（不只面板那半）', async () => {
  // ⚠️ 用**真 cordis Context**，不是假 ctx。假 ctx 会**立即**回调
  //   `ctx.inject(deps, cb)` —— 恰好把真正的 bug 掩盖掉。
  //   这条判据就是为了不再被那种替身骗。
  const { Context } = await import('@deepseek-ai/cordis')
  const sections: { name: string; text: string | (() => string) }[] = []
  const table: RouterExtService = {}
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    section: (s: { name: string; text: string | (() => string) }) => { sections.push(s); return () => {} },
    getSectionOrder: () => 100,
  })
  ctx.provide('router.ext', table)
  ctx.provide('router.extStore', {
    isEnabled: () => true, setEnabled: () => {}, readData: () => undefined, writeData: () => {},
  })
  apply(ctx as unknown as Parameters<typeof apply>[0])
  assert.equal(sections.length, 1, '准则段落没挂上 ⇒ 模型看不到准则（面板却一切正常）')
  const text = (sections[0]!.text as () => string)()
  assert.ok(text.includes('懒人梯子'), '挂上了但内容不对')
})
/**
 * 真 cordis 夹具 —— **不用假 ctx**（2026-09-29 换掉）。
 *
 * ⚠️ 上一版的假 ctx `inject` 会**立即**回调 apply 里注册的回调。那恰好把真正的
 *   bug 掩盖掉了：`ctx.inject(deps, cb)` 对已就绪的 service 其实要等
 *   `ctx.start()` 之后才回调，所以旧实现里准则一次都没挂上，而假 ctx 全绿。
 *   ⇒ 判据的替身比被守的东西更宽容 = 判据无效。
 *   真 cordis 会如实复现时序（本机 4.0.4 实测：provide 后 inject 不触发，
 *   start() 之后才触发）。
 */
async function realCtx(opts: { enabled?: boolean; data?: unknown } = {}) {
  const { Context } = await import('@deepseek-ai/cordis')
  const table: RouterExtService = {}
  const sections: { name: string; order: number; text: string | (() => string) }[] = []
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    section: (s: { name: string; order: number; text: string | (() => string) }) => {
      sections.push(s)
      return () => {}
    },
    getSectionOrder: () => 100,
  })
  ctx.provide('router.ext', table)
  ctx.provide('router.extStore', {
    isEnabled: () => opts.enabled ?? true,
    setEnabled: () => {},
    readData: () => opts.data,
    writeData: () => {},
  })
  return { ctx, table, sections }
}

test('apply 把扩展登记进 router.ext 表（这张表就是「卡片出现」的唯一依据）', async () => {
  const { ctx, table } = await realCtx()
  apply(ctx as unknown as Parameters<typeof apply>[0])
  assert.equal(table[EXT_PROMPT_ID]?.name, '分层提示词')
})

test('幂等：同一个 id 已在表里时不顶掉别人的登记', async () => {
  const { ctx, table } = await realCtx()
  apply(ctx as unknown as Parameters<typeof apply>[0])
  const first = table[EXT_PROMPT_ID]
  apply(ctx as unknown as Parameters<typeof apply>[0])
  assert.equal(table[EXT_PROMPT_ID], first, '重复登记不该换成一个新对象')
})

test('★ apply 把准则挂成了 system prompt 段落（ext-test 没这层，必须单独验）', async () => {
  const { ctx, sections } = await realCtx()
  apply(ctx as unknown as Parameters<typeof apply>[0])
  assert.equal(sections.length, 1, '准则没挂上 = 卡片亮着但 prompt 里没有准则')
  assert.equal(sections[0]!.name, PROMPT_SECTION_NAME)
  assert.equal(typeof sections[0]!.text, 'function', '静态文本 ⇒ 分类开关永远不生效')
})

test('注入：总开关关时段落文本为空（平台据此丢弃该段）', async () => {
  const { ctx, sections } = await realCtx({ enabled: false })
  apply(ctx as unknown as Parameters<typeof apply>[0])
  const text = (sections[0]!.text as () => string)()
  assert.equal(text, '', '总开关关时必须返回空串，而不是注入一段空白')
})

test('注入：用户关掉某分类 ⇒ 该分类不进 prompt（可开关的正向判据）', async () => {
  const { ctx, sections } = await realCtx({ enabled: true, data: { categories: { identity: false } } })
  apply(ctx as unknown as Parameters<typeof apply>[0])
  const text = (sections[0]!.text as () => string)()
  assert.equal(text.includes('大肥鱼'), false, 'identity 关了就不该出现')
  assert.ok(text.includes('视野'), '其他分类照常')
})
