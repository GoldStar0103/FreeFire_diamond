import { OG_LOGO_DATA_URL } from './og-logo-data';

/**
 * The logo badge for the link-preview images: the art cropped to a circle
 * inside a ring of the brand gradient, as on the home page.
 *
 * A plain function returning an element rather than a component, because
 * satori is not React: what it is handed is laid out as-is, and keeping this
 * a value avoids depending on how it treats function components.
 *
 * No glow around it, unlike the site. The card is a PNG, and a soft shadow
 * over a gradient is close to incompressible: it added a third to what the
 * logo already costs. WhatsApp is widely reported to drop preview images much
 * over 300 KB, and a preview with no image is worse than one with no glow.
 * With the logo the site card is about 240 KB, up from about 160 KB.
 *
 * `size` is the diameter of the art; the ring adds `RING` on each side.
 */
const RING = 5;

export function ogLogo(size: number) {
  return (
    <div
      style={{
        display: 'flex',
        padding: RING,
        borderRadius: size,
        background: 'linear-gradient(135deg, #a78bfa, #22d3ee)',
      }}
    >
      <img
        src={OG_LOGO_DATA_URL}
        width={size}
        height={size}
        alt=""
        style={{ borderRadius: size / 2 }}
      />
    </div>
  );
}
