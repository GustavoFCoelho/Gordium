import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type MenuItem =
  | { label: string; icon?: ReactNode; danger?: boolean; onClick(): void }
  | 'separator'

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

/** Menu do botão direito, no ponto do clique; fecha ao clicar fora, Esc ou rolar. */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })

  // Não deixa o menu sair da janela.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      x: Math.min(menu.x, window.innerWidth - width - 8),
      y: Math.min(menu.y, window.innerHeight - height - 8)
    })
  }, [menu])

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('wheel', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="context-sep" />
        ) : (
          <button
            key={i}
            className={item.danger ? 'danger' : ''}
            onClick={() => {
              onClose()
              item.onClick()
            }}
          >
            <span className="ellipsis">{item.label}</span>
            {item.icon}
          </button>
        )
      )}
    </div>
  )
}
