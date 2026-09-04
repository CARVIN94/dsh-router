/**
 * 发布前的身份一致性 + 白名单完整性检查。
 *
 * 为什么要这个：DSH 插件有**三个必须逐字相同的名字**，跨文件却没有任何工具
 * 能保证它们同步（鸭子类型 + YAML，tsc 抓不到）：
 *
 *   1. package.json 的 `name`（npm 装出来的目录名）
 *   2. cordis.patch.yml 插入行里的 `name`（loader 拿它去 `import(name)`，
 *      客户端拿它去 `require.resolve(name + '/package.json')` 定位 client bundle）
 *   3. client bundle 注册的 id（DSH_CLIENT_ID，必须等于入参 2，否则
 *      `arrive()` 抛 bundle loaded without registering "<name>"）
 *
 * 曾经 package.json 改名 dsh-router-core（npm 上 dsh-router 被抢注）而
 * 2、3 没跟着改，表现是「从 npm 装完加载不到 / 设置页不存在」——症状离原因
 * 极远，必须机器拦。
 *
 * 顺带查 `files` 白名单有没有漏掉运行时真读的目录：内置供应商是运行时扫
 * `<pkg>/lib/suppliers/*.js` 加载的（scanDir 吞异常返回 []），漏了就是
 * 「装完零内置供应商」且**不报任何错**。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []

// ---- 1/2/3：三处名字必须一致 ----
const patchText = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
// 只取 insert 行里的 name（`id:` 是配置树句柄，随便取；`name:` 才是模块说明符）
const nameLines = [...patchText.matchAll(/^\s+name:\s*'([^']+)'/gm)].map((m) => m[1])
if (nameLines.length !== 1) {
  problems.push(`cordis.patch.yml 里应恰好有一个 name，实际 ${nameLines.length} 个：${JSON.stringify(nameLines)}`)
} else if (nameLines[0] !== pkg.name) {
  problems.push(`cordis.patch.yml 的 name '${nameLines[0]}' ≠ package.json 的 name '${pkg.name}'（loader 拿它 import 模块，必须逐字相同）`)
}

// 客户端 bundle id 来自 build:client 的 DSH_CLIENT_ID（profile 通道那一半）
const buildClient = pkg.scripts?.['build:client'] ?? ''
const firstId = buildClient.match(/DSH_CLIENT_ID=(\S+)/)?.[1]
if (firstId === undefined) {
  problems.push('build:client 里找不到 DSH_CLIENT_ID（profile 通道的 bundle id）')
} else if (firstId !== pkg.name) {
  problems.push(`build:client 的第一个 DSH_CLIENT_ID '${firstId}' ≠ package.json 的 name '${pkg.name}'（graph row id 是 entry name，bundle 必须注册同一个 id）`)
}

// src/index.ts 的 `export const name`（cordis.yml 行的身份声明，同样要对上）
const indexSrc = readFileSync(join(root, 'src/index.ts'), 'utf8')
const exported = indexSrc.match(/^export const name = '([^']+)'/m)?.[1]
if (exported !== undefined && exported !== pkg.name) {
  problems.push(`src/index.ts 的 export const name '${exported}' ≠ package.json 的 name '${pkg.name}'`)
}

// ---- 产物里的 id 真的落上了吗（构建后跑才有意义，lib 缺失就跳过）----
const clientJs = join(root, 'lib/client.js')
if (existsSync(clientJs)) {
  const built = (await readFile(clientJs, 'utf8')).match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/)?.[1]
  if (built === undefined) problems.push('lib/client.js 里找不到 __ModuleLoader__ 注册 id')
  else if (built !== pkg.name) problems.push(`lib/client.js 注册 id '${built}' ≠ '${pkg.name}'（旧产物？重新 npm run build）`)
} else {
  console.log('· 跳过产物检查：lib/client.js 不存在（还没构建）')
}

// ---- 白名单：运行时真读的目录必须在 files 里 ----
// 内置供应商是运行时扫 <pkg>/lib/suppliers/*.js 加载的，漏了会静默零供应商。
const patterns = pkg.files ?? []
const covers = (rel) =>
  patterns.some((p) =>
    p.endsWith('/**') ? rel.startsWith(p.slice(0, -2)) :
    p.includes('*') ? new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(rel) :
    p.endsWith('/') ? rel.startsWith(p) : rel === p)
const required = ['cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/client-registry.js']
for (const rel of required) if (!covers(rel)) problems.push(`files 白名单漏了运行时必需文件 ${rel}`)

const libSuppliers = join(root, 'lib/suppliers')
if (existsSync(libSuppliers)) {
  const built = readdirSync(libSuppliers).filter((f) => f.endsWith('.js'))
  if (built.length > 0 && !covers('lib/suppliers/opencode.js')) {
    problems.push(`files 白名单漏了 lib/suppliers/*.js（${built.length} 个内置供应商）——scanDir 吞异常，装完会静默零内置供应商`)
  }
}

// ---- 用 npm pack 验一次真实产物名单（唯一不会骗人的检查）----
if (process.argv.includes('--pack')) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--cache', join(root, '.npm-cache')], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  const files = (JSON.parse(out)[0]?.files ?? []).map((f) => f.path)
  const want = ['lib/index.js', 'lib/client.js', 'lib/client-registry.js', 'cordis.patch.yml']
  for (const rel of want) if (!files.includes(rel)) problems.push(`npm pack 产物里缺 ${rel}`)
  const suppliers = files.filter((f) => f.startsWith('lib/suppliers/') && f.endsWith('.js'))
  if (suppliers.length === 0) problems.push('npm pack 产物里缺 lib/suppliers/*.js（内置供应商）')
  else console.log(`✓ npm pack 含 ${suppliers.length} 个内置供应商`)
}

if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${p}`)
  process.exit(1)
}
console.log(`✓ 发布身份一致：${pkg.name}（patch / bundle id / export name 全对）`)
