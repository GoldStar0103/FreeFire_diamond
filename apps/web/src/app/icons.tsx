/**
 * Small outline icons, hand-rolled instead of emoji.
 *
 * Raw Unicode emoji (🛡️⚡🔒🎧) render differently on every platform — flat and
 * grey on some Android builds, an odd size next to text on Windows — which is
 * a small thing but a real one on a page whose whole job is to look like a
 * business you can trust with your money. A shared, consistently-styled icon
 * set reads as designed rather than assembled from whatever the keyboard
 * offered, and `currentColor` lets each usage pick its own accent from the
 * site's existing palette rather than being stuck with whatever color a
 * given emoji happens to render in.
 *
 * Deliberately not a dependency: this is a dozen simple outline shapes, and
 * pulling in an icon library for that would be a lot of package for a little
 * SVG.
 */

type IconProps = { className?: string };

const base = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export function BoltIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
    </svg>
  );
}

export function ShieldIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function LockIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="4.5" y="11" width="15" height="9" rx="2" />
      <path d="M7.5 11V7.5a4.5 4.5 0 0 1 9 0V11" />
    </svg>
  );
}

export function HeadsetIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 13v-1a8 8 0 0 1 16 0v1" />
      <rect x="3" y="13" width="4" height="6" rx="1.5" />
      <rect x="17" y="13" width="4" height="6" rx="1.5" />
      <path d="M19 19v1a3 3 0 0 1-3 3h-2" />
    </svg>
  );
}

export function HomeIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="m4 11 8-7 8 7" />
      <path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" />
      <path d="M10 20v-6h4v6" />
    </svg>
  );
}

export function GiftIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="3.5" y="9" width="17" height="12" rx="1.5" />
      <path d="M3.5 13h17" />
      <path d="M12 9v12" />
      <path d="M12 9C9 9 8 7 8 5.5A2.5 2.5 0 0 1 12 4c0 .8-.3 3.2-4 5Z" />
      <path d="M12 9c3 0 4-2 4-3.5A2.5 2.5 0 0 0 12 4c0 .8.3 3.2 4 5Z" />
    </svg>
  );
}

export function GemMark({ className }: IconProps) {
  return (
    <svg {...base} className={className} viewBox="0 0 24 24">
      <path d="M6.2 4.5h11.6L21 9.2 12 20.5 3 9.2 6.2 4.5Z" fill="currentColor" stroke="none" opacity="0.95" />
      <path d="M6.2 4.5 12 20.5 17.8 4.5" />
      <path d="M3 9.2h18" />
    </svg>
  );
}

export function ChestMark({ className }: IconProps) {
  return (
    <svg {...base} className={className} viewBox="0 0 24 24">
      <rect x="3.5" y="9" width="17" height="11" rx="2" />
      <path d="M3.5 13h17" />
      <path d="M12 13v4" />
      <rect x="10.2" y="15.2" width="3.6" height="2.4" rx="0.6" />
      <path d="M7 9V7.2A5 5 0 0 1 17 7.2V9" />
    </svg>
  );
}

export function DiamondIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M6.5 3h11L21 8.5 12 21 3 8.5 6.5 3Z" />
      <path d="M3 8.5h18" />
      <path d="m8.5 3 3.5 18 3.5-18" />
    </svg>
  );
}

export function ClipboardIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="5.5" y="4.5" width="13" height="17" rx="2" />
      <rect x="9" y="3" width="6" height="3" rx="1" />
      <path d="M9 12h6" />
      <path d="M9 16h6" />
    </svg>
  );
}

export function BankIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M3 10 12 4l9 6" />
      <path d="M5 10v9M9.5 10v9M14.5 10v9M19 10v9" />
      <path d="M3 19h18" />
    </svg>
  );
}

export function StoreIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 9V6l1.5-2h13L20 6v3" />
      <path d="M4 9a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0" />
      <path d="M5 9v11h14V9" />
      <path d="M10 20v-5.5h4V20" />
    </svg>
  );
}

export function CardIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="2.5" y="5.5" width="19" height="13" rx="2" />
      <path d="M2.5 10h19" />
      <path d="M6 14.5h4" />
    </svg>
  );
}

export function ClockIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function MoonIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
    </svg>
  );
}

export function ChatIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 5.5h16v11H9l-4 3.5v-3.5H4v-11Z" />
      <path d="M8 10h8M8 13h5" />
    </svg>
  );
}

export function MailIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="m3.5 6 8.5 7 8.5-7" />
    </svg>
  );
}

export function UserIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7" />
    </svg>
  );
}

export function AlertIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 10v4" />
      <path d="M12 17.2v.1" />
    </svg>
  );
}

/** "Garantía de por vida" — the ∞ shape, not a clock or a badge, is the point. */
export function InfinityIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M7 9a3.5 3.5 0 1 0 0 7c1.9 0 3.2-1.6 5-4.5C13.8 8.6 15.1 7 17 7a3.5 3.5 0 1 1 0 7c-1.9 0-3.2-1.6-5-4.5" />
    </svg>
  );
}

export function FacebookIcon({ className }: IconProps) {
  return (
    <svg {...base} fill="currentColor" stroke="none" className={className}>
      <path d="M14 9h2.5V5.5h-2.5c-2.2 0-4 1.8-4 4V12H8v3.5h2v6.4c.65.07 1.32.1 2 .1s1.35-.03 2-.1v-6.4h2.6l.4-3.5H14v-2c0-.55.45-1 1-1Z" />
    </svg>
  );
}

export function InstagramIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17" cy="7" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function TikTokIcon({ className }: IconProps) {
  return (
    <svg {...base} fill="currentColor" stroke="none" className={className}>
      <path d="M16.5 3h-3v13a2.6 2.6 0 1 1-2-2.53v-3.06a5.6 5.6 0 1 0 5 5.57V9.9a7.4 7.4 0 0 0 4 1.18v-3a4.4 4.4 0 0 1-4-4.4V3Z" />
    </svg>
  );
}
