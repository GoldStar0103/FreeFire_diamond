import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LevelUp Store — Recargas Free Fire',
  description:
    'Recargas de diamantes para Free Fire directo a tu cuenta. Entrega automática, pago seguro.',
};

// Traffic is almost entirely phones arriving from TikTok, Instagram and
// WhatsApp, so the mobile viewport is the design target, not an afterthought.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0d0f1a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-MX">
      <body>
        {children}
        <footer className="site-footer">
          <div className="footer-brand">LEVELUP STORE</div>
          <div className="footer-links">
            <a href="/">Inicio</a>
            <a href="/pedidos">Mis pedidos</a>
            <a href="/confianza">Confianza</a>
            {/* Support lives here and on a failed order — never as a floating
                button. The client's market is full of curious children. */}
            <a
              href={`https://wa.me/${process.env.WHATSAPP_SUPPORT_NUMBER ?? ''}`}
              target="_blank"
              rel="noreferrer"
            >
              Soporte
            </a>
          </div>
          <div className="footer-links small">
            <a href="/legal/terminos">Términos y Condiciones</a>
            <a href="/legal/privacidad">Aviso de Privacidad</a>
          </div>
          <div className="footer-note">
            No afiliado a Garena. Free Fire es marca de sus respectivos dueños.
          </div>
          <div className="footer-note">Juega más. Domina más.</div>
        </footer>
      </body>
    </html>
  );
}
