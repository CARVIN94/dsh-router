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
  resolveCategories,
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
  // ⚠️ `withTitle = false` 必须**显式**传：原先靠「传的不是 PROMPT_CATEGORIES
  //   那个对象」来隐式决定加不加标题（`categories === PROMPT_CATEGORIES`）。
  //   接入自建条目后调用方传的是合成列表，那个判定恒假 ⇒ 标题静默消失。
  const out = renderCategories(new Set(['y']), custom, undefined, false)
  assert.equal(out, 'Y-BODY')
})

test('★ 渲染出来的第一行是整段标题（拆分时差点丢的就是它）', () => {
  // ⚠️ 原文是 `[准则 …] ·身份气质：…`，标题在方括号里、**不属于任何单条分类**
  //   ⇒ 按分隔符切分时天然被丢掉
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

// ── 面板编辑文本（2026-09-29）────────────────────────────────
test('★ 改过的正文真的进 prompt（不是只改了显示）', () => {
  // ⚠️ 这是"编辑"这件事的**全部意义所在**：漏了这一步，面板改了字、prompt
  //   里还是旧的，而用户会以为成功了 —— 最坏的"看起来成功"。
  const data: PromptExtData = { text: { ladder: { body: '梯子：只走第一档。' } } }
  const text = renderPromptText(true, data)
  assert.ok(text.includes('梯子：只走第一档。'), '编辑后的正文没进 prompt')
  assert.equal(text.includes('停在第一个成立的档'), false, '旧的正文还在')
})

test('改过的标题不影响正文（两个字段各管各的）', () => {
  const data: PromptExtData = { text: { identity: { title: '我是谁' } } }
  const text = renderPromptText(true, data)
  assert.ok(text.includes('大肥鱼'), '只改标题不该动正文')
})

test('注入：空串覆盖被忽略（不能把一条规则"变成空的"）', () => {
  const data: PromptExtData = { text: { ladder: { body: '' } } }
  const text = renderPromptText(true, data)
  assert.ok(text.includes('停在第一个成立的档'), '空串把这条规则清空了 —— 看起来像被关了')
})

test('未改过的分类不出现在 text 里（内置内容仍是唯一事实源）', () => {
  // 只存覆盖值：用户改一个字就永久冻结整段是反效果，内置更新要能继续生效
  const data: PromptExtData = { text: { identity: { body: '我是谁。' } } }
  const text = renderPromptText(true, data)
  assert.ok(text.includes('停在第一个成立的档'), '只改了一条，其余应仍跟内置走')
})

test('注入：text 不是对象时不炸（脏数据不该让整段准则消失）', () => {
  for (const bad of ['x', 42, []] as unknown[]) {
    const data = { text: bad } as unknown as PromptExtData
    const text = renderPromptText(true, data)
    assert.ok(text.includes('停在第一个成立的档'), `text=${JSON.stringify(bad)} 把准则弄没了`)
  }
})

// ── 排序 / 自建 / 还原（2026-09-29）─────────────────────────
test('★ 自建条目真的进 prompt（不是只出现在面板上）', () => {
  const data: PromptExtData = { custom: [{ id: 'my-1', title: '我的准则', defaultOn: true, body: '我的准则：做完就修。' }] }
  const text = renderPromptText(true, data)
  assert.ok(text.includes('我的准则：做完就修。'), '自建条目没进 prompt')
  assert.ok(text.indexOf('我的准则') > text.indexOf('执行：'), '自建条目应排在内置之后')
})

test('★ 拖动排序真的改变 prompt 里的顺序', () => {
  const ids = PROMPT_CATEGORIES.map((c) => c.id)
  const flipped = [...ids].reverse()
  const text = renderPromptText(true, { order: flipped })
  assert.ok(
    text.indexOf('执行：') < text.indexOf('身份气质：'),
    '倒序后 prompt 里顺序没变 ⇒ 拖动只改了面板',
  )
})

test('★ 还原（删掉覆盖）后回到内置文本', () => {
  const edited = renderPromptText(true, { text: { ladder: { body: '改过的' } } })
  assert.ok(edited.includes('改过的'))
  const restored = renderPromptText(true, {}) // 还原 = data.text 里没有该键
  assert.ok(!restored.includes('改过的'))
  assert.ok(restored.includes('停在第一个成立的档'))
})

test('注入：order 里的未知 id 被忽略，不影响其它条目', () => {
  const text = renderPromptText(true, { order: ['__nope__', 'ladder', 'identity'] })
  assert.ok(text.includes('停在第一个成立的档'), '合法条目被脏 id 连累掉了')
  assert.equal(text.includes('__nope__'), false)
})

test('注入：order 漏掉的条目补在后面（丢一条 ≠ 它消失）', () => {
  const text = renderPromptText(true, { order: ['ladder'] })
  // ⚠️ 只查**默认开启**的那些：默认关的（如 `ocr` 工具说明）本就不该出现在
  //   prompt 里，否则这条判据会把它误判成"被 order 吞了"。
  //   （加 ocr 那轮它红了 —— 判据假设"全部开启"，比被守的逻辑宽。）
  for (const c of PROMPT_CATEGORIES) {
    if (!c.defaultOn) continue
    assert.ok(text.includes(c.body.slice(0, 8)), `${c.id} 在 order 里缺席就消失了`)
  }
})

test('注入：脏的 custom 条目（空 id / 空正文）被过滤', () => {
  const data = { custom: [
    { id: '', title: 'x', defaultOn: true, body: '空 id' },
    { id: 'ok', title: 'y', defaultOn: true, body: '' },
    { id: 'good', title: 'z', defaultOn: true, body: '好的' },
  ] } as unknown as PromptExtData
  const text = renderPromptText(true, data)
  assert.ok(text.includes('好的'), '合法自建条目被脏数据连累')
  assert.equal(text.includes('空 id'), false)
})

test('resolveCategories：内置在前、自建在后（代码顺序不被用户拖动改写）', () => {
  const list = resolveCategories({ custom: [{ id: 'c1', title: 'C', defaultOn: true, body: 'B' }] })
  assert.equal(list[list.length - 1]?.id, 'c1', '自建条目应排在最后')
  assert.equal(list[0]?.custom, false)
  assert.equal(list[list.length - 1]?.custom, true)
})

// ── OCR 分类（2026-09-30）────────────────────────────────────
test('★ ocr 分类默认关（它是工具说明，不是纪律骨架）', () => {
  const c = PROMPT_CATEGORIES.find((x) => x.id === 'ocr')
  assert.ok(c !== undefined, '没有 ocr 分类')
  assert.equal(c.defaultOn, false, '工具类默认开 ⇒ 每次会话白带 485 字的工具说明')
  // 反过来：准则骨架那几条**必须**默认开
  for (const id of ['identity', 'redline', 'closure', 'hardening', 'verdifiable']) {
    assert.equal(PROMPT_CATEGORIES.find((x) => x.id === id)?.defaultOn, true, `${id} 不该默认关`)
  }
})

test('★ ocr 分类默认不进 prompt、打开后才进', () => {
  assert.equal(renderPromptText(true, undefined).includes('OCR 代码审查'), false)
  const on = renderPromptText(true, { categories: { ocr: true } })
  assert.ok(on.includes('OCR 代码审查'), '打开后仍不进 prompt')
  assert.ok(on.includes('ocr delegate'), '正文里少了 delegate 那条')
})

test('★ 正文里的换行是真换行（不是字面的 \\n）', () => {
  const on = renderPromptText(true, { categories: { ocr: true } })
  assert.doesNotMatch(on, /\\n/, '出现了字面的 \\n —— 换行没生效，模型会看到反斜杠n')
  const seg = on.slice(on.indexOf('OCR 代码审查'), on.indexOf('OCR 代码审查') + 200)
  assert.ok(seg.split('\n').length >= 3, '三条子命令应该在三行上')
})

test('★ ocr 正文写明了它抓不到什么（别把它当万能闸门）', () => {
  // 准则是"可判定"的：只写工具能做什么、不写它不能做什么，
  // 就会变成"凡事跑一遍 ocr"的仪式。
  const body = PROMPT_CATEGORIES.find((x) => x.id === 'ocr')!.body
  assert.ok(body.includes('抓不到'), '没写它的盲区')
  assert.ok(body.includes('grep'), '没写清与 grep 的分工')
})
