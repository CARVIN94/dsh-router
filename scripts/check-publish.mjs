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
import { dirname, join, relative, resolve } from 'node:path'
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
const covers = (rel) => {
  // 包根目录的 package.json 永远会随包发布，不需要在白名单里列一遍。
  if (rel === 'package.json') return true
  return patterns.some((p) => {
    // `**` 跨越任意层目录，`*` 只在一段里（`/` 不参与匹配）—— 混为一谈会让
    // `lib/types/**/*.d.ts` 这类模式匹配不到 `lib/types/foo.d.ts`。
    if (p.includes('*')) {
      const re = p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0000')   // 先占位，避免下面的 `*` 规则吃掉
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000\//g, '(?:.*/)?')
        .replace(/\u0000/g, '.*')
      return new RegExp(`^${re}$`).test(rel)
    }
    return p.endsWith('/') ? rel.startsWith(p) : rel === p
  })
}


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

// ---- exports 里声明的每个文件都必须真的产出 ----
//
// 为什么要有：`exports` 是**手写**的，而产物是构建出来的，两边没有任何工具保证同步。
// 实测踩到：三个 `./suppliers/<x>` 的 `types` 指向 `lib/types/suppliers/<x>/index.d.ts`，
// 而 tsconfig.build.json 的 include 没收行源码 → 文件压根不存在。这类声明失效没有
// 任何运行期症状（loader 只看 default），但会把 IDE 与 `tsc` 的下游搞乱。
if (!SOURCE_ONLY && existsSync(join(root, 'lib'))) {
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    for (const [field, target] of Object.entries(typeof value === 'string' ? { default: value } : value)) {
      if (target.includes('*')) continue
      const rel = target.replace(/^\.\//, '')
      if (!existsSync(join(root, rel))) problems.push(`package.json exports['${key}'].${field} 指向 ${target}，但该文件不存在`)
      else if (!covers(rel)) problems.push(`package.json exports['${key}'].${field} 指向 ${target}，但 files 白名单没覆盖它`)
    }
  }
}

// ---- 行产物里的相对引用必须闭环 ----
//
// 为什么要有：行 js 会把共用模块抽成 `lib/<name>-<hash>.js`（内容哈希，随代码变），
// 而那个 chunk **一直不在 files 白名单里**（早先它只是宿主内部依赖，从没被单独引用
// 过）。实测踩到的是更靠前的一种形态：产物来自两次不同的构建 —— 行里写着
// `http-state-C1vb3gW2.js`、磁盘上是 `http-state-CGDexmJf.js`，import 直接
// ERR_MODULE_NOT_FOUND，症状是「行在页面上、但供应商一个都没注册」。
// 这里逐个核对：行引用的每个相对文件都要真实存在，且被 files 白名单覆盖。
if (!SOURCE_ONLY && existsSync(join(root, 'lib'))) {
  const rowJs = supplierDirs.map((dir) => join(root, 'lib', 'suppliers', dir, 'index.js')).filter((f) => existsSync(f))
  const referenced = new Set()
  for (const file of rowJs) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/from\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      // 按**引用方所在目录**解析（`../../http-state-x.js` 只剥一层会得到假路径，
      // 闸门自己先报了个不存在的 lib/../http-state-... —— 实测踩过）。
      const abs = resolve(dirname(file), m[1])
      const rel = relative(join(root, 'lib'), abs)
      if (rel.startsWith('..')) {
        problems.push(`行产物引用了 lib 之外的文件 ${m[1]}（打包后不成立）`)
        continue
      }
      referenced.add(rel)
    }
  }
  for (const rel of [...referenced].sort()) {
    if (!existsSync(join(root, 'lib', rel))) {
      problems.push(`行产物引用了 lib/${rel}，但它不存在 —— 产物来自两次不同的构建？（行会 import 失败，供应商静默不注册）`)
    } else if (!covers(`lib/${rel}`)) {
      problems.push(`行产物引用了 lib/${rel}，但 files 白名单没覆盖它（从 npm 装完就缺这个 chunk）`)
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
