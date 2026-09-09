import type { Metadata } from 'next';
import { legalIdentity, pending } from '../../../lib/legal';

export const metadata: Metadata = {
  title: 'Aviso de Privacidad — LevelUp Store',
  robots: { index: true, follow: true },
};

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
        tarjetas bancarias. Cuando pagas con tarjeta, esos datos los procesa directamente la
        pasarela de pagos y nunca pasan por nuestros servidores.
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
        proveedor de recargas y nuestra pasarela de pagos, en la medida estrictamente
        necesaria para completar tu compra, o cuando una autoridad lo requiera legalmente.
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

      <h2>Cookies y medición</h2>
      <p>
        Usamos herramientas de medición para entender cómo se usa el sitio y evaluar nuestra
        publicidad. Puedes desactivar las cookies desde tu navegador; el sitio seguirá
        funcionando.
      </p>

      <h2>Cambios a este aviso</h2>
      <p>
        Cualquier cambio se publicará en esta misma página, en {id.domain}, con la fecha de
        actualización.
      </p>
    </main>
  );
}
