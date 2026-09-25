/**
 * 发布前的身份一致性 + 白名单完整性检查。
 *
 * 为什么要这个：DSH 插件有**三处必须逐字对上的名字**，跨文件却没有任何工具
 * 能保证它们同步（鸭子类型 + YAML，tsc 抓不到）：
 *
 *   1. package.json 的 `name`（npm 装出来的目录名）
 *   2. cordis.patch.yml 里**核心行**的 `name`（loader 拿它去 `import(name)`，
 *      客户端 client-modules 拿它去 `require.resolve(name + '/package.json')`
 *      定位 client bundle）
 *   3. client bundle 注册的 id（DSH_CLIENT_ID，必须等于入参 2，否则
 *      `arrive()` 抛 bundle loaded without registering "<entry name>"）
 *
 * 曾经 package.json 改名 dsh-router-core（npm 上 dsh-router 被抢注）而
 * 2、3 没跟着改，表现是「从 npm 装完加载不到 / 设置页不存在」——症状离原因
 * 极远，必须机器拦。
 *
 * 同一个文件的第二个职责：**内置供应商行**。它们是 patch 里的子路径模块说明符
 * （`dsh-router-core/suppliers/<x>`），而宿主的插件页按**完整说明符的子路径**
 * 读行的显示信息（`<子路径>/package.json` + `<子路径>/locale/*.json`）。这条链
 * 跨了 4 个地方（patch / tsdown 入口 / package.json exports / files 白名单 /
 * 构建期拷贝），少一环都是**静默**降级：行还在、能开关，只是标题退化成模块
 * 说明符。所以在这里一次拦全 —— 少一个文件、exports 少一条、patch 与源码目录
 * 对不上，都直接变红。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []

/**
 * `--source` = 只查源码侧（patch / exports / files 白名单 / 源码清单），
 * 跳过一切要读 `lib/` 的断言。
 *
 * 为什么要分两趟：build 脚本在 `rm -rf lib` **之前**先查一次。产物类断言若也在
 * 那一趟跑，一次半成品构建（比如刚改了入口键、产物还是旧的）就会把后续真正能
 * 修好它的构建**锁死** —— 越修越坏。产物只在构建**之后**那次查。
 */
const SOURCE_ONLY = process.argv.includes('--source')

/** `files` 白名单是否覆盖某个产物相对路径（glob 语义：`/` 结尾=目录前缀，`*`=任意段）。 */
const patterns = pkg.files ?? []
const covers = (rel) =>
  patterns.some((p) =>
    p.endsWith('/**') ? rel.startsWith(p.slice(0, -2)) :
    p.includes('*') ? new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(rel) :
    p.endsWith('/') ? rel.startsWith(p) : rel === p)


// ---- 1/2/3：名字必须一致 ----
const patchText = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
// 只取 insert 行里的 name（`id:` 是配置树句柄，随便取；`name:` 才是模块说明符）
const nameLines = [...patchText.matchAll(/^\s+name:\s*'([^']+)'/gm)].map((m) => m[1])
if (nameLines.length === 0) {
  problems.push('cordis.patch.yml 里一个 name 都没有（核心行必须显式声明）')
} else if (nameLines[0] !== pkg.name) {
  problems.push(`cordis.patch.yml 的首个 name '${nameLines[0]}' ≠ package.json 的 name '${pkg.name}'（loader 拿它 import 模块，必须逐字相同）`)
}

// ---- 内置供应商行：patch ↔ 源码目录 ↔ exports ↔ files ↔ 产物 ----
const supplierDirs = readdirSync(join(root, 'src', 'suppliers'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, 'src', 'suppliers', d.name, 'index.ts')))
  .map((d) => d.name)
  .sort()
if (supplierDirs.length === 0) problems.push('src/suppliers 下没有任何供应商行（index.ts）')

const patchSuppliers = nameLines.slice(1).map((n) => n.replace(`${pkg.name}/suppliers/`, ''))
for (const name of nameLines.slice(1)) {
  if (!name.startsWith(`${pkg.name}/suppliers/`)) {
    problems.push(`供应商行的 name '${name}' 不在 ${pkg.name}/suppliers/ 下（那不是供应商行，插件页会把它当核心行显示）`)
  }
}
for (const dir of supplierDirs) {
  if (!patchSuppliers.includes(dir)) problems.push(`src/suppliers/${dir}/index.ts 没有在 cordis.patch.yml 里声明成行（装了也不会生效）`)
}
for (const dir of patchSuppliers) {
  if (!supplierDirs.includes(dir)) problems.push(`cordis.patch.yml 声明了供应商行 '${dir}'，但 src/suppliers/${dir}/index.ts 不存在`)
}
for (const dir of supplierDirs) {
  // exports 三件套：模块本身 + 它自己的 package.json + locale（插件页读显示信息）
  for (const [key, want] of [
    [`./suppliers/${dir}`, `./lib/suppliers/${dir}/index.js`],
    [`./suppliers/${dir}/package.json`, `./lib/suppliers/${dir}/package.json`],
    [`./suppliers/${dir}/locale/*.json`, `./lib/suppliers/${dir}/locale/*.json`],
  ]) {
    const target = pkg.exports?.[key]
    if (target === undefined) problems.push(`package.json exports 缺 '${key}'（行会静默退化成模块说明符）`)
    else if (typeof target === 'string' ? target !== want : target.default !== want) {
      problems.push(`package.json exports['${key}'] 指向 ${JSON.stringify(target)}，应为 '${want}'`)
    }
  }
  // 行的 package.json 会被宿主按**包作用域**读（它是 lib/suppliers/<dir>/ 下唯一的
  // package.json，接管该目录），所以有两处硬要求，踩了都是「行加载不了 / 标题读不出」：
  //   1. `name` 必须是合法 npm 包名 —— 写 `dsh-router-core/suppliers/<x>` 这种带斜杠
  //      又没有 scope 的话，Node 直接 ERR_INVALID_PACKAGE_CONFIG（实测）。
  //   2. 必须声明 `"type": "module"` —— 否则该目录下的 index.js 被当成 CJS。
  // 顺带查编码：这份清单是手写的中文 JSON，一旦存成非 UTF-8，Node 读包作用域时
  // JSON.parse 失败，报的还是同一个错（症状离原因极远）。
  const rowJsonPath = join(root, 'src', 'suppliers', dir, 'row.json')
  if (existsSync(rowJsonPath)) {
    let row = null
    try { row = JSON.parse(readFileSync(rowJsonPath, 'utf8')) }
    catch (error) { problems.push(`src/suppliers/${dir}/row.json 不是合法 JSON（多半是编码坏了）：${error.message}`) }
    if (row !== null) {
      const name = typeof row.name === 'string' ? row.name : ''
      const valid = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/[a-z0-9-~][a-z0-9-._~]*|[a-z0-9-~][a-z0-9-._~]*)$/.test(name)
      if (!valid) problems.push(`src/suppliers/${dir}/row.json 的 name '${name}' 不是合法 npm 包名（带斜杠必须有 @scope 前缀）—— Node 读包作用域时会 ERR_INVALID_PACKAGE_CONFIG`)
      if (row.type !== 'module') problems.push(`src/suppliers/${dir}/row.json 缺 "type": "module"（该目录的 index.js 会被当成 CJS）`)
    }
  }

  // 自描述资源（构建期拷进 lib/suppliers/<dir>/）
  // 源码侧叫 row.json（子目录里放 package.json 会让 rolldown 解析不了入口），
  // 产物侧才叫 package.json（宿主按它读名字/说明）。
  for (const [srcRel, libRel] of [['row.json', 'package.json'], ['locale/en.json', 'locale/en.json'], ['locale/zh.json', 'locale/zh.json']]) {
    if (!existsSync(join(root, 'src', 'suppliers', dir, srcRel))) {
      problems.push(`src/suppliers/${dir} 缺 ${srcRel}（插件页的标题/说明靠它，缺了退化成模块说明符）`)
    }
    if (!covers(`lib/suppliers/${dir}/${libRel}`)) problems.push(`files 白名单漏了 lib/suppliers/${dir}/${libRel}`)
  }
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
if (SOURCE_ONLY) {
  console.log('· --source：跳过产物断言（构建前那一趟）')
} else if (existsSync(clientJs)) {
  const built = (await readFile(clientJs, 'utf8')).match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/)?.[1]
  if (built === undefined) problems.push('lib/client.js 里找不到 __ModuleLoader__ 注册 id')
  else if (built !== pkg.name) problems.push(`lib/client.js 注册 id '${built}' ≠ '${pkg.name}'（旧产物？重新 npm run build）`)
} else {
  console.log('· 跳过产物检查：lib/client.js 不存在（还没构建）')
}

const required = ['cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/client-registry.js']
for (const rel of required) if (!covers(rel)) problems.push(`files 白名单漏了运行时必需文件 ${rel}`)

// 产物：每个行的 js + 自描述资源都必须真在 lib 里（构建期拷贝漏了就是静默降级）
if (!SOURCE_ONLY) {
  for (const dir of supplierDirs) {
    for (const rel of ['index.js', 'package.json', 'locale/en.json', 'locale/zh.json']) {
      if (!existsSync(join(root, 'lib', 'suppliers', dir, rel))) {
        problems.push(`lib/suppliers/${dir}/${rel} 不存在（构建期拷贝漏了？行会静默退化成模块说明符）`)
      }
    }
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
  for (const dir of supplierDirs) {
    for (const rel of ['index.js', 'package.json', 'locale/en.json', 'locale/zh.json']) {
      const want = `lib/suppliers/${dir}/${rel}`
      if (!files.includes(want)) problems.push(`npm pack 产物里缺 ${want}（供应商行少了它就是静默降级）`)
    }
  }
  console.log(`✓ npm pack 含 ${supplierDirs.length} 个供应商行`)
}

if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${p}`)
  process.exit(1)
}
console.log(`✓ 发布身份一致：${pkg.name}（patch / bundle id / export name 全对）`)
