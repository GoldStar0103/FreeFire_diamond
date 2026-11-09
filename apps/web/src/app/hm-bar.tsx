'use client';

import { useEffect, useState } from 'react';

/**
 * Sticky header chrome. On the homepage (`fadeOnScroll`), opacity eases out
 * once the page leaves the top and comes back only at scrollY ≈ 0 — matching
 * the "hide while browsing, show at the top" behaviour the client asked for.
 */
export function HmBar({
  children,
  fadeOnScroll = false,
}: {
  children: React.ReactNode;
  fadeOnScroll?: boolean;
}) {
  const [away, setAway] = useState(false);

  useEffect(() => {
    if (!fadeOnScroll) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      // Only the true top brings it back — a few px of overscroll shouldn't
      // count as "still at the top".
      setAway(window.scrollY > 16);
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [fadeOnScroll]);

  return (
    <header className={`hm-bar${fadeOnScroll && away ? ' hm-bar-away' : ''}`}>{children}</header>
  );
}
