/**
 * 宿主版本探测测试 —— 锁死那条**版本地板**（>= 0.2.0）。
 *
 * 这条判据现在只有一个用途：**在老宿主上出声**。兼容分叉（三处 `>= 0.1.7`）随
 * 0.2.0 单面编写一起删掉了，所以本测试守的是「低于地板会被判为不支持 → apply 时
 * 打警告」这条报警链，而不是某个功能开关。
 *
 * 地板抬到 0.2.0 的那一刻，0.1.7 从「支持」翻成「不支持」——这条断言就是那次
 * 翻面的记录：谁想再加回 0.1.x 兼容，本测试会先红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectHostVersion, isHostSupported } from './host-version.ts'

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
  assert.equal(detectHostVersion(profileWithDsh('0.1.7-rc.2')), '0.1.7-rc.2')
  assert.equal(detectHostVersion(profileWithDsh('0.2.0-rc.1')), '0.2.0-rc.1')
})

test('地板：>= 0.2.0 才算支持（预发布标识忽略，按前导数字比）', () => {
  for (const v of ['0.2.0-rc.1', '0.2.0', '0.2.1', '1.0.0']) {
    assert.equal(isHostSupported(profileWithDsh(v)), true, v)
  }
})

test('地板之下（0.1.5/0.1.6/0.1.7）判为不支持 —— 会打警告而不是静默走错路径', () => {
  for (const v of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2', '0.1.4']) {
    assert.equal(isHostSupported(profileWithDsh(v)), false, v)
  }
})

test('读不到版本 → 判为不支持（无法确认也值得说一声），且不抛', () => {
  assert.equal(detectHostVersion(profileWithDsh(null)), undefined)
  assert.equal(isHostSupported(profileWithDsh(null)), false)
  // 垃圾版本号
  assert.equal(isHostSupported(profileWithDsh('not-a-version')), false)
  // baseUrl 缺失（冷启动/单测）→ 回落 ~/.dsh/profiles/web，不抛
  assert.doesNotThrow(() => isHostSupported(undefined))
})
