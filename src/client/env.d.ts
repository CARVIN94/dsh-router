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

  /**
   * 按钮。variant 各自对应宿主的 `--dsw-alias-button-*` token 家族，size `md`
   * 是 36px 控件 / 12px 圆角（`sm` 是 28px / 8px）。原生 button 属性透传。
   */
  export function Button(props: {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    /** 前置 16px 图标。 */
    icon?: import('react').ReactNode
    className?: string
    children?: import('react').ReactNode
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
    /** 原生 button 属性透传，所以 title 等标准属性可用。 */
    title?: string
    onClick?: () => void
  }): import('react').JSX.Element
}