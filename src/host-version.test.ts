/**
 * 宿主版本探测测试 —— 锁死「最近命中徽章仅在 >= 0.1.7 出现」这条判定。
 *
 * 起因：`conversation.composer.dock` 座位在 0.1.5 也在，但渲染在 InputBar 之后
 * 的独立块（位置不对）；只有 0.1.7 才放进底部操作行。座位名相同没法靠契约区分，
 * 只能按宿主版本号判定——本测试就是这条判据的唯一守卫。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectHostVersion, supportsLastHitDock } from './host-version.ts'

/** 造一个「装了指定版本 dsh」的临时 profile，返回它的 file: URL。 */
function profileWithDsh(version: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshr-hostver-'))
  if (version !== null) {
    const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh', version }))
  }
  return pathToFileURL(dir).href + '/'
}

test('读得到版本：detectHostVersion 返回 profile 里装的 dsh 版本', () => {
  assert.equal(detectHostVersion(profileWithDsh('0.1.5-rc.3')), '0.1.5-rc.3')
  assert.equal(detectHostVersion(profileWithDsh('0.1.7-alpha.2')), '0.1.7-alpha.2')
})

test('支持位：>= 0.1.7 才为真（预发布标识忽略，按前导数字比）', () => {
  assert.equal(supportsLastHitDock(profileWithDsh('0.1.7-alpha.2')), true)
  assert.equal(supportsLastHitDock(profileWithDsh('0.1.7')), true)
  assert.equal(supportsLastHitDock(profileWithDsh('0.2.0')), true)
  assert.equal(supportsLastHitDock(profileWithDsh('1.0.0')), true)
  // 低于 0.1.7 → 不挂（0.1.5 位置不对，宁可不显示）
  assert.equal(supportsLastHitDock(profileWithDsh('0.1.5-rc.3')), false)
  assert.equal(supportsLastHitDock(profileWithDsh('0.1.6-alpha.2')), false)
  assert.equal(supportsLastHitDock(profileWithDsh('0.1.4')), false)
})

test('读不到版本 → 一律当不支持（不抛、宁可不显示）', () => {
  assert.equal(detectHostVersion(profileWithDsh(null)), undefined)
  assert.equal(supportsLastHitDock(profileWithDsh(null)), false)
  // 垃圾版本号
  assert.equal(supportsLastHitDock(profileWithDsh('not-a-version')), false)
  // baseUrl 缺失（冷启动/单测）→ 回落 ~/.dsh/profiles/web，不抛
  assert.doesNotThrow(() => supportsLastHitDock(undefined))
})
