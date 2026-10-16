'use client';

import { useEffect, useState } from 'react';
import type { StaticImageData } from 'next/image';
import { usePrefersReducedMotion } from './use-reduced-motion';
import box from '../assets/mascot/box.webp';
import celebrate from '../assets/mascot/celebrate.webp';
import diamonds from '../assets/mascot/diamonds.webp';
import easy from '../assets/mascot/easy.webp';
import hugDiamond from '../assets/mascot/hug-diamond.webp';
import idle from '../assets/mascot/idle.webp';
import laptop from '../assets/mascot/laptop.webp';
import phone from '../assets/mascot/phone.webp';
import present from '../assets/mascot/present.webp';
import sad from '../assets/mascot/sad.webp';
import shrug from '../assets/mascot/shrug.webp';
import steps from '../assets/mascot/steps.webp';
import success from '../assets/mascot/success.webp';
import thumbs from '../assets/mascot/thumbs.webp';
import wave from '../assets/mascot/wave.webp';
import welcome from '../assets/mascot/welcome.webp';
import wink from '../assets/mascot/wink.webp';

export const MASCOT = {
  idle,
  welcome,
  present,
  wave,
  wink,
  thumbs,
  phone,
  laptop,
  steps,
  easy,
  success,
  celebrate,
  diamonds,
  box,
  shrug,
  sad,
  'hug-diamond': hugDiamond,
} as const satisfies Record<string, StaticImageData>;

export type MascotPose = keyof typeof MASCOT;

export const HOME_IDLE: readonly MascotPose[] = ['idle', 'welcome', 'diamonds', 'wink'];
export const LOGIN_IDLE: readonly MascotPose[] = ['idle', 'welcome', 'wave'];
export const PASS_IDLE: readonly MascotPose[] = ['hug-diamond', 'diamonds'];
export const SHOP_IDLE: readonly MascotPose[] = ['box', 'wink', 'phone'];
export const HELP_IDLE: readonly MascotPose[] = ['wave', 'welcome', 'laptop'];

type Size = 'hero' | 'scene' | 'inline';

interface Props {
  pose?: MascotPose;
  cycle?: readonly MascotPose[];
  interval?: number;
  size?: Size;
  className?: string;
}

/**
 * Brand character (Jose’s sticker sheets + standing idle).
 *
 * idle     rest / home
 * welcome  login, greet
 * diamonds Level Pass / vault open
 * box      shop
 * phone    checkout
 * steps    how-it-works
 * wave     support
 * celebrate ranking
 * shrug    empty / 404
 * sad      error
 * thumbs / success  done
 *
 * Painted Free Fire / vault-room files do not go here — those are .lu-scene
 * illustrations when Jose sends them. `prefers-reduced-motion` freezes on
 * the first frame — same contract as CountUp and the CSS loops.
 */
export function Mascot({
  pose = 'idle',
  cycle,
  interval = 3800,
  size = 'hero',
  className,
}: Props) {
  const reduced = usePrefersReducedMotion();
  const frames = cycle && cycle.length > 0 ? cycle : [pose];
  const [index, setIndex] = useState(0);
  const [leaving, setLeaving] = useState<MascotPose | null>(null);

  useEffect(() => {
    if (reduced || frames.length < 2) return;
    const id = window.setInterval(() => {
      setIndex((current) => {
        setLeaving(frames[current]!);
        return (current + 1) % frames.length;
      });
    }, interval);
    return () => window.clearInterval(id);
  }, [reduced, frames, interval]);

  const current = frames[reduced ? 0 : index] ?? pose;
  const src = MASCOT[current].src;

  return (
    <div className={`lu-mascot lu-mascot-${size}${className ? ` ${className}` : ''}`} aria-hidden="true">
      <div className="lu-mascot-stage">
        {leaving && leaving !== current && (
          <img
            key={`out-${leaving}`}
            className="lu-mascot-frame out"
            src={MASCOT[leaving].src}
            alt=""
            decoding="async"
            onAnimationEnd={() => setLeaving(null)}
          />
        )}
        <img key={`in-${current}`} className="lu-mascot-frame in" src={src} alt="" decoding="async" />
      </div>
    </div>
  );
}
