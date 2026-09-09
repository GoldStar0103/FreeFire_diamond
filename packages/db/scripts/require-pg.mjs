/**
 * Fail unless Postgres is genuinely reachable at TEST_PG_URL.
 *
 * The integration tests skip themselves when no database answers, which is
 * right locally — `pnpm -r test` stays green on a machine with no cluster. In
 * CI it is the worst possible behaviour: 154 tests quietly do not run and the
 * build reports success. The whole point of running them there is that they
 * are the ones nobody remembers to run.
 *
 * A TCP check is not enough. Postgres accepts connections on the port while
 * still in crash recovery and rejects every query with "the database system is
 * starting up" — observed, not hypothesised — so this opens a real connection
 * and runs a real query.
 *
 *   node scripts/require-pg.mjs
 */

import postgres from 'postgres';

const url = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const deadline = Date.now() + Number(process.env.REQUIRE_PG_TIMEOUT_MS ?? 60_000);

let lastError = 'no attempt made';

while (Date.now() < deadline) {
  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    const [row] = await sql`select version() as version`;
    console.log(`Postgres reachable at ${url}`);
    console.log(row.version);
    await sql.end({ timeout: 5 });
    process.exit(0);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    await sql.end({ timeout: 5 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

console.error(`No Postgres at ${url} — last error: ${lastError}`);
console.error('The integration tests would have skipped and the build would have passed.');
process.exit(1);
