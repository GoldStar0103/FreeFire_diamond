import type { Metadata } from 'next';
import { supportUrl } from '../../lib/support';
import { legalIdentity } from '../../lib/legal';
import {
  AlertIcon,
  ChatIcon,
  CheckIcon,
  ClockIcon,
  MailIcon,
  RefreshIcon,
  UserIcon,
} from '../icons';
import { MascotMedia } from '../mascot-media';
import { SiteHeader } from '../site-header';
import { FaqAccordion } from './faq-accordion';
import soporteStill from '../../assets/mascot/soporte-still.webp';

export const metadata: Metadata = {
  title: 'Soporte',
  description: 'Soporte de LevelUp Store: WhatsApp 24/7, preguntas frecuentes, correo y reporte de problemas.',
  alternates: { canonical: '/soporte' },
};

const FAQ = [
  {
    q: '¿Cómo recargo mis diamantes?',
    a: 'Elige tu paquete, escribe tu ID de Free Fire y confirma que el nombre que te mostramos es el tuyo. Después paga con tarjeta o por transferencia — en cuanto se confirme el pago, la recarga entra sola a tu cuenta.',
  },
  {
    q: '¿Cuánto tarda en llegar mi recarga?',
    a: 'Pagando con tarjeta, casi siempre son segundos. Pagando por transferencia, en cuanto validamos tu comprobante — normalmente unos minutos, pero puede tardar más si escribes fuera de horario. Puedes seguir el estado en cualquier momento desde tu enlace de pedido.',
  },
  {
    q: '¿Necesito dar mi contraseña?',
    a: 'Nunca. La recarga entra directo a tu cuenta con tu ID de jugador — no necesitamos, ni queremos, tus datos de acceso a Free Fire.',
  },
  {
    q: '¿Qué métodos de pago aceptan?',
    a: 'Transferencia bancaria y depósito en OXXO, además de tarjeta de crédito o débito. Los datos para pagar aparecen al momento de comprar.',
  },
  {
    q: '¿Qué hago si no llega mi recarga?',
    a: 'Escríbenos por WhatsApp con tu número de pedido. Si algo salió mal, ya lo estamos revisando de tu lado antes de que nos escribas — pero contactarnos siempre ayuda a resolverlo más rápido.',
  },
] as const;

export default function SupportPage() {
  const chatUrl = supportUrl('Hola, tengo una pregunta sobre mi recarga.') ?? '#';
  const problemUrl = supportUrl('Hola, tengo un problema con mi recarga.') ?? '#';
  const { contactEmail } = legalIdentity();
  const email = contactEmail ?? 'contactolevelupmexico@gmail.com';

  return (
    <main className="page sp">
      <SiteHeader />

      <section className="sp-head" aria-labelledby="sp-titulo">
        <span className="sp-eyebrow">
          <i aria-hidden="true" />
          Soporte
        </span>
        <h1 id="sp-titulo">Soporte</h1>
        <p>¿Necesitas ayuda? Estamos aquí para ti.</p>
        <MascotMedia
          className="sp-head-mascot"
          webm="/mascot/soporte-luchador.webm"
          animWebp="/mascot/soporte-luchador-anim.webp"
          stillSrc={soporteStill.src}
          alt="Luchador de LevelUp saludando y listo para ayudar"
        />
      </section>

      <section className="sp-wa-card" aria-labelledby="sp-wa">
        <h2 id="sp-wa">
          <ChatIcon className="icon" />
          Soporte por WhatsApp
        </h2>
        <ul>
          <li>
            <CheckIcon className="icon" />
            Respuesta en minutos
          </li>
          <li>
            <CheckIcon className="icon" />
            Atención 24/7
          </li>
          <li>
            <CheckIcon className="icon" />
            Te ayudamos en todo el proceso
          </li>
        </ul>
        <a className="sp-btn-wa" href={chatUrl} target="_blank" rel="noreferrer">
          Chatear ahora
          <span aria-hidden="true">→</span>
        </a>
      </section>

      <div className="sp-mini-row">
        <div className="sp-mini">
          <span className="sp-mini-ic" aria-hidden="true">
            <ClockIcon className="icon" />
          </span>
          <b>Tiempo de respuesta</b>
          <span>1 - 5 min.</span>
        </div>
        <div className="sp-mini">
          <span className="sp-mini-ic" aria-hidden="true">
            <RefreshIcon className="icon" />
          </span>
          <b>Atención 24/7</b>
          <span>Siempre activos</span>
        </div>
        <div className="sp-mini">
          <span className="sp-mini-ic" aria-hidden="true">
            <UserIcon className="icon" />
          </span>
          <b>Asesoría personalizada</b>
          <span>Te guiamos</span>
        </div>
      </div>

      <div className="sp-titulo-bloque">
        <h2>Preguntas frecuentes</h2>
        <span className="sp-line" aria-hidden="true" />
      </div>

      <FaqAccordion>
        {FAQ.map((item) => (
          <details key={item.q}>
            <summary>
              {item.q}
              <span className="sp-mas" aria-hidden="true">
                +
              </span>
            </summary>
            <div className="sp-resp">{item.a}</div>
          </details>
        ))}
      </FaqAccordion>

      <div className="sp-contacto">
        <a className="sp-cc" href={`mailto:${email}`}>
          <MailIcon className="icon" />
          <b>Enviar correo</b>
          <span>{email}</span>
        </a>
        <a className="sp-cc" href={problemUrl} target="_blank" rel="noreferrer">
          <AlertIcon className="icon" />
          <b>Reportar un problema</b>
          <span>Te ayudamos</span>
        </a>
      </div>
    </main>
  );
}
