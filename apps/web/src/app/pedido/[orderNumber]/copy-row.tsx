'use client';

/** Same tap-to-copy row as the checkout page's CLABE/OXXO fields — the order page is a Server Component, so this needs its own small client piece for the clipboard button. */
export function CopyRow({ label, value, display }: { label: string; value: string; display: string }) {
  return (
    <div className="pay-row">
      <span>{label}</span>
      <span className="pay-copy">
        <strong className="mono">{display}</strong>
        <button
          type="button"
          className="copy-btn"
          aria-label={`Copiar ${label}`}
          onClick={() => {
            navigator.clipboard?.writeText(value).catch(() => {
              /* Clipboard access can be denied; the value is still on screen to copy by hand. */
            });
          }}
        >
          📋
        </button>
      </span>
    </div>
  );
}
