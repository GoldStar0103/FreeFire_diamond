'use client';

import { useEffect, useRef } from 'react';

/**
 * Keeps at most one `<details>` open at a time, like the approved mockup.
 * `toggle` doesn't bubble, so this attaches a listener to each `<details>`
 * directly via a ref rather than a single delegated handler on the wrapper.
 */
export function FaqAccordion({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const items = Array.from(ref.current?.querySelectorAll('details') ?? []);
    const onToggle = (e: Event) => {
      const target = e.target as HTMLDetailsElement;
      if (!target.open) return;
      items.forEach((d) => {
        if (d !== target) d.open = false;
      });
    };
    items.forEach((d) => d.addEventListener('toggle', onToggle));
    return () => items.forEach((d) => d.removeEventListener('toggle', onToggle));
  }, []);

  return (
    <div className="sp-faq" ref={ref}>
      {children}
    </div>
  );
}
