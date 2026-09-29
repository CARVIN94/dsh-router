/**
 * 提示词**装配结果**的断言 —— 回答「我关掉的分类，真的没进 prompt 吗」。
 *
 * 为什么单独一个文件：这不是某个函数的单测，而是**跨模块的合成事实** ——
 *   content.ts（内容）→ render.ts（按开关拼）→ mount.ts（注册 provider）
 *   → ctx.systemPrompt（平台装配）→ renderPrompt（最终文本）
 * 任何一环坏了，单测都绿而 prompt 里没有。
 *
 * ⚠️ 全部用**真 cordis + 真 dsh-system-prompt**。假 systemPrompt 会立即回调、
 * 立刻返回，`assemble()` 返回什么全凭我写 —— 那就是自己给自己判分
 * （2026-09-29 刚栽过：假 ctx 的 inject 立即回调，恰好把「准则没挂上」这个
 * 真 bug 完美掩盖）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt, renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { mountPromptSection, PROMPT_SECTION_NAME } from './mount.ts'
import { renderPromptText } from './render.ts'
import { PROMPT_CATEGORIES } from './content.ts'

/** 起一个真 systemPrompt 并挂上本扩展。 */
async function assemble(
  opts: { masterOn?: boolean; data?: unknown } = {},
): Promise<PromptAssembly> {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  let enabled = true
  const data = opts.data
  const dispose = mountPromptSection({
    getSystemPrompt: () => ctx.systemPrompt,
    isEnabled: () => (opts.masterOn ?? enabled),
    readData: () => data as never,
  })
  void enabled
  void dispose
  await new Promise((r) => setTimeout(r, 10))
  return ctx.systemPrompt.assemble({})
}

test('★ 装配结果里真的有准则段落（不是「我以为我挂了」）', async () => {
  const a = await assemble()
  const mine = a.sections.find((s) => s.name === PROMPT_SECTION_NAME)
  assert.ok(mine, `装配里没有 ${PROMPT_SECTION_NAME} 段落；现有：${a.sections.map((s) => s.name).join(', ')}`)
  const text = renderPrompt(a)
  assert.ok(text.includes('懒人梯子'), '最终 prompt 文本里没有准则正文')
  assert.ok(text.includes('准则 v5'), '标题不在（拆分时最容易丢的就是它）')
})

test('★ 关掉某条分类 ⇒ 装配结果里那条真的不在', async () => {
  const a = await assemble({ data: { categories: { structure: false } } })
  const text = renderPrompt(a)
  const body = PROMPT_CATEGORIES.find((c) => c.id === 'structure')!.body
  assert.equal(text.includes(body), false, `「结构」关了却仍在 prompt 里：${body.slice(0, 20)}`)
  // 反向：没关的必须在
  const keep = PROMPT_CATEGORIES.find((c) => c.id === 'delivery')!.body
  assert.ok(text.includes(keep), '没关的分类被误删了')
})

test('★ 总开关关 ⇒ 整个段落被丢弃（空文本不产出任何内容）', async () => {
  const a = await assemble({ masterOn: false })
  const mine = a.sections.find((s) => s.name === PROMPT_SECTION_NAME)
  // 平台对空 section 的处理是「不产出文本」——断言**文本**里没有，而不是
  // 「section 不存在」：section 仍注册着，只是 text 为空。
  assert.equal(renderPrompt(a).includes('懒人梯子'), false, '总开关关了准则还在')
  void mine
})

test('装配结果与 renderPromptText 的内容一致（渲染逻辑只有一处实现）', async () => {
  const a = await assemble()
  const text = renderPrompt(a)
  const expected = renderPromptText(true, undefined)
  assert.ok(text.includes(expected), '装配结果里找不到 renderPromptText 的输出 ⇒ 两处实现漂移了')
})
