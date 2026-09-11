import type { Metadata } from 'next';
import { legalIdentity, pending } from '../../../lib/legal';

export const metadata: Metadata = {
  title: 'Aviso de Privacidad',
  robots: { index: true, follow: true },
  alternates: { canonical: '/legal/privacidad' },
};

/**
 * Rendered per request, not prerendered.
 *
 * The identity below comes from the environment, and a static page would bake
 * in whatever was set at BUILD time. A Docker image built without the LEGAL_*
 * variables — the normal case, since those are runtime configuration — would
 * ship a privacy notice reading "[PENDIENTE: RFC]" that no restart could fix.
 * This page is read a handful of times a month; rendering it per request costs
 * nothing worth having.
 */
export const dynamic = 'force-dynamic';

/**
 * Aviso de Privacidad Simplificado, per the LFPDPPP.
 *
 * Written to match what this system actually collects and does — a boilerplate
 * notice describing data handling that does not happen is not compliance. It
 * still needs review by a Mexican lawyer before launch; that is flagged to the
 * client, not buried here.
 */
export default function PrivacyPage() {
  const id = legalIdentity();

  return (
    <main className="page narrow legal">
      <h1 className="page-title">Aviso de Privacidad</h1>
      <p className="hint">Última actualización: septiembre de 2026</p>

      <h2>Responsable de tus datos</h2>
      <p>
        {pending(id.legalName, 'razón social')} (“{id.businessName}”), con RFC{' '}
        {pending(id.rfc, 'RFC')} y domicilio en {pending(id.address, 'domicilio fiscal')}, es
        responsable del tratamiento de tus datos personales.
      </p>

      <h2>Qué datos recabamos</h2>
      <p>Únicamente lo necesario para entregarte tu recarga:</p>
      <ul>
        <li>
          <strong>Tu ID de jugador de Free Fire</strong> y el nombre público asociado a esa
          cuenta.
        </li>
        <li>
          <strong>Tu comprobante de pago</strong>, cuando pagas por transferencia o depósito.
        </li>
        <li>
          <strong>Tu número de WhatsApp o correo</strong>, si decides dárnoslo para avisarte
          del estado de tu pedido. Es opcional.
        </li>
        <li>
          <strong>Datos técnicos</strong> de la visita: dirección IP y navegador, para
          seguridad y prevención de abuso.
        </li>
      </ul>
      <p>
        <strong>No pedimos ni almacenamos tu contraseña de Free Fire</strong>, ni datos de
        tarjetas bancarias. Cuando pagas con tarjeta o en OXXO a través de Stripe, esos datos
        los procesa directamente Stripe en su propia página segura y nunca pasan por nuestros
        servidores.
      </p>

      <h2>Para qué los usamos</h2>
      <ul>
        <li>Procesar y entregar tu recarga.</li>
        <li>Verificar tu pago y atender aclaraciones.</li>
        <li>Informarte del estado de tu pedido.</li>
        <li>Prevenir fraude y uso abusivo del servicio.</li>
        <li>Cumplir obligaciones fiscales y legales.</li>
      </ul>
      <p>
        No vendemos ni rentamos tus datos. No los compartimos con terceros salvo con nuestro
        proveedor de recargas y nuestra pasarela de pagos (Stripe), en la medida estrictamente
        necesaria para completar tu compra; con Meta y TikTok, para medir nuestra publicidad,
        como se explica en «Cookies y medición»; o cuando una autoridad lo requiera legalmente.
      </p>

      <h2>Cuánto tiempo los conservamos</h2>
      <p>
        Conservamos el registro de tus pedidos mientras sea necesario para atender
        aclaraciones y cumplir obligaciones fiscales. Los comprobantes de pago se conservan
        junto con el pedido correspondiente.
      </p>

      <h2>Tus derechos ARCO</h2>
      <p>
        Puedes solicitar el <strong>Acceso</strong>, <strong>Rectificación</strong>,{' '}
        <strong>Cancelación</strong> u <strong>Oposición</strong> al tratamiento de tus datos,
        así como revocar tu consentimiento, escribiendo a{' '}
        {pending(id.contactEmail, 'correo de contacto')}
        {id.whatsapp && <> o por WhatsApp al {id.whatsapp}</>}. Te responderemos en los plazos
        que marca la ley.
      </p>

      {/* Written to match the code, like the rest of this notice. The two
          pixels are not symmetrical: Meta also gets a server-side report from
          the worker, TikTok gets only what its Pixel sees in the browser. If
          TikTok's Events API is ever wired up, this section has to change with
          it. Page addresses are mentioned because both pixels send them, and
          the order page's address carries the order number and player ID. */}
      <h2>Cookies y medición</h2>
      <p>
        Usamos el Píxel de Meta (Facebook e Instagram) y el Píxel de TikTok para saber qué
        anuncios traen compras. Los dos guardan cookies en tu navegador y, desde ahí, les
        avisan a Meta y a TikTok qué páginas de este sitio visitas (la de tu pedido incluye tu
        número de pedido y tu ID de jugador) y cuándo ves un paquete, empiezas a pagar o
        completas una compra, con el monto y el paquete. Esa información sale directamente de
        tu navegador, junto con tu dirección IP y los datos de tu navegador.
      </p>
      <p>
        Además, cuando se confirma el pago de un pedido, enviamos a Meta desde nuestros
        servidores un aviso de la compra (monto, paquete y fecha) junto con tu dirección IP, tu
        navegador, las cookies de su Píxel y, cifrados de forma irreversible, tu ID de jugador y
        tu WhatsApp si nos lo diste. A TikTok no le enviamos nada desde nuestros servidores:
        solo recibe lo que su Píxel registra en tu navegador. Meta y TikTok usan estos datos
        para medir y mejorar nuestros anuncios; ninguno recibe tu comprobante ni datos de
        tarjeta.
      </p>
      <p>
        Puedes desactivar las cookies desde tu navegador y el sitio seguirá funcionando. Para
        oponerte al envío a Meta de los datos de tu compra, escríbenos al correo de contacto
        indicado arriba.
      </p>

      <h2>Cambios a este aviso</h2>
      <p>
        Cualquier cambio se publicará en esta misma página, en {id.domain}, con la fecha de
        actualización.
      </p>
    </main>
  );
}
