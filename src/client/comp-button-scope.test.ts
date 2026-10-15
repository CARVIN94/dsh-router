/**
 * 面板按钮的字色判据 —— 锁住「每个按钮都在那条抬特异性的规则覆盖范围内」。
 *
 * ## 为什么需要这条
 *
 * 宿主的 `Button` 原语在 `primary` 变体里要把字色设成
 * `--dsw-alias-label-primary-foreground`，但 `router.css` 顶部那条兜底
 * `.dshr-settings button { color: inherit; font: inherit }` 特异性 (1,1) **高于**
 * 原语的 (1,0)，赢的是它 —— 于是按钮变「#0f1115 底 + 继承来的 #0f1115 字」，
 * **黑底黑字**。这个插件已经因此翻车两次：第一次是访问测试按钮，第二次是新增的
 * 契约体检按钮（上一版修复只挂在 `.dshr-compActions` 上，新按钮在另一个容器里，
 * 规则没盖到）。症状完全一样、且不报任何错。
 *
 * 修法是给每个动作行挂 `dshr-compBtnRow`，由一条 (2,1) 的规则统一还原字色。
 * （这个类名特意**不是** `dshr-compActions` 的前缀：否则下面按子串计数会把它
 * 一起算进去，判据自己就成了摆设。）
 * 那么「新增按钮忘了挂这个类」就会退化成同样的黑底黑字 —— 这条判据就是拦它的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const panel = readFileSync(fileURLToPath(new URL('./ExtTestPanel.tsx', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('./router.css', import.meta.url)), 'utf8')

test('面板里每个 Button 都在一个带 dshr-compBtnRow 的动作行里', () => {
  // 一个动作行可以放多个按钮（「只读体检」+「深度体检」并排），所以判据是
  // **每个 Button 在源码里都处于某个 dshr-compBtnRow 容器之内** —— 早期版本
  // 用「按钮数 == 行数」来近似，被并排两个按钮的布局直接顶红了（这正是它的价值：
  // 假设一旦不成立就会暴露，而不是继续绿）。
  const opens = [...panel.matchAll(/<div className="([^"]*)">/g)].map((m) => m[1])
  const rows = opens.filter((c) => (c ?? '').includes('dshr-compBtnRow')).length
  assert.ok(rows > 0, '面板里应当有动作行（这条判据才有意义）')
  const buttons = [...panel.matchAll(/<Button\b/g)]
  assert.ok(buttons.length > 0, '面板里应当有 Button')
  for (const b of buttons) {
    const before = panel.slice(0, b.index)
    // 取该 Button 之前最近一个开着的 <div>，看它是不是动作行
    const nearest = [...before.matchAll(/<div className="([^"]*)">/g)].pop()
    assert.ok((nearest?.[1] ?? '').includes('dshr-compBtnRow'),
      `有一个 Button 不在任何 dshr-compBtnRow 动作行里（最近的容器：${nearest?.[1] ?? '无'}）—— 会变回黑底黑字`)
  }
})

test('那条字色规则挂在共用类上（不能再写死某个容器）', () => {
  assert.match(css, /\.dshr-comp \.dshr-compBtnRow button\s*\{/,
    '字色规则必须挂在 .dshr-compBtnRow 上：写死某个容器的话，下次新增按钮换个容器就漏')
  assert.match(css, /\.dshr-comp \.dshr-compBtnRow button\s*\{[^}]*color:\s*var\(--dsw-alias-label-primary-foreground\)/,
    '字色仍由原语那个 token 决定，不自己另挑一个颜色')
})

test('规则特异性高于那条兜底（不依赖源码顺序）', () => {
  // 兜底 = `.dshr-settings button` (1,1)；本规则 = `.dshr-comp .dshr-compBtnRow button` (2,1)
  const rule = css.match(/(\.[\w-]+)\s+(\.[\w-]+)\s+button\s*\{[^}]*color:\s*var\(--dsw-alias-label-primary-foreground\)/)
  assert.ok(rule !== null, '找不到那条字色规则')
  assert.notEqual(rule[1], '.dshr-settings', '不能和兜底规则同容器 —— 同特异性就变成靠源码顺序了')
})
