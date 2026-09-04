// React 19 类型不再提供全局 `JSX` 命名空间，声明回退到 react 的 JSX 命名空间。
declare namespace JSX {
  type Element = import('react').JSX.Element
}

// CSS 副作用导入的模块声明（vite 产物内联，仅静态类型需要）。
declare module '*.css'