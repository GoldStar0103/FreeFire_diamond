'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Horizontal scroll-snap carousel for testimonials, matching the approved
 * mockup's `.rev-track`/`.rev-dots`/`.rev-arrow` — a plain scrollable row
 * (works with no JS at all) with dots and prev/next buttons layered on top
 * as a progressive enhancement.
 */
export function ReviewsCarousel({ children, count }: { children: React.ReactNode; count: number }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const onScroll = () => {
      const card = track.children[0] as HTMLElement | undefined;
      if (!card) return;
      const step = card.getBoundingClientRect().width + 12;
      setActive(Math.round(track.scrollLeft / step));
    };
    track.addEventListener('scroll', onScroll, { passive: true });
    return () => track.removeEventListener('scroll', onScroll);
  }, []);

  const move = (dir: 1 | -1) => {
    const track = trackRef.current;
    if (!track) return;
    const card = track.children[0] as HTMLElement | undefined;
    const step = (card?.getBoundingClientRect().width ?? 0) + 12;
    track.scrollBy({ left: dir * step, behavior: 'smooth' });
  };

  return (
    <div className="cf-rev-wrap">
      <div className="cf-rev-track" ref={trackRef} tabIndex={0} aria-label="Reseñas de clientes, desplazar para ver más">
        {children}
      </div>
      <div className="cf-rev-nav">
        <button type="button" className="cf-rev-arrow" aria-label="Reseña anterior" disabled={active <= 0} onClick={() => move(-1)}>
          ←
        </button>
        <div className="cf-rev-dots" aria-hidden="true">
          {Array.from({ length: count }, (_, i) => (
            <i key={i} className={i === active ? 'on' : ''} />
          ))}
        </div>
        <button
          type="button"
          className="cf-rev-arrow"
          aria-label="Reseña siguiente"
          disabled={active >= count - 1}
          onClick={() => move(1)}
        >
          →
        </button>
      </div>
    </div>
  );
}
