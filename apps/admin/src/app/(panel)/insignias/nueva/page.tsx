import { requireSession } from '../../../../lib/session';
import { BadgeForm } from '../badge-form';

export const dynamic = 'force-dynamic';

export default async function NuevaInsigniaPage() {
  await requireSession();
  return (
    <>
      <h1>Nueva insignia</h1>
      <div className="card">
        <BadgeForm />
      </div>
    </>
  );
}
