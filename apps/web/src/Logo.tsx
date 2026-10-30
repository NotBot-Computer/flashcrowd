/**
 * The FlashCrowd mark: three people holding hands in a ring, a lightning bolt in the middle. Flat, in the page's
 * colours. The heads are outlined in the background colour so they cut into the ring.
 */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo-mark">
      <circle cx="32" cy="35" r="20" fill="none" stroke="var(--muted)" strokeWidth="5" />
      <g fill="var(--text-2)" stroke="var(--sidebar)" strokeWidth="3">
        <circle cx="32" cy="12" r="7.5" />
        <circle cx="12" cy="27" r="7" />
        <circle cx="52" cy="27" r="7" />
      </g>
      <path d="M37 20 L22 39 H31 L26 55 L43 33 H34 L39 20 Z" fill="var(--text)" />
    </svg>
  )
}

export function Logo() {
  return (
    <span className="logo">
      <LogoMark />
      <span className="logo-word">FlashCrowd</span>
    </span>
  )
}
