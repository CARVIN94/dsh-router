# 扩展插件开发

扩展插件是**独立的 DSH 插件(npm 包)**,只提供**差异化能力** —— 目前是改写一条
bash 命令。装好后出现在「设置 → 路由 → 扩展」,**开关不在那里** —— 启停的唯一入口是
官方插件页「设置 → 插件 → dsh-router-core」详情页的「路由组件」一节;面板这一页只列
已启用的扩展,只读。

**dsh-router 核心只做管理面,不做拦截。** 扩展插件自己挂监听、自己裁决、自己短路
(2026-09 重构,见下)。

数据目录是 `<profile>/data/`,**不跟进程 cwd 跑**——从任何目录启动 `dsh web`
读到的都是同一份配置(见 `src/data-dir.ts`)。

## 扩展详情页可以自带内容

扩展详情页默认是一张**写死的只读页**(名字、id、状态、一段说明)。扩展若想在详情里放
自己的交互(要选的模型、要跑的测试、要看的诊断),可以按**扩展 id** 登记一个面板组件
(`src/client/ext-panels.ts` 的 `registerExtPanel`):登记后 `ExtDetail` 用你的组件渲染
整个内容区,没登记才落回那张通用只读页。组件**不收 props** —— 面板的渲染点只有详情页
一处。核心自带的 `插件自检` 就是这么做的。

⚠️ **目前这张注册表在 dsh-router 自己的 client bundle 内部,外部插件包还引不到它**:
`dsh-router-core/client` 是整个 client 入口(一个注册座位的 CJS 闭包),并不导出
`registerExtPanel`。要让外部插件也能自带面板,需要给它加一个真正的导出路径
(如 `./client/panels`)。这是已知的升级路径,不是现在就能用的写法 —— 照着现有 exports
去 `import { registerExtPanel } from 'dsh-router-core/client'` 会拿到 undefined。

参考实现:[dsh-router-ext-rtk](https://github.com/CARVIN94/dsh-router-ext-rtk)
(把命令改写成 `rtk <cmd>` 压缩输出)。

## 分工:管理归核心,执行归插件

| | 谁负责 |
|---|---|
| 持有 `router.ext` 注册表(发现) | 核心 |
| 面板渲染、开关交互、`/router/api/ext` | 核心 |
| **开关状态 + 插件数据落盘**(`router.extStore` → `<dataDir>/ext.json`) | **核心** |
| 开启自检(不可用时拒绝开启,插件页那一面的开关禁用) | 核心 |
| **挂 `tools/execute` 拦截** | **插件** |
| **按 enabled / ready 裁决、命中则短路执行** | **插件** |
| **怎么改写一条命令** | **插件**(私有,不在契约里) |
| **自己是否可用**(`getState().ready`) | **插件** |

**插件不自己 file IO。** 落盘位置由核心用 `dataDirOf(ctx.baseUrl)` 锚定,插件经
`router.extStore` service 读写(`isEnabled` / `setEnabled` / `readData` / `writeData`),
同一文件、同一次原子写。插件无状态。

### 为什么拦截从核心挪到插件

`tools/execute` 是任何插件都能自己挂的 around-dispatch waterfall(插件 ctx 不在 agent
scope 下就能收到全部派发)。核心代挂在**只有一个消费者**时是纯亏损:为留 40 行委派
逻辑,付了共享表 + inject 广播 + 契约两处同步的代价。核心归位成管理面后,扩展插件与
dsh-router 只在**注册表 + 存储**两处耦合。

> ponytail: 天花板 —— 核心代挂原本顺带解决「多个扩展插件各自挂监听会互相踩 / 顺序
> 不可控」。这个保护现在没了。目前只有 rtk 一家消费,无所谓;**第二家 ext 出现时要
> 重新收敛顺序**(升级路径:核心暴露一个按顺序委派的共享工具方法,而不是收回拦截)。

## 契约

注册到 `router.ext` 表的对象是**纯声明 + 状态**:

```ts
interface RouterExt {
  readonly id: string            // 唯一 id(注册键,如 'rtk')
  readonly name: string          // 面板显示名(如 'RTK')
  readonly description?: string  // 面板内容区说明
  readonly icon?: string         // 卡片/详情图标 URL
  readonly source?: 'builtin'    // 标了 = 随核心分发(见下);不标 = 独立插件
  getState(): ExtState           // 运行时事实
  dispose?(): void
}

// 只报「运行时事实」,不报开关
interface ExtState {
  ready: boolean    // 运行时是否就绪;false 时即使开启也不生效
  detail?: string   // 不就绪时的说明,面板红字显示
}
```

**没有 `rewrite`。** 怎么改命令是插件的实现细节,核心不感知、不调用。

**`source: 'builtin'`** 标的是「随核心分发」。这类扩展同时是插件页原生「包含的组件」
里的**一行**(自带宿主管的开关,关一行 = loader 不 import 它),因此插件页那个自绘的
「路由组件」节**只列独立安装的扩展**,不把它们重复列一遍。判定只认这一个字段,没有别的
连带影响。

插件经 `router.extStore` 读写(核心 provide):

```ts
interface ExtStoreService {
  isEnabled(id: string): boolean
  setEnabled(id: string, enabled: boolean): void
  readData<T = unknown>(id: string): T | undefined   // 插件自己的数据抽屉
  writeData(id: string, value: unknown): void
}
```

落盘形状(`<dataDir>/ext.json`):

```json
{ "rtk": { "enabled": true, "data": { "...插件自己的东西..." } } }
```

**插件没有 `setEnabled` 的职责,也不自己存开关。** 开关由核心持久化(默认关),
插件是被调用方:自己问 `isEnabled`、自己按 ready 裁决。

### `getState()`:只报运行时事实

- `ready: true` 才能生效;`false` 表示运行时不可用(如没装 rtk)。核心据此:
  - 插件页的开关**禁用**,点不开
  - 即使绕过界面直连 API 开启,核心也**拒 409** 并带上 `detail`
  - 面板「扩展」页用红字显示 `detail`
- **不报 `enabled`** —— 开关在核心
- 建议在插件**启动时**就探测一次(而不是等第一次拦截),让面板首屏就有状态

> 旧版本插件曾自己把开关写在 `enhance.json`。现在核心读 `ext.json`,
> 历史上开着的会在首次启动时自动迁移过去(旧文件保留不删)。

## 注册:共享聚合表

cordis 每个 service name 只允许一个插件 `provide`,所以扩展插件**不要自己
`provide('router.ext')`** —— 核心已持有空表,插件 `inject` 等它出现后追加进同一个
live 对象,再广播一次 `internal/service` 触发核心重扫。**与加载顺序无关**。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { currentExts, currentExtStore } from './contract.ts'

export const name = 'my-ext'

export function apply(ctx: Context): void {
  ctx.inject(['router.ext'], (sctx) => {
    const exts = currentExts(sctx)
    if (!exts) return undefined
    if (exts['my-ext']) return undefined // 已注册

    const ext = createMyExt()
    exts['my-ext'] = ext
    ctx.emit('internal/service', 'router.ext', exts)

    // 执行面:自己挂拦截。开关问核心存储,ready 问自己。
    const store = currentExtStore(sctx)
    const unmount = mountMyIntercept(ctx, () => store?.isEnabled('my-ext') === true, () => ext.getState().ready)

    return () => {          // 卸载清理
      unmount()
      ext.dispose?.()
      delete exts['my-ext']
    }
  })
}
```

`currentExts` / `currentExtStore` 帮你从 context 取服务(`ctx.get(...)` 或 `ctx.router.*`)。
契约在扩展包里**自含一份副本**(不能 import dsh-router 的 src,否则安装期要拉整个
路由核心)——改契约必须**两处同步**,鸭子类型,tsc 抓不到跨仓漂移。

## 插件包结构

最小结构(照 `dsh-router-ext-rtk`):

```
src/
  index.ts       插件入口,经 router.ext 注册 + 自挂拦截
  intercept.ts   拦截实现(挂 tools/execute、裁决、短路)—— 无状态,不存开关
  rtk.ts         扩展器实现(改写 + 探活)—— 无状态
  contract.ts    router.ext 契约副本(与核心同步)
  *.test.ts      测试
package.json     需声明 dsh.bundle.patch,否则不会被加入 profile bundles
cordis.patch.yml
tsdown.config.ts
```

> 插件**不需要数据目录**:开关与数据在核心的 `<dataDir>/ext.json`,
> 经 `router.extStore` 读写。别自己开文件。

`package.json` 关键项:

```json
{
  "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" }
}
```

## 自挂拦截:两个坑(原在核心,现归插件,必须守住)

### `ctx.tools.get(name)` 必须带 agent scope

bash 工具注册在 **agent scope** 里,查工具必须传 `exec.agent`:

```ts
tools.get('bash', exec.agent)  // ✅
tools.get('bash')              // ❌ 只查全局视图,查不到 → 静默走原样,从不改写
```

症状极具迷惑性:wrapper 被触发、command 是正常字符串、开关 enabled + ready 齐全,
但从不改写。这条知识原先在核心一处,现在每个自挂拦截的插件各守一份 —— 抄漏了就是
「开关全开但从不生效」(已在 `dsh-router-ext-rtk/src/intercept.ts` 文件头 + 测试锁定)。

### 改写发生在一次已授权的调用内

核心改为插件自挂后语义不变:`tools/execute` 拦截时 sandbox 审批 / guard 等前置已在
该调用的 prepare 阶段完成。改写只是换命令字符串,**不绕过任何审批**。

## 自检与降级:失败一律放行

扩展器是**增强**,不是门禁。任何一步出问题都必须退回原样执行:

- 命令不是非空字符串 → 放行
- 开关未开 / 插件未就绪 → 放行
- 不命中改写 → 放行
- 拿不到 bash 工具 → 放行
- 执行抛错 → 转成 error envelope,不向外抛

命令**永不因扩展而失败**。

## 验证

判定代理是否真的生效(以 RTK 为例):

```bash
# 1) 看 API:扩展器 enabled / ready 是否都为 true
curl -s http://127.0.0.1:3080/router/api/ext   # 端口 = 宿主页端口(面板可见),非 3080 的通道要换

# 2) 跑一条有等价改写的命令,看输出是否变成压缩格式
ls                 # 被改写时是 rtk 树形格式,不是原生列表

# 3) rtk 自己的统计(rtk rewrite 查询本身不计入)
rtk gain
```

`tools/execute` 是 scope-filtered 事件,但只要插件 context 不在某个 agent scope 下
(`scopeOf(ctx) === undefined`),就能收到所有 agent 的派发——这是 hook 插件的常规用法。

## 加载顺序

核心 `apply` 里同步 `ctx.provide('router.ext', {})` 与 `ctx.provide('router.extStore', ...)`,
扩展插件 `inject` 等它。所以:

- 先装核心、后装插件 → `provide` 时插件的 `inject` 回调被触发
- 先装插件、后装核心 → 插件 `inject` 挂起,核心 `provide` 后触发

两条路径都能注册成功,顺序无关。拦截在 `inject` 回调内挂起(注册 → 拦截),所以存储
就绪前不会有半开的拦截窗口。卸载时插件的清理函数从表里删掉自己的键并注销监听。
