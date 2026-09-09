# 扩展插件开发

扩展插件是**独立的 DSH 插件(npm 包)**,只提供**差异化能力**:怎么改写一条 bash 命令。
装好后出现在「设置 → 路由 → 扩展」,每个一个开关。

数据目录是 `<profile>/data/`,**不跟进程 cwd 跑**——从任何目录启动 `dsh web`
读到的都是同一份配置(见 `src/data-dir.ts`)。

参考实现:[dsh-router-ext-rtk](https://github.com/CARVIN94/dsh-router-ext-rtk)
(把命令改写成 `rtk <cmd>` 压缩输出)。

## 分工:拦截归核心,插件只管改写

| | 谁负责 |
|---|---|
| 持有 `router.ext` 共享表 | 核心 |
| 在 `tools/execute` 拦截 bash 调用 | 核心 |
| 按 enabled / ready 裁决、命中则短路执行 | 核心 |
| 开启自检(不可用时拒绝开启) | 核心 |
| 面板渲染、开关交互 | 核心 |
| **怎么改写一条命令**(`rewrite`) | **插件** |
| **自己是否可用**(`getState().ready`) | **插件** |
| 开关状态持久化(`<dataDir>/ext.json`) | 核心 |

关键推论:**插件不挂 `tools/execute` 监听、不遍历工具、不写响应**。
多个插件各自挂监听会互相踩、顺序不可控,所以收敛到核心一处委派。

## 契约

注册到 `router.ext` 表的对象就是这几个成员:

```ts
interface RouterExt {
  readonly id: string            // 唯一 id(注册键,如 'rtk')
  readonly name: string          // 面板显示名(如 'RTK')
  readonly description?: string  // 面板内容区说明
  rewrite(command: string): RewriteResult
  getState(): ExtState
  dispose?(): void
}

type RewriteResult = { rewritten: string } | { rewritten: null }

// 只报「运行时事实」,不报开关、不持久化
interface ExtState {
  ready: boolean    // 运行时是否就绪;false 时即使开启也不改写
  detail?: string   // 不就绪时的说明,面板红字显示
}
```

**插件没有 `setEnabled`,也不存开关。** 开关由核心持久化到
`<dataDir>/ext.json`(按 id:`{ "rtk": { "enabled": true } }`),默认关。
插件是被调用方,只回答"这条命令改成啥"和"我现在能不能用"。

### `rewrite(command)`:热路径,必须同步

在工具派发**热路径内联**调用:

- **必须同步返回**(`execFileSync` 可以,不能 `await fetch`)
- **不能抛**——抛了核心会跳过这个扩展器(不会崩,但本次不改写)
- 不能做网络 / 文件 IO
- 返回 `{ rewritten }` → 核心用改写后的命令执行并短路;返回 `{ rewritten: null }` → 原样执行

拿不到改写就返回 null。这是常态,不是错误:大部分命令本来就没有等价改写。

### `getState()`:只报运行时事实

- `ready: true` 才能改写;`false` 表示运行时不可用(如没装 rtk)。核心据此:
  - 面板开关**禁用**,点不开
  - 即使绕过面板直连 API 开启,核心也**拒 409** 并带上 `detail`
  - 面板内容区用红字显示 `detail`
- **不报 `enabled`、不持久化任何东西** —— 开关在核心
- 建议在插件**启动时**就探测一次(而不是等第一次 `rewrite`),让面板首屏就有状态

> 旧版本插件曾自己把开关写在 `enhance.json`。现在核心读 `ext.json`,
> 历史上开着的会在首次启动时自动迁移过去(旧文件保留不删)。

## 注册:共享聚合表

cordis 每个 service name 只允许一个插件 `provide`,所以扩展插件**不要自己
`provide('router.ext')`** —— 核心已持有空表,插件 `inject` 等它出现后追加进同一个
live 对象,再广播一次 `internal/service` 触发核心重扫。**与加载顺序无关**。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { currentExts } from './contract.ts'

export const name = 'my-ext'

export function apply(ctx: Context): void {
  ctx.inject(['router.ext'], (sctx) => {
    const exts = currentExts(sctx)
    if (!exts) return undefined
    if (exts['my-ext']) return undefined // 已注册

    // 注意:不传数据目录 —— 开关归核心存,插件无状态。
    const ext = createMyExt()
    exts['my-ext'] = ext
    ctx.emit('internal/service', 'router.ext', exts)

    return () => {          // 卸载清理
      ext.dispose?.()
      delete exts['my-ext']
    }
  })
}
```

`currentExts` 帮你从 context 取表(`ctx.get('router.ext')` 或 `ctx.router.ext`)。
契约在扩展包里**自含一份副本**(不能 import dsh-router 的 src,否则安装期要拉整个
路由核心)——改契约必须**两处同步**,鸭子类型,tsc 抓不到跨仓漂移。

## 插件包结构

最小结构(照 `dsh-router-ext-rtk`):

```
src/
  index.ts      插件入口,经 router.ext 注册扩展器
  rtk.ts        扩展器实现(rewrite / getState / 探活)—— 无状态,不存开关
  contract.ts   router.ext 契约副本(与核心同步)
  *.test.ts     测试
package.json    需声明 dsh.bundle.patch,否则不会被加入 profile bundles
cordis.patch.yml
tsdown.config.ts
```

> 插件**不需要数据目录**:开关在核心的 `<dataDir>/ext.json`。
> 插件若真有自己要存的东西再另说,但开关别自己存。

`package.json` 关键项:

```json
{
  "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" }
}
```

## 核心侧两个坑(写在核心,但影响插件行为)

### `ctx.tools.get(name)` 必须带 agent scope

bash 工具注册在 **agent scope** 里,核心委派时查工具必须传 `exec.agent`:

```ts
tools.get('bash', exec.agent)  // ✅
tools.get('bash')              // ❌ 只查全局视图,查不到 → 静默走原样,从不改写
```

症状极具迷惑性:wrapper 被触发、command 是正常字符串、扩展器 enabled+ready 齐全,
但从不改写。

### 改写发生在一次已授权的调用内

核心在 `tools/execute` 拦截,此时 sandbox 审批 / guard 等前置已在该调用的
prepare 阶段完成。改写只是换命令字符串,**不绕过任何审批**。

## 自检与降级:失败一律放行

扩展器是**增强**,不是门禁。任何一步出问题都必须退回原样执行:

- 命令不是非空字符串 → 放行
- 表里没扩展器 → 放行
- 都不命中改写 → 放行
- 拿不到 bash 工具 → 放行
- `rewrite` 抛错 → 跳过该扩展器,继续下一个

命令**永不因扩展而失败**。

## 验证

判定代理是否真的生效(以 RTK 为例):

```bash
# 1) 看 API:扩展器 enabled / ready 是否都为 true
curl -s http://127.0.0.1:3080/router/api/ext

# 2) 跑一条有等价改写的命令,看输出是否变成压缩格式
ls                 # 被改写时是 rtk 树形格式,不是原生列表

# 3) rtk 自己的统计(rtk rewrite 查询本身不计入)
rtk gain
```

`tools/execute` 是 scope-filtered 事件,但只要插件 context 不在某个 agent scope 下
(`scopeOf(ctx) === undefined`),就能收到所有 agent 的派发——这是 hook 插件的常规用法。

## 加载顺序

核心 `apply` 里同步 `ctx.provide('router.ext', {})`,扩展插件 `inject` 等它。
所以:

- 先装核心、后装插件 → `provide` 时插件的 `inject` 回调被触发
- 先装插件、后装核心 → 插件 `inject` 挂起,核心 `provide` 后触发

两条路径都能注册成功,顺序无关。卸载时插件的清理函数从表里删掉自己的键。
