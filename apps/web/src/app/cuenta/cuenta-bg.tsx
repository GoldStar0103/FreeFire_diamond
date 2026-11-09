/**
 * Full-bleed neon background video for Mi cuenta / Level Pass — from the
 * approved redesign package (Jose's Klickpin clip). Fixed behind the page;
 * reduced-motion visitors get the solid fallback only.
 */
export function CuentaBg() {
  return (
    <div className="mc-bg" aria-hidden="true">
      <video
        className="mc-bgvid"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        poster="/mascot/cuenta-fondo-poster.webp"
        tabIndex={-1}
      >
        <source src="/mascot/cuenta-fondo.mp4" type="video/mp4" />
      </video>
    </div>
  );
}
