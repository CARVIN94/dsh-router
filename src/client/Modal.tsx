/**
 * 通用弹窗：遮罩 + 居中对话框，ESC / 点遮罩关闭。9router 风格。
 */
import { useEffect } from 'react'

interface ModalProps {
  title: string
  onClose: () => void
  children: React.ReactNode
  /** 是否允许点遮罩/ESC 关闭（默认 true）。 */
  dismissable?: boolean
  /** 附加到 dshr-modal 的类名（如加宽）。 */
  className?: string
}

export function Modal({ title, onClose, children, dismissable = true, className = '' }: ModalProps): JSX.Element {
  useEffect(() => {
    if (!dismissable) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, dismissable])

  return (
    <div
      className="dshr-modalOverlay"
      onClick={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose()
      }}
    >
      <div className={`dshr-modal${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dshr-modalHead">
          <div className="dshr-modalTitle">{title}</div>
          <button type="button" className="dshr-modalClose" onClick={onClose} aria-label="关闭">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="dshr-modalBody">{children}</div>
      </div>
    </div>
  )
}
