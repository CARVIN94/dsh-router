// React 19 类型不再提供全局 `JSX` 命名空间，声明回退到 react 的 JSX 命名空间。
declare namespace JSX {
  type Element = import('react').JSX.Element
}

// CSS 副作用导入的模块声明（vite 产物内联，仅静态类型需要）。
declare module '*.css'

// 宿主 client 座位包不装进本插件的 node_modules（靠 package.json 的
// dsh.client.inject 声明，运行时由宿主的模块表解析），所以这里只补**本插件
// 真正用到的那一个**导出，签名照宿主的 Switch.d.ts 抄。
//
// 代价要说清：这是契约的本地副本，宿主改了签名这里不会自动变红；运行期用的是
// 宿主的真组件，漂移会表现为行为差异而不是构建失败。新增用到别的导出时同理。
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** 开关。checked 完全受控；onChange 收到点击所请求的状态。 */
  export function Switch(props: {
    checked: boolean
    onChange: (next: boolean) => void
    /** 无障碍名，由渲染点自己给。 */
    label: string
    disabled?: boolean
    title?: string
    className?: string
  }): import('react').JSX.Element
}