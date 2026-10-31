import { useEffect, type ReactNode } from 'react'

/** A panel that slides over the page from the right. Closes on Escape, on the close button and on the backdrop. */
export function Drawer({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="drawer-layer">
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header className="drawer-head">
          <h2>{title}</h2>
          <button className="secondary drawer-close" onClick={onClose} aria-label="Close">
            Close
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  )
}
