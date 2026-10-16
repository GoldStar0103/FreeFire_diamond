import { BoltIcon, CardIcon, ClipboardIcon, GiftIcon } from './icons';

const STEPS = [
  { icon: GiftIcon, title: 'Elige tu paquete', text: 'Selecciona la cantidad de diamantes que quieras.' },
  { icon: ClipboardIcon, title: 'Ingresa tu ID', text: 'Coloca tu ID de Free Fire y confírmalo.' },
  { icon: CardIcon, title: 'Realiza tu pago', text: 'Elige tu método de pago favorito.' },
  { icon: BoltIcon, title: 'Recibe tus diamantes', text: '¡Listo! Los diamantes se reflejan en tu cuenta.' },
] as const;

/** Shared between the homepage and every /promocion page — same 4 steps, same order. */
export function HowItWorks() {
  return (
    <section>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 className="section-title-lg" style={{ margin: 0 }}>
          ¿Cómo <span className="grad">funciona</span>?
        </h2>
        <div className="spacer" />
        <span className="hint" style={{ margin: 0 }}>
          Tu recarga en 4 simples pasos
        </span>
      </div>
      <div className="steps-grid">
        {STEPS.map(({ icon: Icon, title, text }, i) => (
          <div key={title} className="card step-card">
            <div className="step-card-num">{i + 1}</div>
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
