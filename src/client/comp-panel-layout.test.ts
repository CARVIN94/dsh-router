/**
 * 插件自检面板的**版面**判据 —— 不是像素级的样式测试，是「结构上别退回去」。
 *
 * 背景：核心侧那两项（模型启用状态 / 全部启用禁用）原先单独画了个带框的区块
 * （`.dshr-compCore`，加粗、垫底色、单独一栏）。看着比真问题还显眼，而它们本来就是
 * 体检结果的一部分，用户要的是「一眼扫完」。所以并进契约成员那一份列表，同一种行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const panel = readFileSync(fileURLToPath(new URL('./ExtTestPanel.tsx', import.meta.url)), 'utf8')
const css = readFileSync(fileURLToPath(new URL('./router.css', import.meta.url)), 'utf8')

test('核心侧那两项和契约成员同构：不另起区块', () => {
  assert.equal(/className="dshr-compCore"/.test(panel), false,
    '核心侧不该有自己的区块 —— 要和契约成员用同一份列表、同一种行')
  assert.equal(/\.dshr-compCore\s*\{/.test(css), false, '核心侧区块的样式也该删掉')
})

test('「模型启用状态」和「全部启用/禁用」都渲染成 dshr-compMember 行', () => {
  const rowCount = (panel.match(/className="dshr-compMember"/g) ?? []).length
  assert.ok(rowCount >= 3, '至少要有：模型启用状态、全部启用禁用、契约成员各自的行')
  assert.match(panel, /模型启用状态/, '模型启用状态要在面板上出现')
  assert.match(panel, /report\.core\.operations\.map/, '全部启用/禁用由 core.operations 渲染')
})

test('面板顶部说明是一句话（不是写给维护者的长篇）', () => {
  const intro = panel.match(/<p className="dshr-compIntro">([\s\S]*?)<\/p>/g) ?? []
  for (const block of intro) {
    const text = block.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    assert.ok(text.length <= 60, `说明要一句话（现在 ${text.length} 字）：${text}`)
  }
})

test('两节各有一个标题，两个按钮都叫「测试」（否则分不清点的是哪一个）', () => {
  // 两个按钮同名是有意的（用户就是要一个统一的动词），代价是两节必须有标题来区分
  assert.match(panel, /<h4 className="dshr-compSectionTitle">连接测试<\/h4>/, '第一节要有标题')
  assert.match(panel, /<h4 className="dshr-compSectionTitle">插件测试<\/h4>/, '第二节叫「插件测试」')
  assert.equal((panel.match(/'测试'|'测试中…'/g) ?? []).length, 4,
    '两节各一对（常态 + 进行中）')
  assert.equal(panel.includes('跑一次访问测试'), false, '旧的按钮长称别回来')
  assert.equal(panel.includes('跑一次出厂体检'), false, '旧的按钮长称别回来')
  assert.equal(panel.includes('插件契约体检'), false, '旧的节名别回来')
})
