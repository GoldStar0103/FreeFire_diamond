/**
 * Create or reset an admin user.
 *
 * There is deliberately no sign-up page — this panel approves payments, so
 * accounts are created from the server by someone with shell access.
 *
 *   DATABASE_URL=... pnpm --filter @levelup/admin create-admin jose@levelupstore.mx "una contraseña larga"
 *
 * Wrapped in a function rather than using top-level await: this package is not
 * `"type": "module"` (Next does not need it), so the script is transpiled to
 * CommonJS, where top-level await is a syntax error.
 */

import { eq } from 'drizzle-orm';
import { adminUsers, createDb } from '@levelup/db';
import { hashPassword } from '../lib/auth';

async function main(): Promise<void> {
  const [email, password, name] = process.argv.slice(2);

  if (!email || !password) {
    console.error('Usage: create-admin <email> <password> [name]');
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const { db, client } = createDb(databaseUrl);

  try {
    const normalised = email.trim().toLowerCase();
    const passwordHash = await hashPassword(password);

    const [existing] = await db
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.email, normalised))
      .limit(1);

    if (existing) {
      // Re-running with a new password is the password-reset path.
      await db
        .update(adminUsers)
        .set({ passwordHash, active: true, ...(name ? { name } : {}) })
        .where(eq(adminUsers.id, existing.id));
      console.log(`Password updated for ${normalised}`);
    } else {
      await db.insert(adminUsers).values({
        email: normalised,
        passwordHash,
        name: name ?? null,
        role: 'operator',
        active: true,
      });
      console.log(`Created admin ${normalised}`);
    }

    if (!process.env.ADMIN_SESSION_SECRET) {
      console.warn(
        '\nADMIN_SESSION_SECRET is not set. Generate one before starting the panel:\n' +
          '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
