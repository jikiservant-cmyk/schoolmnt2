import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.TEST_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.TEST_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const schoolAEmail = process.env.TEST_SCHOOL_A_EMAIL;
const schoolAPassword = process.env.TEST_SCHOOL_A_PASSWORD;
const schoolBEmail = process.env.TEST_SCHOOL_B_EMAIL;
const schoolBPassword = process.env.TEST_SCHOOL_B_PASSWORD;

const required = {
  TEST_SUPABASE_URL: supabaseUrl,
  TEST_SUPABASE_ANON_KEY: anonKey,
  TEST_SCHOOL_A_EMAIL: schoolAEmail,
  TEST_SCHOOL_A_PASSWORD: schoolAPassword,
  TEST_SCHOOL_B_EMAIL: schoolBEmail,
  TEST_SCHOOL_B_PASSWORD: schoolBPassword,
};
const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => name);
if (missing.length) {
  console.error(`Missing integration-test environment variables: ${missing.join(', ')}`);
  process.exit(2);
}

const tables = [
  'devices',
  'people',
  'classes',
  'attendance_logs',
  'device_logs',
  'device_commands',
  'person_credentials',
  'notifications',
  'parents',
];
const requiredFixtureTables = new Set(tables);
const optionalTenantTables = new Set(['person_credentials']);
const publicAdminTables = ['admin_profiles', 'profiles', 'tenants', 'schools', 'wallets', 'transactions', 'notifications'];
const optionalSchemaCodes = new Set(['PGRST205', '42P01']);

async function schoolClient(email, password) {
  const client = createClient(supabaseUrl, anonKey, {
    db: { schema: 'school' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  assert.ifError(error);
  const { data: schoolId, error: tenantError } = await client.rpc('auth_school_id');
  assert.ifError(tenantError);
  assert.ok(schoolId, `No school tenant resolved for ${email}`);
  return { client, schoolId };
}

async function publicSchemaClientFor(sessionSource) {
  const { data: { session }, error: sessionError } = await sessionSource.auth.getSession();
  assert.ifError(sessionError);
  assert.ok(session, 'Authenticated school session was not available for public-schema checks.');

  const client = createClient(supabaseUrl, anonKey, {
    db: { schema: 'public' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  assert.ifError(error);
  return client;
}

async function assertPublicTableNotReadable(client, table, roleLabel) {
  const { count, error } = await client
    .from(table)
    .select('*', { count: 'exact', head: true })
    .limit(1);

  if (error && optionalSchemaCodes.has(error.code)) return false;
  if (error && ['42501', 'PGRST116'].includes(error.code)) return true;
  if (error) throw new Error(`${roleLabel} public.${table} access check failed: ${error.message}`);
  assert.equal(count || 0, 0, `${roleLabel} can read rows from public.${table}`);
  return true;
}

async function assertColumnNotReadable(client, table, column, roleLabel) {
  const { error } = await client.from(table).select(column).limit(1);
  assert.ok(
    error && error.code === '42501',
    `${roleLabel} unexpectedly read ${table}.${column}${error ? ` (${error.code}: ${error.message})` : ''}`,
  );
}

async function main() {
  assert.notEqual(schoolAEmail, schoolBEmail, 'Use two distinct test-school accounts.');
  const schoolA = await schoolClient(schoolAEmail, schoolAPassword);
  const schoolB = await schoolClient(schoolBEmail, schoolBPassword);
  assert.notEqual(schoolA.schoolId, schoolB.schoolId, 'Test accounts must belong to different schools.');

  await assertColumnNotReadable(schoolA.client, 'devices', 'device_secret', 'School A');
  await assertColumnNotReadable(schoolA.client, 'devices', 'device_secret_hash', 'School A');
  await assertColumnNotReadable(schoolA.client, 'devices', 'firmware_version', 'School A');
  await assertColumnNotReadable(schoolA.client, 'staff_users', 'pin_hash', 'School A');
  await assertColumnNotReadable(schoolA.client, 'staff_users', 'failed_attempts', 'School A');
  await assertColumnNotReadable(schoolA.client, 'staff_users', 'locked_until', 'School A');
  const { error: pinLockoutRpcError } = await schoolA.client.rpc('record_teacher_pin_failure', {
    p_staff_user_id: randomUUID(),
    p_person_id: randomUUID(),
  });
  assert.ok(
    pinLockoutRpcError && ['42501', 'PGRST202'].includes(pinLockoutRpcError.code),
    `Authenticated School A must not execute the service-only PIN lockout RPC${pinLockoutRpcError ? ` (${pinLockoutRpcError.code}: ${pinLockoutRpcError.message})` : ''}`,
  );

  let checkedTables = 0;
  let checkedIds = 0;
  let checkedWrites = 0;
  const emptyFixtures = [];

  for (const table of tables) {
    const { data: bRows, error: bError } = await schoolB.client
      .from(table)
      .select('id, school_id')
      .eq('school_id', schoolB.schoolId)
      .limit(5);

    if (bError && optionalTenantTables.has(table) && optionalSchemaCodes.has(bError.code)) {
      console.warn(`Skipped optional tenant table school.${table}; it is not installed in this project.`);
      continue;
    }
    if (bError) {
      throw new Error(`School B could not read its own ${table} fixture: ${bError.message}`);
    }

    if (!bRows?.length) {
      if (requiredFixtureTables.has(table)) {
        emptyFixtures.push(table);
      }
      continue;
    }

    // Direct IDOR attempt: School A knows/guesses a record ID belonging to B.
    for (const row of bRows) {
      const { data: directRead, error: directReadError } = await schoolA.client
        .from(table)
        .select('id, school_id')
        .eq('id', row.id)
        .maybeSingle();
      if (directReadError && !['42501', 'PGRST116'].includes(directReadError.code)) {
        throw new Error(`Direct-ID isolation check failed for ${table}: ${directReadError.message}`);
      }
      assert.equal(directRead, null, `School A read School B ${table} row ${row.id}`);
      checkedIds++;
    }

    // No-op cross-tenant update probe: if RLS is missing, this can touch only
    // the same school_id value and therefore cannot alter the fixture's data.
    const probe = bRows[0];
    const { data: writeResult, error: writeError } = await schoolA.client
      .from(table)
      .update({ school_id: probe.school_id })
      .eq('id', probe.id)
      .select('id');
    if (writeError && !['42501', 'PGRST116'].includes(writeError.code)) {
      throw new Error(`Cross-tenant ${table} write returned an unexpected error: ${writeError.message}`);
    }
    assert.equal(writeResult?.length || 0, 0, `School A updated a School B ${table} row.`);
    checkedWrites++;

    // Enumeration attempt: return any record whose tenant is not A.
    const { data: otherTenantRows, error: listError } = await schoolA.client
      .from(table)
      .select('id, school_id')
      .neq('school_id', schoolA.schoolId)
      .limit(1);
    assert.ifError(listError);
    assert.equal(otherTenantRows?.length || 0, 0, `School A enumerated another tenant's ${table} rows`);
    checkedTables++;
  }

  assert.deepEqual(
    emptyFixtures,
    [],
    `Seed School B with at least one row in every tenant-scoped test table before running the proof: ${emptyFixtures.join(', ')}`,
  );

  // student_parents is often a link table without school_id, so RLS must scope
  // it through both linked tenant-owned records.
  const { data: bLinks, error: linksError } = await schoolB.client
    .from('student_parents')
    .select('student_id, parent_id, is_primary_contact')
    .limit(5);
  assert.ifError(linksError);
  assert.ok(bLinks?.length, 'Seed School B with at least one student-parent link.');

  for (const link of bLinks) {
    const { data: directLink, error: directLinkError } = await schoolA.client
      .from('student_parents')
      .select('student_id, parent_id')
      .eq('student_id', link.student_id)
      .eq('parent_id', link.parent_id)
      .limit(1)
      .maybeSingle();
    if (directLinkError && !['42501', 'PGRST116'].includes(directLinkError.code)) {
      throw new Error(`Direct-link isolation check failed for student_parents: ${directLinkError.message}`);
    }
    assert.equal(directLink, null, 'School A read a School B student-parent link.');
    checkedIds++;

    const { data: linkWrite, error: linkWriteError } = await schoolA.client
      .from('student_parents')
      .update({ is_primary_contact: link.is_primary_contact })
      .eq('student_id', link.student_id)
      .eq('parent_id', link.parent_id)
      .select('student_id');
    if (linkWriteError && !['42501', 'PGRST116'].includes(linkWriteError.code)) {
      throw new Error(`Cross-tenant student-parent write returned an unexpected error: ${linkWriteError.message}`);
    }
    assert.equal(linkWrite?.length || 0, 0, 'School A updated a School B student-parent link.');
    checkedWrites++;
  }

  // Public-schema admin tables are private to server-side service-role clients.
  // HEAD/count probes verify row visibility without downloading sensitive data.
  const publicClients = [
    ['school A', await publicSchemaClientFor(schoolA.client)],
    ['school B', await publicSchemaClientFor(schoolB.client)],
    ['anon', createClient(supabaseUrl, anonKey, {
      db: { schema: 'public' },
      auth: { persistSession: false, autoRefreshToken: false },
    })],
  ];
  let checkedPublicTables = 0;
  for (const table of publicAdminTables) {
    let tableExists = false;
    for (const [roleLabel, client] of publicClients) {
      tableExists = (await assertPublicTableNotReadable(client, table, roleLabel)) || tableExists;
    }
    if (tableExists) checkedPublicTables++;
  }

  // Optional HTTP check confirms a token issued for School A's physical device
  // cannot authenticate as School B's device. An empty push may update the
  // device heartbeat, but must not create any attendance events.
  const appUrl = process.env.TEST_APP_URL;
  const schoolADeviceSerial = process.env.TEST_SCHOOL_A_DEVICE_SERIAL;
  const schoolADeviceToken = process.env.TEST_SCHOOL_A_DEVICE_TOKEN;
  const schoolBDeviceSerial = process.env.TEST_SCHOOL_B_DEVICE_SERIAL;
  if (appUrl && schoolADeviceSerial && schoolADeviceToken && schoolBDeviceSerial) {
    const ownDeviceResponse = await fetch(
      new URL(`/api/devices/push?sn=${encodeURIComponent(schoolADeviceSerial)}`, appUrl),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-device-token': schoolADeviceToken,
        },
        body: '{}',
      },
    );
    assert.equal(ownDeviceResponse.status, 200, 'School A device token did not authenticate against its own serial.');

    const crossDeviceResponse = await fetch(
      new URL(`/api/devices/push?sn=${encodeURIComponent(schoolBDeviceSerial)}`, appUrl),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-device-token': schoolADeviceToken,
        },
        body: '{}',
      },
    );
    assert.equal(crossDeviceResponse.status, 401, 'School A device token authenticated against School B serial.');
  } else {
    console.warn('Skipped device HTTP impersonation check; TEST_APP_URL and both test device credentials were not provided.');
  }

  console.log(`Tenant RLS integration proof passed: ${checkedTables} school-table enumerations, ${checkedIds} direct-ID/link checks, ${checkedWrites} cross-tenant write denials, and ${checkedPublicTables} public tables denied to anon/authenticated users.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
