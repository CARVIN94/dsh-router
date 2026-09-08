/**
 * 数据目录解析测试 —— 锁死「落盘位置不跟 cwd 跑」这个 bug。
 *
 * 起因：以前写的是相对路径 `data/state.json`，宿主 Node 进程的 cwd 决定它
 * 落到哪。从别的目录 `dsh web` 启动 → 配置静默写进另一个目录，面板显示空
 * 配置，用户看到的就是「配置丢了」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dataDirOf, profileDirOf } from './data-dir.ts'

/** 一个临时 profile 目录的 file: URL（宿主 `ctx.baseUrl` 的形状）。 */
function tempProfileUrl(): { url: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dshr-profile-'))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n') // 让它像个 profile
  return { url: pathToFileURL(dir).href + '/', dir }
}

test('有 baseUrl → 数据目录钉在 profile 里（绝对路径）', () => {
  const { url, dir } = tempProfileUrl()
  assert.equal(profileDirOf(url), dir)
  assert.equal(dataDirOf(url), join(dir, 'data'))
})

test('换 cwd 不影响落盘位置（回归：不跟 process.cwd() 跑）', () => {
  const { url, dir } = tempProfileUrl()
  const before = dataDirOf(url)
  const cwd = process.cwd()
  try {
    process.chdir(tmpdir())
    assert.equal(dataDirOf(url), before)
  } finally {
    process.chdir(cwd)
  }
  assert.ok(resolve(before).startsWith(resolve(dir)))
})

test('baseUrl 缺失/异常 → 兜底 $DSH_HOME 的 web profile', () => {
  const saved = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'dshr-home-'))
  try {
    process.env.DSH_HOME = home
    assert.equal(profileDirOf(undefined), join(home, 'profiles', 'web'))
    assert.equal(profileDirOf(''), join(home, 'profiles', 'web'))
    assert.equal(profileDirOf('http://example.com/x'), join(home, 'profiles', 'web'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})
