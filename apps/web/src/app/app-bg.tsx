/**
 * Fixed nebula backdrop from the approved redesign home mockup:
 * violet→cyan stage gradient, blurred capsules, floating diamond gems,
 * and four-point sparkles — visible in the side gutters on desktop and
 * behind the page bottom, matching the Netlify design reference.
 */
export function AppBg() {
  return (
    <div className="appbg" aria-hidden="true">
      <div className="appbg-layer appbg-caps">
        <i style={{ width: 150, height: 52, left: '4%', top: '9%', ['--r' as string]: '-24deg', ['--d' as string]: '24s', ['--tx' as string]: '26px', ['--ty' as string]: '-18px' }} />
        <i style={{ width: 96, height: 34, left: '74%', top: '6%', ['--r' as string]: '22deg', ['--d' as string]: '31s', ['--tx' as string]: '-22px', ['--ty' as string]: '30px' }} />
        <i style={{ width: 120, height: 42, left: '12%', top: '46%', ['--r' as string]: '-8deg', ['--d' as string]: '27s', ['--tx' as string]: '18px', ['--ty' as string]: '-24px' }} />
        <i style={{ width: 74, height: 26, left: '86%', top: '38%', ['--r' as string]: '34deg', ['--d' as string]: '22s', ['--tx' as string]: '-14px', ['--ty' as string]: '20px' }} />
        <i style={{ width: 170, height: 58, left: '58%', top: '74%', ['--r' as string]: '-16deg', ['--d' as string]: '29s', ['--tx' as string]: '22px', ['--ty' as string]: '-30px' }} />
        <i style={{ width: 104, height: 36, left: '22%', top: '86%', ['--r' as string]: '12deg', ['--d' as string]: '33s', ['--tx' as string]: '-20px', ['--ty' as string]: '-16px' }} />
        <i style={{ width: 86, height: 30, left: '44%', top: '22%', ['--r' as string]: '-30deg', ['--d' as string]: '25s', ['--tx' as string]: '14px', ['--ty' as string]: '22px' }} />
      </div>
      <div className="appbg-layer appbg-gems">
        <i style={{ left: '8%', top: '16%', ['--s' as string]: '26px', ['--d' as string]: '15s' }} />
        <i style={{ left: '88%', top: '26%', ['--s' as string]: '18px', ['--d' as string]: '12s', animationDelay: '-3s' }} />
        <i style={{ left: '70%', top: '58%', ['--s' as string]: '32px', ['--d' as string]: '17s', animationDelay: '-6s' }} />
        <i style={{ left: '18%', top: '66%', ['--s' as string]: '20px', ['--d' as string]: '13s', animationDelay: '-2s' }} />
        <i style={{ left: '52%', top: '40%', ['--s' as string]: '15px', ['--d' as string]: '11s', animationDelay: '-4s' }} />
        <i style={{ left: '34%', top: '8%', ['--s' as string]: '22px', ['--d' as string]: '16s', animationDelay: '-8s' }} />
        <i style={{ left: '80%', top: '84%', ['--s' as string]: '24px', ['--d' as string]: '14s', animationDelay: '-5s' }} />
      </div>
      <div className="appbg-layer appbg-sparks">
        <i style={{ left: '16%', top: '24%', ['--s' as string]: '12px', ['--d' as string]: '4.2s' }} />
        <i style={{ left: '62%', top: '14%', ['--s' as string]: '9px', ['--d' as string]: '5.4s', animationDelay: '-1.4s' }} />
        <i style={{ left: '82%', top: '48%', ['--s' as string]: '14px', ['--d' as string]: '3.8s', animationDelay: '-2.2s' }} />
        <i style={{ left: '28%', top: '54%', ['--s' as string]: '10px', ['--d' as string]: '6.1s', animationDelay: '-0.8s' }} />
        <i style={{ left: '48%', top: '78%', ['--s' as string]: '11px', ['--d' as string]: '4.8s', animationDelay: '-3s' }} />
        <i style={{ left: '92%', top: '70%', ['--s' as string]: '8px', ['--d' as string]: '5.2s', animationDelay: '-1s' }} />
        <i style={{ left: '6%', top: '80%', ['--s' as string]: '13px', ['--d' as string]: '4.4s', animationDelay: '-2.6s' }} />
        <i style={{ left: '70%', top: '34%', ['--s' as string]: '9px', ['--d' as string]: '5.8s', animationDelay: '-3.6s' }} />
      </div>
    </div>
  );
}
