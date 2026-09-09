import { listTestimonials } from '@levelup/db';
import { db } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { TestimonialsForm } from './testimonials-form';

export const dynamic = 'force-dynamic';

/**
 * Testimonials for the trust page.
 *
 * These exist because the storefront's job is convincing someone who has been
 * scammed before. That only works if the quotes are real — invented reviews on
 * a page about trustworthiness are the exact opposite of the thing being
 * claimed, and in this market they get spotted. Hence a screen for the client
 * to paste real WhatsApp messages into, rather than copy baked into the code.
 */
export default async function TestimonialsPage() {
  await requireSession();

  const existing = await listTestimonials(db);

  return (
    <>
      <h1 style={{ marginBottom: 0 }}>Testimonios</h1>
      <p className="subtitle">
        Aparecen en la página de <strong>Confianza</strong> de la tienda.
      </p>

      <div className="card">
        <p style={{ margin: 0, fontSize: 14 }}>
          Usa comentarios <strong>reales</strong> de tus clientes, tal como te los mandaron por
          WhatsApp. Si no hay ninguno cargado, la sección simplemente no aparece — es mejor eso
          que inventarlos.
        </p>
        <p className="hint">
          Recomendado: nombre y apellido inicial (Carlos M.) o su nick de Free Fire. Con 5 o 6
          basta.
        </p>
      </div>

      <TestimonialsForm
        initial={existing.map((t) => ({
          quote: t.quote,
          author: t.author,
          combo: t.combo ?? '',
        }))}
      />
    </>
  );
}
