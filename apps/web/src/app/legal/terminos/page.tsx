import type { Metadata } from 'next';
import { legalIdentity, pending } from '../../../lib/legal';

export const metadata: Metadata = {
  title: 'Términos y Condiciones',
  robots: { index: true, follow: true },
  alternates: { canonical: '/legal/terminos' },
};

/** Per request, for the reason spelled out in the aviso de privacidad page. */
export const dynamic = 'force-dynamic';

/**
 * Terms of service.
 *
 * The clauses that matter commercially are the irreversibility of a delivered
 * recharge and the customer's responsibility for the ID they enter — both are
 * stated plainly rather than buried, because the whole point is that a customer
 * cannot later say they were not told.
 */
export default function TermsPage() {
  const id = legalIdentity();

  return (
    <main className="page narrow legal">
      <h1 className="page-title">Términos y Condiciones</h1>
      <p className="hint">Última actualización: septiembre de 2026</p>

      <h2>Quiénes somos</h2>
      <p>
        {id.businessName} es un servicio de recargas de diamantes para Free Fire operado por{' '}
        {pending(id.legalName, 'razón social')}.
      </p>
      <p>
        <strong>No estamos afiliados a Garena ni a Free Fire.</strong> Somos un distribuidor
        independiente. Free Fire y Garena son marcas de sus respectivos dueños.
      </p>

      <h2>Cómo funciona</h2>
      <p>
        Eliges un paquete, escribes tu ID de jugador, te mostramos el nombre de la cuenta para
        que confirmes, pagas, y la recarga se acredita automáticamente en esa cuenta.
      </p>

      <h2>Tu ID de jugador es tu responsabilidad</h2>
      <p>
        Antes de cobrarte te mostramos el <strong>nombre del personaje</strong> asociado al ID
        que escribiste. Al confirmar, aceptas que esa es tu cuenta.
      </p>
      <p>
        <strong>
          Una recarga entregada a un ID equivocado no se puede recuperar, cancelar ni
          reembolsar.
        </strong>{' '}
        Los diamantes quedan en la cuenta que recibió la recarga y no tenemos forma de
        revertirlo. Por eso te pedimos confirmar el nombre antes de pagar.
      </p>

      <h2>Pagos</h2>
      <p>
        Aceptamos transferencia, depósito y los métodos que aparezcan al momento de comprar.
        Tu pedido se procesa cuando confirmamos que el pago llegó por el monto correcto.
      </p>
      <p>
        Si el monto depositado no coincide con el precio del paquete, tu pedido queda en
        revisión y nos ponemos en contacto contigo antes de procesarlo.
      </p>

      <h2>Tiempos de entrega</h2>
      <p>
        La mayoría de las recargas se entregan en minutos. Los paquetes grandes se procesan en
        varias operaciones y pueden tardar un poco más. Si algo falla, tu pedido queda
        registrado y lo resolvemos manualmente; nunca se pierde.
      </p>

      <h2>Devoluciones</h2>
      <p>
        Por tratarse de un producto digital que se acredita de forma inmediata e irreversible
        en tu cuenta de juego,{' '}
        <strong>no hay devoluciones una vez entregada la recarga.</strong>
      </p>
      <p>Sí devolvemos tu dinero cuando:</p>
      <ul>
        <li>Pagaste y no pudimos entregar la recarga.</li>
        <li>Se entregó una cantidad menor a la ofrecida y no pudimos completarla.</li>
        <li>Cancelaste antes de que procesáramos el pedido.</li>
      </ul>

      <h2>Promociones</h2>
      <p>
        Las promociones tienen vigencia limitada y pueden cambiar sin previo aviso. El precio y
        la cantidad de diamantes que aplican son los que aparecen al momento de generar tu
        pedido. Las ofertas marcadas para clientes nuevos están limitadas a una por cuenta de
        Free Fire.
      </p>

      <h2>Uso indebido</h2>
      <p>
        Podemos cancelar pedidos y negar el servicio ante intentos de fraude, comprobantes
        alterados, abuso de promociones o cualquier uso que dañe el servicio o a otros
        usuarios.
      </p>

      <h2>Contacto</h2>
      <p>
        Para cualquier aclaración escríbenos a {pending(id.contactEmail, 'correo de contacto')}
        {id.whatsapp && <> o por WhatsApp al {id.whatsapp}</>}. Ten a la mano tu número de
        pedido.
      </p>
    </main>
  );
}
