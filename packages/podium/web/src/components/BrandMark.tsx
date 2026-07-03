/**
 * The Symphony brand mark: a conductor's downbeat — a bold stroke tracing the
 * ictus gesture with the baton tip leading as a bright node. Matches the
 * favicon and the online app avatar.
 *
 * The mark carries its own indigo gradient tile, so `.brand-mark` only sizes
 * and clips it (no background of its own).
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={className ?? "brand-mark"} aria-hidden>
      <svg viewBox="0 0 512 512" width="100%" height="100%" role="img" aria-label="Symphony">
        <defs>
          <linearGradient id="bm-bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#818cf8" />
            <stop offset="1" stopColor="#4338ca" />
          </linearGradient>
          <linearGradient id="bm-stroke" x1="150" y1="120" x2="380" y2="392" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#c7d2fe" />
          </linearGradient>
        </defs>
        <rect width="512" height="512" rx="112" fill="url(#bm-bg)" />
        <path
          d="M168 128 L232 320 C244 356 300 356 320 316 L372 208"
          fill="none"
          stroke="url(#bm-stroke)"
          strokeWidth="40"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="168" cy="128" r="30" fill="#fff" />
        <circle cx="372" cy="208" r="18" fill="#fff" fillOpacity="0.55" />
      </svg>
    </span>
  );
}
