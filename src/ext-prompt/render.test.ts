/**
 * 纯逻辑单测 —— 分类开关的语义。
 *
 * 纪律：每条"注入违规必须失败"的用例都在这里。判据不靠自述，靠**注入反例**：
 * 下面 `注入` 系列就是把已知坏输入喂进去、断言它**不会**被当成正常处理。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveEnabledCategories,
  renderCategories,
  renderPromptText,
  knownCategoryIds,
  type PromptExtData,
} from './render.ts'
import { PROMPT_CATEGORIES, PROMPT_TITLE, defaultToggles } from './content.ts'

// ── 分类表本身 ────────────────────────────────────────────────
test('分类 id 唯一（重名会让开关互相覆盖）', () => {
  const ids = PROMPT_CATEGORIES.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, `重复 id：${ids.join(',')}`)
})

test('每个分类正文非空（空正文 = 该分类注入了但什么都不说）', () => {
  for (const c of PROMPT_CATEGORIES) {
    assert.ok(c.body.trim().length > 0, `${c.id} 正文为空`)
  }
})

test('默认开关全覆盖，且默认开的分类占多数（准则骨架不能默认关）', () => {
  const t = defaultToggles()
  for (const id of knownCategoryIds()) assert.equal(typeof t[id], 'boolean')
  const on = PROMPT_CATEGORIES.filter((c) => c.defaultOn).length
  assert.ok(on >= PROMPT_CATEGORIES.length / 2, `默认开只有 ${on}/${PROMPT_CATEGORIES.length}`)
})

// ── 开关解析 ──────────────────────────────────────────────────
test('总开关关 ⇒ 一条都不渲染（不是"空段落"，是完全没有）', () => {
  const on = resolveEnabledCategories(false, undefined)
  assert.equal(on.size, 0)
  assert.equal(renderPromptText(false, undefined), '')
})

test('总开关开、无数据 ⇒ 走 defaultOn', () => {
  const on = resolveEnabledCategories(true, undefined)
  for (const c of PROMPT_CATEGORIES) {
    assert.equal(on.has(c.id), c.defaultOn, `${c.id} 解析与 defaultOn 不符`)
  }
})

test('用户显式关掉某分类 ⇒ 该分类不渲染（这是"可开关"的正向判据）', () => {
  const data: PromptExtData = { categories: { identity: false } }
  const on = resolveEnabledCategories(true, data)
  assert.equal(on.has('identity'), false)
  assert.equal(renderPromptText(true, data).includes('大肥鱼'), false)
})

test('用户显式开某分类 ⇒ 该分类渲染（默认关的分类也能被打开）', () => {
  const data: PromptExtData = { categories: { identity: true } }
  assert.equal(renderPromptText(true, data).includes('大肥鱼'), true)
})

test('false 与 undefined 语义不同：显式 false 不被 defaultOn 覆盖', () => {
  // identity 默认开；用户显式关掉后，仍必须是关的
  const on = resolveEnabledCategories(true, { categories: { identity: false } })
  assert.equal(on.has('identity'), false, '显式 false 被 defaultOn 覆盖 = 用户选择被静默丢弃')
})

// ── 注入违规：坏输入不得被静默接受 ────────────────────────────
test('注入：categories 不是对象 ⇒ 当作没配，不炸不吞（total crash 是不合格行为）', () => {
  for (const bad of [null, 'x', 42, [] as unknown]) {
    const data = { categories: bad } as unknown as PromptExtData
    // 直接调用：真抛了测试自然失败，不需要 doesNotThrow 再包一层。
    const text = renderPromptText(true, data)
    // 非法数据 ⇒ 回落到默认值，且仍然产出文本（不能因为数据坏就丢掉整个准则）
    assert.ok(text.length > 0, `categories=${JSON.stringify(bad)} 导致准则整体消失`)
  }
})

test('注入：未知分类 id 被忽略，不进渲染（防止脏数据塞进 prompt）', () => {
  const data: PromptExtData = {
    categories: { identity: true, __evil__: true, '../../etc/passwd': true },
  }
  const on = resolveEnabledCategories(true, data)
  assert.equal(on.has('__evil__'), false)
  assert.equal(on.has('../../etc/passwd'), false)
  const text = renderPromptText(true, data)
  assert.equal(text.includes('__evil__'), false)
  assert.equal(text.includes('passwd'), false)
})

test('注入：非布尔真值（"false" 字符串）不当作 true（否则用户写了字符串=静默反转选择）', () => {
  // 注意：TS 类型上这是非法的，但落盘 JSON 不可信 —— 判据必须在运行时守住
  const data = { categories: { identity: 'false' as unknown as boolean } }
  const on = resolveEnabledCategories(true, data)
  // 'false' 既非 undefined 也非 true ⇒ 不进 enabled（保守：不猜）
  assert.equal(on.has('identity'), false, '字符串 "false" 被当成开启 = 用户选择被反转')
})

// ── 渲染 ──────────────────────────────────────────────────────
test('渲染：每个开启的分类正文都出现一次', () => {
  const text = renderPromptText(true, undefined)
  for (const c of PROMPT_CATEGORIES) {
    if (!c.defaultOn) continue
    const n = text.split(c.body).length - 1
    assert.equal(n, 1, `${c.id} 出现 ${n} 次（期望 1）`)
  }
})

test('渲染：顺序与分类表一致（准则是有先后的执行流程）', () => {
  const text = renderPromptText(true, undefined)
  const positions = PROMPT_CATEGORIES
    .filter((c) => c.defaultOn)
    .map((c) => text.indexOf(c.body))
  for (let i = 1; i < positions.length; i++) {
    assert.ok(
      positions[i]! > positions[i - 1]!,
      `第 ${i} 个分类位置 ${positions[i]} 未排在第 ${i - 1} 个 ${positions[i - 1]} 之后`,
    )
  }
})

test('渲染：全关 ⇒ 空串（空串会让上游丢弃该段，不是"注入一段空白"）', () => {
  const off: Record<string, boolean> = {}
  for (const id of knownCategoryIds()) off[id] = false
  assert.equal(renderPromptText(true, { categories: off }), '')
})

test('注入：renderCategories 传外部分类表时只渲染其中启用的（可扩展性）', () => {
  const custom = [
    { id: 'x', title: 'X', defaultOn: true, body: 'X-BODY' },
    { id: 'y', title: 'Y', defaultOn: true, body: 'Y-BODY' },
  ]
  const out = renderCategories(new Set(['y']), custom)
  assert.equal(out, 'Y-BODY')
})

test('★ 渲染出来的第一行是整段标题（拆分时差点丢的就是它）', () => {
  // ⚠️ 原文是 `[准则 v5 · 懒人梯子 + 全局收口 + 固化] ·身份气质：…`，
  //   标题在方括号里、**不属于任何单条分类** ⇒ 按分隔符切分时天然被丢掉
  //   （它只出现在 content.ts 头注，没进任何 body）。
  //   丢了的后果：模型看到 14 条**没有名字**的规则，不知道这套东西是什么。
  const text = renderPromptText(true, undefined)
  assert.ok(text.startsWith(PROMPT_TITLE), `第一行不是标题；开头是：${text.slice(0, 30)}`)
  assert.equal(text.split('\n')[0], PROMPT_TITLE, '标题必须在最前面 —— 它要解释后面的规则')
})

test('全关时标题也不出现（不能有一套叫准则 v5 的东西却一条规则都没有）', () => {
  const off: Record<string, boolean> = {}
  for (const id of knownCategoryIds()) off[id] = false
  const text = renderPromptText(true, { categories: off })
  assert.equal(text, '', '只剩标题 = 一套空准则，比没有更糟')
})
