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
import { PROMPT_CATEGORIES, PROMPT_TITLE } from './content.ts'
import type { RouterExtService } from '../ext/contract.ts'

test('扩展器带上面板要用的身份', () => {
  const ext = createPromptExt({ isSystemPromptReady: () => true })
  assert.equal(ext.id, EXT_PROMPT_ID)
  assert.equal(ext.name, '分层提示词')
  assert.equal(ext.source, 'builtin', '随核心分发必须标 builtin，否则插件页会重复列它')
})

test('★ `description` 是整段标题（不是自我介绍，也不内插分类数）', () => {
  // ⚠️ 这条断言**换了两次内容**，值得留档（2026-09-29）：
  //   ① 最初写的是「没有说明，插件页那一行就没有副标题」——**前提是错的**，
  //      那一行的副标题来自 `locale/*.json`，与 `description` 无关；
  //   ② 改成「`description` 必须是 undefined」（当时用户嫌「拆成 14 个分类」冗余）；
  //   ③ 现在又要求**顶部显示标题** ⇒ 改成「等于 PROMPT_TITLE」。
  //   两次反复的共同教训：**默认值/文案该是什么由用户拍板，判据只负责让改动可见**，
  //   所以断言跟着改、并在注释里留着反复，免得下一个人以为是"又改坏了"。
  const ext = createPromptExt({ isSystemPromptReady: () => true })
  assert.equal(ext.description, PROMPT_TITLE, '详情页顶部要显示的就是整段标题')
  // ⚠️ 尤其**不许**内插 `${PROMPT_CATEGORIES.length}`：加减分类后文案不跟着变，
  //   就是同一件事的两个来源（「反查重复」）。
  assert.doesNotMatch(String(ext.description), /\d+\s*个/,
    'description 里内插了分类数量 ⇒ 加减分类后会与真实数量漂移')
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

test('★ 那一行默认关闭（与 ext-test 同款）', () => {
  // `disabled: true` = 行默认关 ⇒ loader 不 import ⇒ 扩展不进 `router.ext` 表 ⇒
  // 卡片不出现、准则不进 prompt。
  //
  // ⚠️ **这里来回改过一次**（2026-09-29）：先按"准则是基础设施"改成默认开启，
  //   又改回默认关闭。**用户对默认值的取舍优先于我的判断** —— 判据跟着改，
  //   不是反过来。注释里留着这次反复，是为了让下一个人知道它**曾经**是默认开、
  //   以及为什么现在不是（不是"忘了改回来"）。
  const patch = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
  const block = patch.match(
    new RegExp(`- id: ${CORDIS_NAME}[^]*?\\n(\\s*name: '([^']+)'\\n([^\\n]*))`),
  )
  assert.ok(block, 'patch 里找不到这一行')
  assert.match(block![3] ?? '', /disabled:\s*true/,
    '这一行不带 disabled: true ⇒ 装上就自动注入准则（与用户当前拍板相反）')
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

// ── 面板编辑文本（2026-09-29）────────────────────────────────
test('★ 每条都标 editable，面板才知道该不该给「修改」按钮', () => {
  const ext = createPromptExt({ isSystemPromptReady: () => true, store: fakeStore({ categories: {} }) })
  for (const c of ext.controls ?? []) assert.equal(c.editable, true, `${c.id} 没标 editable`)
  assert.equal(typeof ext.setControlText, 'function', '没有 setControlText ⇒ 面板点了必然 400')
})

test('★ 编辑后 controls 立刻反映新标题/新正文（每次读都重算）', () => {
  const store = fakeStore({ categories: {}, text: { identity: { title: '我是谁', body: '我是一个测试。' } } })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  const c = (ext.controls ?? []).find((x) => x.id === 'identity')!
  assert.equal(c.title, '我是谁')
  assert.equal(c.body, '我是一个测试。')
})

test('★ controls 不是快照：改完之后**再读一次**要看到新值', () => {
  // ⚠️ 2026-09-29 实测踩的 bug：`controls: CATEGORIES.map(...)` 那个 map 在
  //   `createPromptExt()` 时就跑完了 ⇒ 编辑落盘后 prompt 变了、**面板拿到的还是
  //   旧标题**（用户看到"保存了又变回去"）。而我当时注释写着"现算不缓存"。
  //   ⇒ 判据必须**跨两次读**才抓得住（只读一次的写法抓不到）。
  const store = fakeStore({ categories: {} })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  const before = (ext.controls ?? []).find((x) => x.id === 'ladder')!
  assert.equal(before.title, '懒人梯子')
  ext.setControlText?.('ladder', { title: '我的梯子' })
  const after = (ext.controls ?? []).find((x) => x.id === 'ladder')!
  assert.equal(after.title, '我的梯子', 'controls 是快照 ⇒ 面板刷新后编辑内容会「变回去」')
})

test('setControlText 只写覆盖值，且不碰 categories（同块的另一种数据）', () => {
  const store = fakeStore({ categories: { identity: false }, keep: 'me' })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  assert.equal(ext.setControlText?.('identity', { title: '新标题' }), true)
  const after = store.readData<Record<string, unknown>>('')
  assert.deepEqual(after?.categories, { identity: false }, '改标题把开关状态冲掉了')
  assert.equal(after?.keep, 'me', '把 data 抽屉里别的字段抹了')
  assert.deepEqual(after?.text, { identity: { title: '新标题' } }, '只该存改过的字段')
})

test('★ 改一条**不碰其它条**的覆盖（整块重写 text 会静默丢别人的）', () => {
  // ⚠️ 注入验证过：`text: { [id]: patch }` 这种写法**全绿** —— 它的破坏
  //   只在"用户改过两条以上"时显形，而单人单条测试看不出来。
  const store = fakeStore({
    categories: {},
    text: { identity: { title: 'A' }, scope: { body: 'B' } },
  })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  ext.setControlText?.('ladder', { body: '新内容' })
  assert.deepEqual(store.readData<Record<string, unknown>>('')?.text, {
    identity: { title: 'A' },
    scope: { body: 'B' },
    ladder: { body: '新内容' },
  }, '改一条把别人覆盖的抹了')
})

test('改同一条的第二个字段 ⇒ 第一个字段仍在（部分更新，不是替换）', () => {
  const store = fakeStore({ categories: {}, text: { identity: { title: 'A' } } })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  ext.setControlText?.('identity', { body: 'B' })
  assert.deepEqual(store.readData<Record<string, unknown>>('')?.text, {
    identity: { title: 'A', body: 'B' },
  })
})

test('注入：空标题/空正文返回 false（不写盘）', () => {
  const store = fakeStore({ categories: {} })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  for (const bad of [{ title: '  ' }, { title: '' }, { body: '' }]) {
    assert.equal(ext.setControlText?.('identity', bad), false, `空串被接受了：${JSON.stringify(bad)}`)
  }
  assert.equal(store.readData<Record<string, unknown>>('')?.text, undefined, '失败的写入留下了痕迹')
})

test('注入：未知 controlId 返回 false', () => {
  const store = fakeStore({ categories: {} })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  assert.equal(ext.setControlText?.('__evil__', { title: 'x' }), false)
})

/**
 * 假 store：**整块替换**语义，与真实的 `ExtStore.writeData` 一致
 * （`this.byId[id] = { …, data: value }`）。合并的替身会让「只改一个键」与
 * 「整块重写」观测上完全一样 ⇒ 注入违规时测试照样全绿（2026-09-29 栽过）。
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

// ── 排序 / 自建 / 还原 / 删除（2026-09-29）──────────────────
test('★ controls 走合成列表：自建条目出现、标 custom、内置标 overridden', () => {
  const store = fakeStore({
    categories: {},
    custom: [{ id: 'cu-1', title: '我的', defaultOn: true, body: 'B' }],
    text: { ladder: { body: '改过的' } },
  })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  const list = ext.controls ?? []
  assert.equal(list.length, PROMPT_CATEGORIES.length + 1, '自建条目没出现')
  assert.equal(list.find((c) => c.id === 'cu-1')?.custom, true)
  assert.equal(list.find((c) => c.id === 'ladder')?.overridden, true, '改过的内置条目要标 overridden（还原按钮可点）')
  assert.equal(list.find((c) => c.id === 'identity')?.overridden, false, '没改过的不该标（还原按钮置灰）')
})

test('★ 新增自建条目 ⇒ 返回新 id，且落盘（id 不撞内置）', () => {
  const store = fakeStore({ categories: {} })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  const id = ext.addCustomControl?.('我的准则', '做完了就收。')
  assert.ok(id !== null && typeof id === 'string', '没返回新 id')
  assert.notEqual(id, 'identity', '新 id 撞上了内置条目')
  assert.equal((ext.controls ?? []).some((c) => c.id === id), true, '落盘后没出现在 controls 里')
})

test('注入：空标题/空正文新增 ⇒ 返回 null（不写盘）', () => {
  const store = fakeStore({ categories: {} })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  assert.equal(ext.addCustomControl?.('  ', 'x'), null)
  assert.equal(ext.addCustomControl?.('x', ''), null)
  assert.equal(store.readData<Record<string, unknown>>('')?.custom, undefined, '失败的写入留下痕迹')
})

test('★ 删除只允许自定义：内置条目被拒、自建条目删掉并清干净关联数据', () => {
  const store = fakeStore({
    categories: { 'cu-1': true, identity: false },
    text: { 'cu-1': { body: 'x' } },
    order: ['cu-1', 'ladder'],
    custom: [{ id: 'cu-1', title: '我的', defaultOn: true, body: 'B' }],
  })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  assert.equal(ext.removeCustomControl?.('identity'), false, '内置条目不该被删（它是代码的一部分）')
  assert.equal(ext.removeCustomControl?.('ladder'), false, '不存在的条目应被拒')
  assert.equal(ext.removeCustomControl?.('cu-1'), true)
  const after = store.readData<Record<string, unknown>>('') ?? {}
  assert.deepEqual(after.custom, [], '自建条目没删掉')
  assert.deepEqual(after.categories, { identity: false }, '删一条把别的开关状态弄丢了')
  assert.deepEqual(after.order, ['ladder'], 'order 里留了幽灵 id')
})

test('★ 还原：只对被改过的内置条目成功，且回到内置文本', () => {
  const store = fakeStore({ categories: {}, text: { ladder: { body: '改过的' } } })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  assert.equal(ext.resetControlText?.('identity'), false, '没改过的内置条目不该「可还原」')
  assert.equal(ext.resetControlText?.('cu-1'), false, '自建条目没有「内置版本」可回退')
  assert.equal(ext.resetControlText?.('ladder'), true)
  // ⚠️ 必须用 `deepEqual`：`assert.equal` 比的是**引用**，对象永远不等 ——
  //   我第一版就写成这样，判据一直红而代码是对的。
  assert.deepEqual(store.readData<Record<string, unknown>>('')?.text, {}, '覆盖没被丢掉')
  assert.equal((ext.controls ?? []).find((c) => c.id === 'ladder')?.overridden, false)
})

test('★ 排序：只存 id，且过滤掉不存在的 id（脏数据不留幽灵）', () => {
  const store = fakeStore({ categories: {} })
  const ext = createPromptExt({ isSystemPromptReady: () => true, store })
  assert.equal(ext.setControlOrder?.(['__ghost__', 'ladder', 'ladder']), true)
  assert.deepEqual(store.readData<Record<string, unknown>>('')?.order, ['ladder'], '幽灵/重复 id 没被过滤')
})
