import { BoltIcon, CardIcon, ClipboardIcon, GiftIcon } from './icons';

const STEPS = [
  { icon: GiftIcon, title: 'Elige tu paquete', text: 'Selecciona la cantidad de diamantes que quieras.' },
  { icon: ClipboardIcon, title: 'Ingresa tu ID', text: 'Coloca tu ID de Free Fire y confírmalo.' },
  { icon: CardIcon, title: 'Realiza tu pago', text: 'Elige tu método de pago favorito.' },
  { icon: BoltIcon, title: 'Recibe tus diamantes', text: '¡Listo! Los diamantes se reflejan en tu cuenta.' },
] as const;

/**
 * Shared between the homepage and every /promocion page — same 4 steps, same
 * order. `mascot` is optional and only the homepage passes one, so /promocion
 * pages render exactly as before.
 */
export function HowItWorks({ mascot }: { mascot?: React.ReactNode } = {}) {
  return (
    <section>
      {/* Same 1fr | auto head as the mockup `.steps-head` and the why-section
          monkey: title (+ sub) on the left, mascot pinned to the right. */}
      <div className={mascot ? 'hm-steps-head' : 'row'} style={mascot ? undefined : { marginBottom: 12 }}>
        <h2 className="section-title-lg" style={{ margin: 0 }}>
          ¿Cómo <span className="grad">funciona</span>?
          {mascot ? (
            <span className="hm-steps-sub">Tu recarga en 4 simples pasos</span>
          ) : null}
        </h2>
        {mascot ? (
          mascot
        ) : (
          <>
            <div className="spacer" />
            <span className="hint" style={{ margin: 0 }}>
              Tu recarga en 4 simples pasos
            </span>
          </>
        )}
      </div>
      <div className="steps-grid">
        {STEPS.map(({ icon: Icon, title, text }) => (
          <div key={title} className="card step-card">
            <div className="step-card-icon">
              <Icon className="icon" />
            </div>
            <h3>{title}</h3>
            <p>{text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
