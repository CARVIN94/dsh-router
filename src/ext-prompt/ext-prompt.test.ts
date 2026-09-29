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
import { apply, name as CORDIS_NAME } from './index.ts'
import { PROMPT_SECTION_NAME } from './mount.ts'
import { PROMPT_CATEGORIES } from './content.ts'
import type { RouterExtService } from '../ext/contract.ts'

test('扩展器带上面板要用的身份', () => {
  const ext = createPromptExt({ isSystemPromptReady: () => true })
  assert.equal(ext.id, EXT_PROMPT_ID)
  assert.equal(ext.name, '分层提示词')
  assert.ok((ext.description ?? '').length > 0, '没有说明，插件页那一行就没有副标题')
  assert.equal(ext.source, 'builtin', '随核心分发必须标 builtin，否则插件页会重复列它')
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

/** 最小 ctx：inject 立刻回调，systemPrompt 假件记录挂了什么。 */
function fakeCtx(opts: { table?: RouterExtService; ready?: boolean; data?: unknown; enabled?: boolean } = {}) {
  const table: RouterExtService = opts.table ?? {}
  const enabled = new Set<string>()
  const sections: { name: string; order: number; text: string | (() => string) }[] = []
  let disposed = 0
  const ctx = {
    inject: (deps: string[], cb: (sctx: unknown) => void) => {
      for (const d of deps) {
        const sctx = {
          get: (key: string) => {
            if (key === 'router.ext') return table
            if (key === 'systemPrompt') {
              return opts.ready === false
                ? undefined
                : {
                    section: (s: { name: string; order: number; text: string | (() => string) }) => {
                      sections.push(s)
                      return () => {
                        disposed++
                      }
                    },
                  }
            }
            if (key === 'router.extStore') {
              return {
                // opts.enabled 显式给了就用它，否则模拟"登记时置开、之后可被读"的常态。
                isEnabled: (id: string) => (opts.enabled ?? enabled.has(id)),
                setEnabled: (id: string) => enabled.add(id),
                readData: () => opts.data,
                writeData: () => {},
              }
            }
            return undefined
          },
        }
        cb(sctx)
      }
    },
    emit: () => {},
  } as unknown as Parameters<typeof apply>[0]
  return { ctx, table, sections, get disposed() { return disposed } }
}

test('apply 把扩展登记进 router.ext 表（这张表就是「卡片出现」的唯一依据）', () => {
  const { ctx, table } = fakeCtx()
  apply(ctx)
  assert.equal(table[EXT_PROMPT_ID]?.name, '分层提示词')
})

test('幂等：同一个 id 已在表里时不顶掉别人的登记', () => {
  const { ctx, table } = fakeCtx()
  apply(ctx)
  const first = table[EXT_PROMPT_ID]
  apply(ctx)
  assert.equal(table[EXT_PROMPT_ID], first, '重复登记不该换成一个新对象')
})

test('★ apply 把准则挂成了 system prompt 段落（ext-test 没这层，必须单独验）', () => {
  const { ctx, sections } = fakeCtx()
  apply(ctx)
  assert.equal(sections.length, 1, '准则没挂上 = 卡片亮着但 prompt 里没有准则')
  assert.equal(sections[0]!.name, PROMPT_SECTION_NAME)
  assert.equal(typeof sections[0]!.text, 'function', '静态文本 ⇒ 分类开关永远不生效')
})

test('注入：总开关关时段落文本为空（平台据此丢弃该段）', () => {
  const { ctx, sections } = fakeCtx({ enabled: false })
  apply(ctx)
  const text = (sections[0]!.text as () => string)()
  assert.equal(text, '', '总开关关时必须返回空串，而不是注入一段空白')
})

test('注入：用户关掉某分类 ⇒ 该分类不进 prompt（可开关的正向判据）', () => {
  const { ctx, sections } = fakeCtx({ enabled: true, data: { categories: { identity: false } } })
  apply(ctx)
  const text = (sections[0]!.text as () => string)()
  assert.equal(text.includes('大肥鱼'), false, 'identity 关了就不该出现')
  assert.ok(text.includes('视野'), '其他分类照常')
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
