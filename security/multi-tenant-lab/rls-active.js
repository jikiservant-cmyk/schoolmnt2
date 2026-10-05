// Prints whether migration 04 is active in the lab DB (guards against reseeds).
const { Client } = require('pg');
(async () => {
  const c = new Client({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
  await c.connect();
  const r = await c.query("SELECT count(*)::int n FROM pg_policies WHERE schemaname='school' AND policyname='tenant_guard'");
  console.log('RLS tenant_guard policies active:', r.rows[0].n);
  await c.end();
})();
