import { BoltIcon, CardIcon, ClipboardIcon, GiftIcon } from './icons';

const STEPS = [
  { icon: GiftIcon, title: 'Elige tu paquete', text: 'Selecciona el juego y la cantidad que quieres recargar.' },
  { icon: ClipboardIcon, title: 'Ingresa tu ID', text: 'Escribe tu ID de jugador; verificamos antes de cobrar.' },
  { icon: CardIcon, title: 'Realiza tu pago', text: 'Tarjeta, SPEI u OXXO; el precio vigente lo confirma el servidor.' },
  { icon: BoltIcon, title: 'Recibe recarga', text: 'Te avisamos cuando la entrega queda confirmada.' },
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
