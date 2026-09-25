'use server';

import crypto from 'crypto';
import { createClient } from '@/utils/supabase/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';
import { requireSchoolAdmin } from '@/lib/auth-guard';
import { revalidatePath } from 'next/cache';
import { getEatTodayRange } from '@/lib/attendance-window';
import { createAttendanceIdentity } from '@/lib/attendance/idempotency';
import { readRequestTextLimited, RequestBodyTooLargeError } from '@/lib/http/read-limited-body';

async function getEffectiveSchoolId(supabase: any, userId?: string): Promise<string | null> {
  // 1. Try auth_school_id RPC
  try {
    const { data: rpcSchoolId } = await supabase.rpc('auth_school_id');
    if (rpcSchoolId) {
      return rpcSchoolId;
    }
  } catch (err) {
    console.warn('RPC auth_school_id not available or failed:', err);
  }

  // 2. Try staff_users linked via person_id -> people(school_id)
  if (userId) {
    try {
      const { data: staffData } = await supabase
        .from('staff_users')
        .select('person_id, people(school_id)')
        .eq('auth_user_id', userId)
        .maybeSingle();

      const peopleObj = Array.isArray(staffData?.people) ? staffData.people[0] : staffData?.people;
      const resolvedSchoolId = (peopleObj as any)?.school_id;
      if (resolvedSchoolId) {
        return resolvedSchoolId;
      }
    } catch (err) {
      console.error('Error resolving staff_users school context:', err);
    }
  }

  return null;
}

export async function getAttendanceData(dateFilterStr?: string) {
  try {
    const { supabase, schoolId } = await requireSchoolAdmin();
    if (dateFilterStr) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateFilterStr);
      if (!match) return { logs: [], school: null, classes: [], people: [], truncated: false, error: 'Date filter must use YYYY-MM-DD.' };
      const parsedDate = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
      if (parsedDate.toISOString().slice(0, 10) !== dateFilterStr) {
        return { logs: [], school: null, classes: [], people: [], truncated: false, error: 'Date filter is not a valid calendar date.' };
      }
    }
    
    // 1. Get attendance logs strictly scoped to this school
  let logs: any[] = [];
  let logsTruncated = false;
  const logLimit = dateFilterStr ? 2_000 : 500;
  
  let query = supabase
    .from('attendance_logs')
    .select(`
      *,
      people (
        id,
        full_name,
        role,
        class_id,
        phone,
        device_user_id,
        school_id,
        classes:class_id (
          name
        )
      )
    `)
    .eq('school_id', schoolId)
    .order('occurred_at', { ascending: false });
    
  if (dateFilterStr) {
    // Expecting YYYY-MM-DD
    const startIso = `${dateFilterStr}T00:00:00+03:00`; // EAT Start
    const endIso = `${dateFilterStr}T23:59:59+03:00`;   // EAT End
    query = query.gte('occurred_at', startIso).lte('occurred_at', endIso).limit(logLimit + 1);
  } else {
    query = query.limit(logLimit + 1);
  }
  
  const { data: logsData, error: logsError } = await query;
  if (logsError) {
    console.error('Failed to load school-scoped attendance logs:', logsError);
    return { logs: [], school: null, classes: [], people: [], truncated: false, error: 'Failed to load attendance records. Please retry.' };
  }
  if (logsData) {
    logsTruncated = logsData.length > logLimit;
    logs = logsData.slice(0, logLimit);
  }

  // 2. Fetch classes strictly scoped to this school
  let classes: any[] = [];
  const { data: classData, error: classError } = await supabase
    .from('classes')
    .select('id, name')
    .eq('school_id', schoolId)
    .order('name');
  if (classError) {
    console.error('Failed to load school-scoped classes:', classError);
    return { logs: [], school: null, classes: [], people: [], truncated: logsTruncated, error: 'Failed to load classes. Please retry.' };
  }
  if (classData) classes = classData;

  // 3. Fetch all registered people strictly scoped to this school
  let people: any[] = [];
  const { data: peopleData, error: peopleError } = await supabase
    .from('people')
    .select(`
      id,
      full_name,
      role,
      class_id,
      phone,
      device_user_id,
      is_active,
      classes:class_id (
        name
      )
    `)
    .eq('school_id', schoolId)
    .order('full_name');
  if (peopleError) {
    console.error('Failed to load school-scoped people:', peopleError);
    return { logs: [], school: null, classes: [], people: [], truncated: logsTruncated, error: 'Failed to load the school roster. Please retry.' };
  }
  if (peopleData) people = peopleData;

  // 4. Fetch school details strictly for this school
  let school: any = null;
  const { data: schoolRecord, error: schoolError } = await supabase
    .from('schools')
    .select('id, name, settings')
    .eq('id', schoolId)
    .maybeSingle();

  if (schoolError) {
    console.error('Failed to load the authenticated school record:', schoolError);
    return { logs: [], school: null, classes: [], people: [], truncated: logsTruncated, error: 'Failed to load school details. Please retry.' };
  }
  if (schoolRecord) {
    school = schoolRecord;
  }

  // Ensure balance is loaded from public.wallets table or school settings
  if (school?.id) {
    try {
      const publicAdmin = createPublicAdminClient();
      // Try tenant_id or school_id
      const { data: wallet } = await publicAdmin
        .from('wallets')
        .select('balance')
        .or(`tenant_id.eq.${school.id},school_id.eq.${school.id}`)
        .maybeSingle();

      if (wallet && wallet.balance !== null && wallet.balance !== undefined) {
        const curSettings = school.settings || {};
        school.settings = { ...curSettings, balance: Number(wallet.balance) };
      }
    } catch (e) {
      console.warn('Notice loading balance from public.wallets:', e);
    }
  }

    return {
      logs: logs || [],
      school,
      classes: classes || [],
      people: people || [],
      truncated: logsTruncated,
      error: undefined as string | undefined
    };
  } catch (err: any) {
    return {
      logs: [],
      school: null,
      classes: [],
      people: [],
      truncated: false,
      error: err.message || 'Unauthorized'
    };
  }
}

export async function recordTeacherAttendance(personId: string, status?: 'present' | 'late' | 'excused') {
  try {
    const { supabase, schoolId } = await requireSchoolAdmin();
    
    if (typeof personId !== 'string' || !personId || (status && !['present', 'late', 'excused'].includes(status))) {
      return { error: 'Invalid teacher attendance request.' };
    }

    const { data: person, error: personError } = await supabase
      .from('people')
      .select('id, role')
      .eq('id', personId)
      .eq('school_id', schoolId)
      .maybeSingle();
    if (personError || !person || !['teacher', 'admin', 'support_staff'].includes(person.role)) {
      return { error: 'Staff record not found or access denied.' };
    }

    const now = new Date();
    // Default rule: if checking in after 08:30 AM East Africa Time, mark as late unless specified.
    const eatHours = (now.getUTCHours() + 3) % 24;
    const eatMinutes = now.getUTCMinutes();
    const isLate = eatHours > 8 || (eatHours === 8 && eatMinutes > 30);
    const finalStatus = status || (isLate ? 'late' : 'present');
    const { startIso, endIso } = getEatTodayRange(now);
    const { data: existingMark, error: existingError } = await supabase
      .from('attendance_logs')
      .select('id')
      .eq('school_id', schoolId)
      .eq('person_id', personId)
      .eq('attendance_type', 'check_in')
      .gte('occurred_at', startIso)
      .lte('occurred_at', endIso)
      .limit(1)
      .maybeSingle();
    if (existingError) return { error: 'Could not verify today\'s attendance mark.' };
    if (existingMark) return { error: 'Attendance has already been recorded for this staff member today.' };

    const identity = createAttendanceIdentity(schoolId, personId, 'check_in', now);
    const { data, error } = await supabase
      .from('attendance_logs')
      .upsert({
        ...identity,
        school_id: schoolId,
        person_id: personId,
        status: finalStatus,
        attendance_type: 'check_in',
        source: 'manual',
        occurred_at: now.toISOString()
      }, {
        onConflict: 'school_id,idempotency_key',
        ignoreDuplicates: true,
      })
      .select()
      .maybeSingle();

    if (error) {
      return { error: error.message };
    }
    if (!data) {
      return { error: 'Attendance was already recorded for this staff member today.' };
    }

    revalidatePath('/dashboard/attendance');
    revalidatePath('/dashboard');
    return { success: true, data };
  } catch (err: any) {
    return { error: err.message || 'Failed to record teacher attendance' };
  }
}

export async function markTeacherAttendanceAction(personId: string, status?: 'present' | 'late' | 'excused') {
  return recordTeacherAttendance(personId, status);
}

export async function getSchoolBalance() {
  try {
    const { supabase, schoolId } = await requireSchoolAdmin();
    const publicAdmin = createPublicAdminClient();
    
    // Check wallet balance (supporting both tenant_id and school_id columns)
    let walletBalance: number | null = null;
    try {
      const { data: wallet } = await publicAdmin
        .from('wallets')
        .select('balance')
        .or(`tenant_id.eq.${schoolId},school_id.eq.${schoolId}`)
        .maybeSingle();

      if (wallet && wallet.balance !== null && wallet.balance !== undefined) {
        walletBalance = Number(wallet.balance);
      }
    } catch {
      // Fallback direct query if .or fails
      const { data: w1 } = await publicAdmin.from('wallets').select('balance').eq('tenant_id', schoolId).maybeSingle();
      if (w1?.balance !== null && w1?.balance !== undefined) {
        walletBalance = Number(w1.balance);
      } else {
        const { data: w2 } = await publicAdmin.from('wallets').select('balance').eq('school_id', schoolId).maybeSingle();
        if (w2?.balance !== null && w2?.balance !== undefined) {
          walletBalance = Number(w2.balance);
        }
      }
    }

    // Also check school settings balance
    const { data: schoolRecord } = await supabase
      .from('schools')
      .select('settings')
      .eq('id', schoolId)
      .maybeSingle();

    const settingsBalance = schoolRecord?.settings?.balance !== undefined ? Number(schoolRecord.settings.balance) : null;

    const resolvedBalance = walletBalance !== null ? walletBalance : (settingsBalance !== null ? settingsBalance : 0);

    return { balance: resolvedBalance };
  } catch (err) {
    console.error('Error fetching balance:', err);
    return { error: 'Failed to fetch balance' };
  }
}

export async function topUpBalance(amount: number, phoneNumber: string, requestId?: string) {
  try {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return { error: 'Enter a valid positive whole-number top-up amount.' };
    }
    if (typeof phoneNumber !== 'string' || !phoneNumber.trim()) {
      return { error: 'Enter a valid mobile money phone number.' };
    }
    if (requestId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      return { error: 'Invalid payment request reference.' };
    }

    const apiKey = process.env.NAJIKI_API_KEY?.trim();
    if (!apiKey || /^(test[-_]?key|changeme|placeholder|your[-_])/i.test(apiKey)) {
      return { error: 'Payment provider credentials are not configured.' };
    }

    const { supabase, schoolId, user } = await requireSchoolAdmin();
    const publicAdmin = createPublicAdminClient();
    const userData = { user };

  const { data: school } = await supabase
    .from('schools')
    .select('id, name, settings')
    .eq('id', schoolId)
    .maybeSingle();

  if (!school) {
    return { error: 'School record not found.' };
  }

  // 1. Resolve tenant code strictly from the database (public.tenants or public.profiles)
  let tenantCode = "";
  
  try {
    // Primary: Check public.tenants table for this school
    const { data: tenantData } = await publicAdmin
      .from('tenants')
      .select('code')
      .eq('id', school.id)
      .maybeSingle();

    if (tenantData?.code && tenantData.code.trim() !== '') {
      tenantCode = tenantData.code;
    }
  } catch (err) {
    console.warn('Notice querying public.tenants:', err);
  }

  if (!tenantCode) {
    try {
      // Secondary: Check public.profiles where user matches
      const { data: profileByUser } = await publicAdmin
        .from('profiles')
        .select('code')
        .or(`id.eq.${userData.user.id},user_id.eq.${userData.user.id}`)
        .not('code', 'is', null)
        .maybeSingle();

      if (profileByUser?.code && profileByUser.code.trim() !== '') {
        tenantCode = profileByUser.code;
      }
    } catch (err) {
      console.warn('Notice querying public.profiles:', err);
    }
  }

  if (!tenantCode || tenantCode.trim() === '') {
    return { 
      error: 'Tenant code is missing from the database. Please ensure public.tenants or public.profiles has a valid "code" for this school.' 
    };
  }

  tenantCode = tenantCode.trim();

  console.log('[NaJiki STK Push] Resolved school and provider tenant configuration:', {
    schoolId: school.id,
    hasProviderTenantCode: Boolean(tenantCode),
  });

  // 2. Verify a school wallet exists before initiating a payment. The deployed
  // schema may use either tenant_id or school_id, so check each explicitly and
  // fail closed on any non-schema error.
  const missingWalletColumnCodes = new Set(['42703', 'PGRST204']);
  const walletByTenantId = await publicAdmin
    .from('wallets')
    .select('id, balance')
    .eq('tenant_id', school.id)
    .maybeSingle();
  const walletBySchoolId = await publicAdmin
    .from('wallets')
    .select('id, balance')
    .eq('school_id', school.id)
    .maybeSingle();

  const tenantColumnAvailable = !walletByTenantId.error;
  const schoolColumnAvailable = !walletBySchoolId.error;
  const unexpectedWalletError = [walletByTenantId.error, walletBySchoolId.error].find(
    error => error && !missingWalletColumnCodes.has(error.code || ''),
  );
  if (unexpectedWalletError || (!tenantColumnAvailable && !schoolColumnAvailable)) {
    console.error('[NaJiki STK Push] Could not verify the school wallet:', unexpectedWalletError);
    return { error: 'Could not verify the school wallet. No payment was initiated.' };
  }

  if (
    walletByTenantId.data && walletBySchoolId.data &&
    walletByTenantId.data.id !== walletBySchoolId.data.id
  ) {
    console.error('[NaJiki STK Push] Conflicting wallet rows exist for the school.');
    return { error: 'Wallet configuration is ambiguous. Contact support before initiating a payment.' };
  }

  let existingWallet = walletByTenantId.data || walletBySchoolId.data;
  if (!existingWallet) {
    const walletRecord: Record<string, unknown> = {
      id: crypto.randomUUID(),
      balance: school.settings?.balance || 0,
      currency: 'UGX',
      sms_rate: 50,
    };
    if (tenantColumnAvailable) walletRecord.tenant_id = school.id;
    if (schoolColumnAvailable) walletRecord.school_id = school.id;

    let { error: walletInsertError } = await publicAdmin
      .from('wallets')
      .insert(walletRecord);
    if (
      walletInsertError &&
      missingWalletColumnCodes.has(walletInsertError.code || '') &&
      /currency|sms_rate/i.test(walletInsertError.message)
    ) {
      const fallbackWalletRecord = { ...walletRecord };
      delete fallbackWalletRecord.currency;
      delete fallbackWalletRecord.sms_rate;
      const fallbackInsert = await publicAdmin.from('wallets').insert(fallbackWalletRecord);
      walletInsertError = fallbackInsert.error;
    }

    if (walletInsertError && walletInsertError.code === '23505') {
      const [retryTenant, retrySchool] = await Promise.all([
        tenantColumnAvailable
          ? publicAdmin.from('wallets').select('id, balance').eq('tenant_id', school.id).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        schoolColumnAvailable
          ? publicAdmin.from('wallets').select('id, balance').eq('school_id', school.id).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      existingWallet = retryTenant.data || retrySchool.data;
    } else if (walletInsertError) {
      console.error('[NaJiki STK Push] Could not initialize the school wallet:', walletInsertError);
      return { error: 'Could not initialize the school wallet. No payment was initiated.' };
    }

    if (!existingWallet) {
      const { data: insertedWallet, error: verifyWalletError } = await publicAdmin
        .from('wallets')
        .select('id, balance')
        .eq('id', walletRecord.id)
        .maybeSingle();
      if (verifyWalletError || !insertedWallet) {
        console.error('[NaJiki STK Push] Wallet initialization was not confirmed:', verifyWalletError);
        return { error: 'Could not confirm school wallet initialization. No payment was initiated.' };
      }
      existingWallet = insertedWallet;
    }
  }

  // 3. Clean and standardize phone number
  // Removes spaces, hyphens, brackets
  let rawPhone = phoneNumber.replace(/[\s\-\(\)\.]/g, '');
  if (rawPhone.startsWith('+')) {
    rawPhone = rawPhone.slice(1);
  }
  
  let formattedPhoneNumeric = rawPhone;
  if (rawPhone.startsWith('0')) {
    formattedPhoneNumeric = `256${rawPhone.slice(1)}`;
  } else if (!rawPhone.startsWith('256') && rawPhone.length === 9) {
    formattedPhoneNumeric = `256${rawPhone}`;
  }

  if (!/^256\d{9}$/.test(formattedPhoneNumeric)) {
    return { error: 'Enter a valid Ugandan mobile money number.' };
  }

  const phoneWithPlus = `+${formattedPhoneNumeric}`;
  const phoneLocal07 = formattedPhoneNumeric.startsWith('256') 
    ? `0${formattedPhoneNumeric.slice(3)}` 
    : formattedPhoneNumeric;

  // 4. Generate unique transaction / idempotency key
  const idempotencyKey = `sch_topup_${requestId?.toLowerCase() || crypto.randomUUID()}`;

  // 5. Determine NaJiki API Endpoint
  let endpointUrl = process.env.NAJIKI_API_URL?.trim();
  if (!endpointUrl && process.env.NAJIKI_DOMAIN?.trim()) {
    const domain = process.env.NAJIKI_DOMAIN.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
    endpointUrl = `https://${domain}/api/payments`;
  }
  if (!endpointUrl) {
    return { error: 'Payment provider endpoint is not configured. Set NAJIKI_API_URL or NAJIKI_DOMAIN.' };
  }
  try {
    const parsedEndpoint = new URL(endpointUrl);
    if (parsedEndpoint.protocol !== 'https:' || parsedEndpoint.username || parsedEndpoint.password) {
      return { error: 'Payment provider endpoint must be a trusted HTTPS URL.' };
    }
  } catch {
    return { error: 'Payment provider endpoint is invalid.' };
  }

  const appCode = process.env.NAJIKI_APP_CODE || 'school';

  // Build clean, full-spec STK push payload for NaJiki
  const payload = {
    applicationCode: appCode,
    paymentTypeCode: "general",
    tenantCode: tenantCode,
    tenant_code: tenantCode,
    code: tenantCode,
    externalEntityId: school.id,
    schoolId: school.id,
    amount: Number(amount),
    currency: "UGX",
    phoneNumber: formattedPhoneNumeric,
    phone: formattedPhoneNumeric,
    phone_number: formattedPhoneNumeric,
    msisdn: formattedPhoneNumeric,
    formattedPhone: phoneWithPlus,
    localPhoneNumber: phoneLocal07,
    idempotencyKey: idempotencyKey,
    reference: idempotencyKey,
    tx_ref: idempotencyKey,
    description: `SMS Wallet Top-up for ${school.name || 'SmartSkoolz School'}`,
    narration: `SmartSkoolz SMS Top-up (${amount.toLocaleString()} UGX)`,
    metadata: {
      type: "topup",
      schoolId: school.id,
      schoolName: school.name,
      tenantCode: tenantCode,
      tenant_code: tenantCode,
      code: tenantCode,
      amount: Number(amount),
      idempotencyKey: idempotencyKey
    }
  };

  try {
    const parsedEndpoint = new URL(endpointUrl);
    console.log('[NaJiki STK Push] Initiating payment request:', {
      providerHost: parsedEndpoint.host,
      schoolId: school.id,
      amount,
      reference: idempotencyKey,
    });

    const response = await fetch(endpointUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-API-Key': apiKey,
        'X-Tenant-Code': tenantCode,
        'X-Tenant-Id': school.id,
        'tenant-code': tenantCode,
        'tenantCode': tenantCode,
        'code': tenantCode
      },
      body: JSON.stringify(payload)
    });

    let textData = '';
    let resData: Record<string, unknown> = {};
    try {
      textData = await readRequestTextLimited(response, 64 * 1024);
      if (textData) {
        const parsedResponse: unknown = JSON.parse(textData);
        if (parsedResponse && typeof parsedResponse === 'object' && !Array.isArray(parsedResponse)) {
          resData = parsedResponse as Record<string, unknown>;
        }
      }
    } catch (responseReadError) {
      const reason = responseReadError instanceof RequestBodyTooLargeError
        ? 'response exceeded 64 KiB'
        : 'response could not be read or parsed';
      console.warn(`[NaJiki API] Provider ${reason}; HTTP status ${response.status}.`);
    }

    if (!response.ok) {
      console.error(`[NaJiki TopUp API] Provider returned HTTP status ${response.status}.`);
      return {
        error: `Payment provider returned status ${response.status}. Please verify the payment details or contact support.`,
      };
    }

    console.log('[NaJiki STK Push] Payment request accepted by provider.');
    const providerTransactionId = resData.transactionId || resData.reference || resData.id;
    const transactionId = (typeof providerTransactionId === 'string' || typeof providerTransactionId === 'number')
      ? String(providerTransactionId).slice(0, 200)
      : idempotencyKey;

    return {
      success: true,
      transactionId,
      message: `Mobile Money PIN prompt sent to ${phoneLocal07}! Please enter your PIN on your phone to complete payment.`
    };
  } catch (err: any) {
    console.error('NaJiki TopUp API connection error:', err);
    return { 
      error: 'Could not connect to payment gateway. Please check your network connection and try again.' 
    };
  }
  } catch (err: any) {
    console.error('topUpBalance error:', err);
    return { error: 'Could not initiate the top-up. Please contact support if the problem persists.' };
  }
}
