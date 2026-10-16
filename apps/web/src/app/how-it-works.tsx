import { BoltIcon, CardIcon, ClipboardIcon, GiftIcon } from './icons';
import easy from '../assets/mascot/easy.webp';

const STEPS = [
  { icon: GiftIcon, title: 'Elige tu paquete', text: 'Selecciona el juego, la cantidad o el paquete con su precio actual.' },
  { icon: ClipboardIcon, title: 'Ingresa tu ID', text: 'Coloca tu ID de Free Fire y confírmalo antes de pagar.' },
  { icon: CardIcon, title: 'Realiza tu pago', text: 'Elige un método de pago disponible y completa el cobro.' },
  { icon: BoltIcon, title: 'Recibe tu recarga', text: 'Los diamantes llegan cuando la entrega queda confirmada.' },
] as const;

/** Shared between the homepage and every /promocion page — same 4 steps, same order. */
export function HowItWorks() {
  return (
    <section className="hm-how">
      <div className="hm-section-head">
        <div>
          <h2 className="section-title-lg">
            ¿Cómo <span className="grad">funciona</span>?
          </h2>
          <p className="hm-how-sub">Tu recarga en 4 simples pasos</p>
        </div>
        <div className="hm-callout">
          <span className="hm-bubble">¡Es muy fácil!</span>
          <img src={easy.src} alt="" width={88} height={96} decoding="async" loading="lazy" />
        </div>
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
