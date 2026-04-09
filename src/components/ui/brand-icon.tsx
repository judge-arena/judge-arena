/**
 * Judge Arena brand mark — scales of justice icon.
 * Replaces the old "JA" text mark throughout the app.
 */
export function BrandIcon({ size = 32, className }: { size?: number; className?: string }) {
  const r = size / 32; // scale factor
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="Judge Arena"
    >
      <rect width="32" height="32" rx={6 * (size > 20 ? 1 : 0.8)} fill="#E65100" />
      <g
        transform="translate(16,15)"
        stroke="#fff"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="0" cy="-8.5" r="1.4" fill="#fff" stroke="none" />
        <line x1="0" y1="-7" x2="0" y2="8.5" strokeWidth="2" />
        <line x1="-10" y1="-6" x2="10" y2="-6" strokeWidth="2" />
        <line x1="-8.5" y1="-6" x2="-8.5" y2="0" strokeWidth="1.5" />
        <line x1="8.5" y1="-6" x2="8.5" y2="0" strokeWidth="1.5" />
        <path d="M-12 0 Q-8.5 5.5 -5 0" strokeWidth="1.6" fill="none" />
        <path d="M5 0 Q8.5 5.5 12 0" strokeWidth="1.6" fill="none" />
        <line x1="-5" y1="8.5" x2="5" y2="8.5" strokeWidth="2" />
      </g>
    </svg>
  );
}
