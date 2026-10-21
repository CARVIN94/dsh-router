/**
 * `system-prompt/assemble` waterfall 的**真删段**判据。
 *
 * ⚠️ 为什么这条闸门非有不可（本仓反复栽过的形状）：面板能列、开关能落盘，
 * 但"关掉之后模型到底还看不看得到这一段"是**另一件事**。只测前两者会得到一个
 * 全绿的假象，而线上行为是"关了没用"。本仓同类教训：`docs` 里记的
 * "apply 里 inject 不可靠 ⇒ 准则一次都没进过 prompt"（面板全正常、prompt 里没有）。
 *
 * 做法：用**真 cordis Context**（`ctx.on` + `ctx.waterfall` 真实现）跑一次
 * 装配链，断言监听器返回的 assembly 里段真的少了。监听器的返回值就是宿主采信
 * 的结果（宿主 `assemble()` 源码：`const transformed = await this.ctx.waterfall(...)`
 * 后 `return transformed`），所以这里验的是**我们这一侧的责任边界**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { OWN_SECTION_NAME, disabledSectionNames, filterSections } from './sections.ts'
import type { PromptExtData } from './render.ts'

/** 装配出的一条段（宿主形状的最小面）。 */
interface Assembled {
  name: string
  text: string
}

/**
 * 按 `index.ts` 里监听器的**同一形状**接一条装配链，返回 waterfall 的结果。
 *
 * ⚠️ 刻意复制那 6 行而不是从 `index.ts` 导出一个可测函数：`index.ts` 的
 * 监听器需要真 `systemPrompt` service 才能注册（它读 `systemPromptOf(ctx)`），
 * 为它造全套宿主桩会让判据变成"测桩"。这里验的是**逻辑链**：先取 next()、
 * 再按落盘过滤；复制带来的漂移风险由"两边注释互相指认"兜住。
 */
async function runAssembly(
  ctx: { on: (n: string, f: unknown) => unknown; waterfall: (n: string, ...a: unknown[]) => Promise<unknown> },
  opts: { enabled: boolean; data?: PromptExtData; sections: Assembled[] },
): Promise<Assembled[]> {
  ctx.on('system-prompt/assemble', async (
    _assembly: unknown,
    _context: unknown,
    next: () => Promise<{ sections: Assembled[] }>,
  ) => {
    const result = await next()
    if (!opts.enabled) return result
    const off = disabledSectionNames(opts.data)
    if (off.size === 0) return result
    return { ...result, sections: filterSections(result.sections, off) }
  })
  // 真 waterfall：最后一个参数是终态回调（返回 assembly），前面的参数原样透传给监听器
  // ⚠️ 派发的事件名必须与注册的**逐字相同**：我第一版这里写 'assemble'，
  //   而上面注册的是 'system-prompt/assemble' ⇒ 监听器根本没被调用，
  //   断言报"关了却还在"。那种失败**看起来像功能没实现**，实际是判据自己
  //   接错了线 —— 事件名是字符串、拼错不报错，只让闸门测了个空。
  const out = await ctx.waterfall(
    'system-prompt/assemble',
    { sections: opts.sections },
    {},
    async () => ({ sections: opts.sections }),
  ) as { sections: Assembled[] }
  return out.sections
}

const ALL: Assembled[] = [
  { name: OWN_SECTION_NAME, text: '准则正文' },
  { name: 'harness:identity', text: 'You are an AI agent.' },
  { name: 'tool:write', text: 'write spec' },
  { name: 'tool:edit', text: 'edit spec' },
]

async function freshCtx() {
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  return ctx as unknown as {
    on: (n: string, f: unknown) => unknown
    waterfall: (n: string, ...a: unknown[]) => Promise<unknown>
  }
}

test('★ 关掉的段真的从装配结果里消失（"可开关"的唯一真判据）', async () => {
  const ctx = await freshCtx()
  const out = await runAssembly(ctx, {
    enabled: true,
    data: { sections: { 'tool:write': false } },
    sections: ALL,
  })
  const names = out.map((s) => s.name)
  assert.equal(names.includes('tool:write'), false, '关了却还在 ⇒ 面板开关是装饰')
  assert.equal(names.includes('tool:edit'), true, '没关的被误删 ⇒ 开关粒度错了')
})

test('★ 准则段永不被 waterfall 删掉（关它走的是总开关/分类开关）', async () => {
  const ctx = await freshCtx()
  const out = await runAssembly(ctx, {
    enabled: true,
    // 手改 ext.json 把准则段写进关闭项：也不许删
    data: { sections: { [OWN_SECTION_NAME]: false, 'tool:write': false } },
    sections: ALL,
  })
  const names = out.map((s) => s.name)
  assert.equal(names.includes(OWN_SECTION_NAME), true, '准则段被删 ⇒ 分类开关全部失效')
  assert.equal(names.includes('tool:write'), false)
})

test('★ 总开关关 ⇒ 原样放行（扩展关 = 什么都不做，宿主段落自然注入）', async () => {
  const ctx = await freshCtx()
  const out = await runAssembly(ctx, {
    enabled: false,
    data: { sections: { 'tool:write': false } },
    sections: ALL,
  })
  assert.deepEqual(out.map((s) => s.name), ALL.map((s) => s.name),
    '总开关关掉后仍然删段 ⇒ 用户关了扩展但提示词还在被改')
})

test('全开（落盘无关闭项）⇒ 一个段都不动', async () => {
  const ctx = await freshCtx()
  const out = await runAssembly(ctx, { enabled: true, sections: ALL })
  assert.deepEqual(out.map((s) => s.name), ALL.map((s) => s.name))
})

test('关闭项全是失效名字 ⇒ 装配结果不受影响（宿主换版本后的旧数据）', async () => {
  const ctx = await freshCtx()
  const out = await runAssembly(ctx, {
    enabled: true,
    data: { sections: { 'gone:forever': false } },
    sections: ALL,
  })
  assert.deepEqual(out.map((s) => s.name), ALL.map((s) => s.name))
})

test('多个监听器串联时我们的过滤不被前一个吞掉（waterfall 顺序语义）', async () => {
  const ctx = await freshCtx()
  // 先注册一个"什么都不做、原样返回"的旁观者
  ctx.on('system-prompt/assemble', async (_a: unknown, _c: unknown, next: () => Promise<{ sections: Assembled[] }>) => next())
  const out = await runAssembly(ctx, {
    enabled: true,
    data: { sections: { 'tool:edit': false } },
    sections: ALL,
  })
  assert.equal(out.map((s) => s.name).includes('tool:edit'), false)
})
