'use client';

import { useEffect, useRef, useState } from 'react';

type Mode = 'still' | 'anim' | 'live';

/**
 * Three-tier mascot media, matching the approved mockup's own `.ia-live` pattern:
 * a `.webm` with alpha where the browser supports it, an animated `.webp`
 * fallback for Safari/iOS (which plays webm but ignores its alpha channel) or
 * when the video errors, and a static `.webp` for `prefers-reduced-motion` or
 * while off-screen. Video only plays once the block is actually visible
 * (IntersectionObserver, same 18% threshold as the mockup) and pauses outside
 * the viewport, so six of these on one page don't all run at once.
 */
export function MascotMedia({
  webm,
  animWebp,
  stillSrc,
  alt,
  className,
  ariaHidden,
}: {
  webm: string;
  animWebp: string;
  stillSrc: string;
  alt: string;
  className?: string;
  ariaHidden?: boolean;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<Mode>('still');
  const failedRef = useRef(false);

  useEffect(() => {
    const root = rootRef.current;
    const video = videoRef.current;
    if (!root || !video) return;

    const isSafari = /^((?!chrome|chromium|crios|edg|opr|firefox|fxios|android).)*safari/i.test(
      navigator.userAgent,
    );
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

    const apply = (visible: boolean) => {
      if (reduce.matches || !visible) {
        setMode('still');
        video.pause();
        return;
      }
      if (failedRef.current) {
        setMode('anim');
        video.pause();
        return;
      }
      if (!isSafari) {
        setMode('live');
        const p = video.play();
        if (p?.catch) p.catch(() => {});
        return;
      }
      setMode('anim');
      video.pause();
    };

    const onError = () => {
      failedRef.current = true;
      apply(true);
    };
    video.addEventListener('error', onError);

    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => apply(e.isIntersecting)),
      { threshold: 0.18 },
    );
    io.observe(root);

    const onReduceChange = () => apply(true);
    reduce.addEventListener?.('change', onReduceChange);

    return () => {
      video.removeEventListener('error', onError);
      io.disconnect();
      reduce.removeEventListener?.('change', onReduceChange);
    };
  }, []);

  return (
    <span ref={rootRef} className={className} aria-hidden={ariaHidden}>
      <video
        ref={videoRef}
        className="mm-live"
        style={{ display: mode === 'live' ? 'block' : 'none' }}
        autoPlay
        muted
        loop
        playsInline
        preload="none"
        aria-label={ariaHidden ? undefined : alt}
      >
        <source src={webm} type="video/webm" />
      </video>
      <img
        className="mm-anim"
        style={{ display: mode === 'anim' ? 'block' : 'none' }}
        src={mode === 'anim' ? animWebp : undefined}
        alt=""
        aria-hidden="true"
      />
      <img
        className="mm-still"
        style={{ display: mode === 'still' ? 'block' : 'none' }}
        src={stillSrc}
        alt={ariaHidden ? '' : alt}
        loading="lazy"
        decoding="async"
      />
    </span>
  );
}
