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

// ---- 行（子路径模块）：patch ↔ 源码目录 ↔ exports ↔ files ↔ 产物 ----
//
// 「行」= 插件页原生「包含的组件」里的一行，模块说明符是本包子路径
// （`dsh-router-core/suppliers/nvidia`、`dsh-router-core/ext-test`）。它们在
// **同一个 bundle 的 patch 里**，所以本包的发布管道必须为每一行都配齐：
// 源码 `src/<sub>/index.ts` + `row.json` + `locale/`、exports 三件套、files 白名单、
// 构建产物。少一环都是静默降级（行在页面上但标题/加载坏了），所以这里逐项核对。
//
// 为什么以 patch 为准、再反向找「有 row.json 却没声明」的目录：行的定义就是
// 「patch 里声明的子路径」。若只按目录扫（早先只扫 src/suppliers），新增
// `src/ext-test` 这种**不在 suppliers 下**的行会绕过全部闸门 —— 这正是本文件
// 存在的理由，不能再留这个洞。
const rowSubpaths = []
for (const name of nameLines.slice(1)) {
  if (name === pkg.name || !name.startsWith(`${pkg.name}/`)) {
    problems.push(`行的 name '${name}' 既不是核心行也不是本包的子路径（插件页会把它当核心行显示）`)
    continue
  }
  rowSubpaths.push(name.slice(`${pkg.name}/`.length))
}
if (rowSubpaths.length === 0) problems.push('cordis.patch.yml 里一个子路径行都没有')

/** 一个「像行的目录」= 底下有 row.json（那是行独有的清单文件）。 */
function rowJsonDirs(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'row.json')))
    .map((d) => join(dir, d.name))
    .map((p) => relative(root, p)) // 相对仓库根；别手算 root.length（root 带尾斜杠）
    .sort()
}
// 反向：源码里有 row.json 却没有在 patch 声明的行 = 装了也不会生效
for (const base of ['src', join('src', 'suppliers')]) {
  for (const rel of rowJsonDirs(join(root, base))) {
    const sub = rel.replace(/^src\//, '')
    if (!rowSubpaths.includes(sub)) problems.push(`src/${sub}/row.json 存在但 cordis.patch.yml 没声明这一行（装了也不会生效）`)
  }
}

for (const sub of rowSubpaths) {
  const srcDir = join(root, 'src', sub)
  if (!existsSync(join(srcDir, 'index.ts'))) {
    problems.push(`cordis.patch.yml 声明了行 '${sub}'，但 src/${sub}/index.ts 不存在`)
    continue
  }
  // exports 三件套：模块本身 + 它自己的 package.json + locale（插件页读显示信息）
  for (const [key, want] of [
    [`./${sub}`, `./lib/${sub}/index.js`],
    [`./${sub}/package.json`, `./lib/${sub}/package.json`],
    [`./${sub}/locale/*.json`, `./lib/${sub}/locale/*.json`],
  ]) {
    const target = pkg.exports?.[key]
    if (target === undefined) problems.push(`package.json exports 缺 '${key}'（行会静默退化成模块说明符）`)
    else if (typeof target === 'string' ? target !== want : target.default !== want) {
      problems.push(`package.json exports['${key}'] 指向 ${JSON.stringify(target)}，应为 '${want}'`)
    }
  }
  // 行的 package.json 会被宿主按**包作用域**读（它是 lib/<sub>/ 下唯一的
  // package.json，接管该目录），所以有两处硬要求，踩了都是「行加载不了 / 标题读不出」：
  //   1. `name` 必须是合法 npm 包名 —— 写 `dsh-router-core/suppliers/<x>` 这种带斜杠
  //      又没有 scope 的话，Node 直接 ERR_INVALID_PACKAGE_CONFIG（实测）。
  //   2. 必须声明 `"type": "module"` —— 否则该目录下的 index.js 被当成 CJS。
  // 顺带查编码：这份清单是手写的中文 JSON，一旦存成非 UTF-8，Node 读包作用域时
  // JSON.parse 失败，报的还是同一个错（症状离原因极远）。
  const rowJsonPath = join(srcDir, 'row.json')
  if (!existsSync(rowJsonPath)) {
    problems.push(`src/${sub} 缺 row.json（行的显示名/说明靠它）`)
  } else {
    let row = null
    try { row = JSON.parse(readFileSync(rowJsonPath, 'utf8')) }
    catch (error) { problems.push(`src/${sub}/row.json 不是合法 JSON（多半是编码坏了）：${error.message}`) }
    if (row !== null) {
      const name = typeof row.name === 'string' ? row.name : ''
      const valid = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/[a-z0-9-~][a-z0-9-._~]*|[a-z0-9-~][a-z0-9-._~]*)$/.test(name)
      if (!valid) problems.push(`src/${sub}/row.json 的 name '${name}' 不是合法 npm 包名（带斜杠必须有 @scope 前缀）—— Node 读包作用域时会 ERR_INVALID_PACKAGE_CONFIG`)
      if (row.type !== 'module') problems.push(`src/${sub}/row.json 缺 "type": "module"（该目录的 index.js 会被当成 CJS）`)
    }
  }

  // 自描述资源（构建期拷进 lib/<sub>/）
  // 源码侧叫 row.json（子目录里放 package.json 会让 rolldown 解析不了入口），
  // 产物侧才叫 package.json（宿主按它读名字/说明）。
  for (const [srcRel, libRel] of [['row.json', 'package.json'], ['locale/en.json', 'locale/en.json'], ['locale/zh.json', 'locale/zh.json']]) {
    if (!existsSync(join(srcDir, srcRel))) {
      problems.push(`src/${sub} 缺 ${srcRel}（插件页的标题/说明靠它，缺了退化成模块说明符）`)
    }
    if (!covers(`lib/${sub}/${libRel}`)) problems.push(`files 白名单漏了 lib/${sub}/${libRel}`)
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
  for (const sub of rowSubpaths) {
    for (const rel of ['index.js', 'package.json', 'locale/en.json', 'locale/zh.json']) {
      if (!existsSync(join(root, 'lib', sub, rel))) {
        problems.push(`lib/${sub}/${rel} 不存在（构建期拷贝漏了？行会静默退化成模块说明符）`)
      }
    }
  }
}

// ---- 随包发布的文本不许有编码损坏 ----
//
// 为什么要这个：中文文档与字典是手写的，经 shell heredoc 批量改写时很容易被转码
// 破坏，而且**不报任何错** —— 症状是某个字变成「�」或整段乱码，只有肉眼能发现。
// 本会话已经踩到两次（一次在供应商行的 row.json，Node 报 ERR_INVALID_PACKAGE_CONFIG；
// 一次在 README 的一个「的」字）。这里读一遍：非法 UTF-8 或含 U+FFFD 就直接红。
const TEXT_SHIPPED = [
  'cordis.patch.yml',
  'README.md',
  ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
]
for (const sub of rowSubpaths) {
  TEXT_SHIPPED.push(`src/${sub}/row.json`)
  const localeDir = join(root, 'src', sub, 'locale')
  if (existsSync(localeDir)) {
    for (const f of readdirSync(localeDir)) TEXT_SHIPPED.push(`src/${sub}/locale/${f}`)
  }
}
for (const rel of TEXT_SHIPPED) {
  const file = join(root, rel)
  if (!existsSync(file)) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    problems.push(`${rel} 不是合法 UTF-8（多半是某次批量改写时转码坏了）`)
    continue
  }
  if (text.includes('\uFFFD')) problems.push(`${rel} 含替换字符 U+FFFD（有中文被转码破坏）`)
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
  const rowJs = rowSubpaths.map((sub) => join(root, 'lib', sub, 'index.js')).filter((f) => existsSync(f))
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
  for (const sub of rowSubpaths) {
    for (const rel of ['index.js', 'package.json', 'locale/en.json', 'locale/zh.json']) {
      const want = `lib/${sub}/${rel}`
      if (!files.includes(want)) problems.push(`npm pack 产物里缺 ${want}（行少了它就是静默降级）`)
    }
  }
  console.log(`✓ npm pack 含 ${rowSubpaths.length} 个行`)
}

if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${p}`)
  process.exit(1)
}
console.log(`✓ 发布身份一致：${pkg.name}（patch / bundle id / export name 全对）`)
