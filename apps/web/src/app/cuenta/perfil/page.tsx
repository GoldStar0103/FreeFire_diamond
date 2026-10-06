import type { Metadata } from 'next';
import { getMyProfile } from '@levelup/db';
import { requireCustomerSession } from '../../../lib/customer-session.js';
import { getDb } from '../../../lib/server.js';
import { avatarUrl } from '../../../lib/assets.js';
import { initials } from '../../../lib/format.js';
import { AvatarForm, DisplayNameForm } from './perfil-forms';

export const metadata: Metadata = {
  title: 'Editar perfil',
  alternates: { canonical: '/cuenta/perfil' },
};

export const dynamic = 'force-dynamic';

export default async function PerfilPage() {
  const session = await requireCustomerSession();
  const profile = await getMyProfile(getDb(), session.playerProfileId);
  const name = profile?.displayName ?? '';
  const avatar = avatarUrl(profile?.avatarAssetUrl);

  return (
    <main className="page narrow">
      <h1 className="page-title">Editar perfil</h1>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          {avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatar} alt="" width={64} height={64} style={{ borderRadius: '50%', objectFit: 'cover' }} />
          ) : (
            <div className="avatar" aria-hidden="true" style={{ width: 64, height: 64, fontSize: 22 }}>
              {initials(name || 'Jugador')}
            </div>
          )}
        </div>
        <AvatarForm />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <DisplayNameForm initial={name} />
      </div>
    </main>
  );
}
