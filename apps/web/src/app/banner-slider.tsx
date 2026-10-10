'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from './use-reduced-motion';

const SLIDE_MS = 3500;

export interface BannerSlide {
  src: string;
  alt: string;
}

interface Props {
  slides: BannerSlide[];
}

/**
 * The hero banner: advances on its own every 3.5s, and stops for good the
 * moment the visitor taps it — the client was explicit that this is a
 * one-way stop, not a pause/resume toggle, so a distracted thumb never fights
 * the timer for control of what is on screen.
 *
 * Never auto-advances at all when the visitor's OS asks for reduced motion —
 * same as every CSS @keyframes animation elsewhere in this app, just enforced
 * in JS since this motion comes from a timer, not a keyframe rule.
 */
export function BannerSlider({ slides }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [stopped, setStopped] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (stopped || reducedMotion || slides.length < 2) return;
    timer.current = setInterval(() => {
      setIndex((i) => (i + 1) % slides.length);
    }, SLIDE_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [stopped, reducedMotion, slides.length]);

  if (slides.length === 0) return null;

  return (
    <div className="banner-slider" onClick={() => setStopped(true)} role="group" aria-label="Promociones">
      {slides.map((slide, i) => (
        <img
          key={slide.src}
          className="banner-slide"
          src={slide.src}
          alt={slide.alt}
          decoding="async"
          loading={i === 0 ? 'eager' : 'lazy'}
          style={{ opacity: i === index ? 1 : 0 }}
        />
      ))}
      {slides.length > 1 && (
        <div className="banner-dots">
          {slides.map((slide, i) => (
            <span key={slide.src} className={`banner-dot ${i === index ? 'active' : ''}`} />
          ))}
        </div>
      )}
    </div>
  );
}
