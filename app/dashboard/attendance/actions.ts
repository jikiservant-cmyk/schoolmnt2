'use server';

import crypto from 'crypto';
import { createClient } from '@/utils/supabase/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';
import { requireSchoolAdmin } from '@/lib/auth-guard';
import { revalidatePath } from 'next/cache';
import { createAdminClient } from '@/utils/supabase/admin';
import { getOwnedPerson } from '@/lib/tenant';
import { loadSchoolWallet, isMissingTable, legacyBalanceUsable } from '@/lib/payments/wallet';
import { consumeRateLimit } from '@/lib/security/rate-limit';

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
    
    // 1. Get attendance logs strictly scoped to this school
  let logs: any[] = [];
  
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
    query = query.gte('occurred_at', startIso).lte('occurred_at', endIso).limit(2000);
  } else {
    query = query.limit(500);
  }
  
  const { data: logsData, error: logsError } = await query;

  if (!logsError && logsData) {
    logs = logsData;
  }

  // 2. Fetch classes strictly scoped to this school
  let classes: any[] = [];
  const { data: classData } = await supabase
    .from('classes')
    .select('id, name')
    .eq('school_id', schoolId)
    .order('name');
  if (classData) classes = classData;

  // 3. Fetch all registered people strictly scoped to this school
  let people: any[] = [];
  const { data: peopleData } = await supabase
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
  if (peopleData) people = peopleData;

  // 4. Fetch school details strictly for this school
  let school: any = null;
  const { data: schoolRecord } = await supabase
    .from('schools')
    .select('id, name, settings')
    .eq('id', schoolId)
    .maybeSingle();

  if (schoolRecord) {
    school = schoolRecord;
  }

  // Ensure balance is loaded from public.wallets table or school settings
  if (school?.id) {
    try {
      const publicAdmin = createPublicAdminClient();
      const wallet = await loadSchoolWallet(publicAdmin, school.id);

      if (wallet && wallet.balance !== null && wallet.balance !== undefined) {
        const curSettings = school.settings || {};
        school.settings = { ...curSettings, balance: Number(wallet.balance) };
      } else if (!(await legacyBalanceUsable(createAdminClient(), school.id))) {
        // No wallet row, but the school was credited before: the legacy
        // settings.balance is a stale mirror, never show it as spendable.
        school.settings = { ...(school.settings || {}), balance: 0 };
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
      error: undefined as string | undefined
    };
  } catch (err: any) {
    return {
      logs: [],
      school: null,
      classes: [],
      people: [],
      error: err.message || 'Unauthorized'
    };
  }
}

export async function recordTeacherAttendance(personId: string, status?: 'present' | 'late' | 'excused') {
  try {
    const { supabase, schoolId } = await requireSchoolAdmin();

    // MULTI-TENANT: the person must belong to this school (previously any
    // person UUID was accepted and logged under the caller's school_id).
    const person = await getOwnedPerson(createAdminClient(), schoolId, personId, ['teacher', 'support_staff', 'admin']);
    if (!person) {
      return { error: 'Staff member not found in your school.' };
    }
    if (status !== undefined && status !== 'present' && status !== 'late' && status !== 'excused') {
      return { error: 'Invalid attendance status.' };
    }

    const now = new Date();
    // Default rule: if checking in after 08:30 AM East Africa Time, mark as late unless specified
    const eatHours = (now.getUTCHours() + 3) % 24;
    const eatMinutes = now.getUTCMinutes();
    const isLate = eatHours > 8 || (eatHours === 8 && eatMinutes > 30);
    const finalStatus = status || (isLate ? 'late' : 'present');

    const { data, error } = await supabase
      .from('attendance_logs')
      .insert({
        school_id: schoolId,
        person_id: personId,
        status: finalStatus,
        attendance_type: 'check_in',
        source: 'manual',
        occurred_at: now.toISOString()
      })
      .select()
      .maybeSingle();

    if (error) {
      return { error: error.message };
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
    
    // Same wallet choice as the payment webhook (handles duplicate wallets).
    let walletBalance: number | null = null;
    const wallet = await loadSchoolWallet(publicAdmin, schoolId);
    if (wallet && wallet.balance !== null && wallet.balance !== undefined) {
      walletBalance = Number(wallet.balance);
    }

    // Also check school settings balance
    const { data: schoolRecord } = await supabase
      .from('schools')
      .select('settings')
      .eq('id', schoolId)
      .maybeSingle();

    const settingsBalance = walletBalance === null && schoolRecord?.settings?.balance !== undefined
      && (await legacyBalanceUsable(createAdminClient(), schoolId))
      ? Number(schoolRecord.settings.balance) : null;

    const resolvedBalance = walletBalance !== null ? walletBalance : (settingsBalance !== null ? settingsBalance : 0);

    return { balance: resolvedBalance };
  } catch (err) {
    console.error('Error fetching balance:', err);
    return { error: 'Failed to fetch balance' };
  }
}

export async function topUpBalance(amount: number, phoneNumber: string) {
  try {
    const { supabase, schoolId, user } = await requireSchoolAdmin();
    const publicAdmin = createPublicAdminClient();

    if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isInteger(amount) || amount < 1 || amount > 10_000_000) {
      return { error: 'Top-up amount must be a whole number between 1 and 10,000,000 UGX.' };
    }
    if (typeof phoneNumber !== 'string' || !/^\+?[0-9\s\-().]{9,20}$/.test(phoneNumber)) {
      return { error: 'Please enter a valid mobile money phone number.' };
    }
    const userData = { user };

    // Each top-up sends a Mobile Money PIN prompt to a phone: cap how often a
    // school can start one (stops prompt-spamming a phone number).
    const maxTopUps = Number(process.env.TOPUP_MAX_PER_10_MIN) > 0 ? Number(process.env.TOPUP_MAX_PER_10_MIN) : 6;
    const rl = consumeRateLimit(`topup:${schoolId}`, maxTopUps, 10 * 60 * 1000);
    if (!rl.allowed) {
      return { error: `Too many top-up attempts. Please wait ${Math.ceil(rl.retryAfterSeconds / 60)} minute(s) and try again.` };
    }

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

  console.log(`[NaJiki STK Push] Resolved tenant code: "${tenantCode}" for user ${userData.user.email} / school ${school.id}`);

  // 2. (Wallet rows are created by the payment webhook when money actually
  //    arrives. Pre-creating them here raced on double-click and produced
  //    duplicate wallets that hid the real balance.)

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

  const phoneWithPlus = `+${formattedPhoneNumeric}`;
  const phoneLocal07 = formattedPhoneNumeric.startsWith('256') 
    ? `0${formattedPhoneNumeric.slice(3)}` 
    : formattedPhoneNumeric;

  // 4. Generate unique transaction / idempotency key
  // Unguessable, unique reference (was Date.now() + 4 random digits).
  const idempotencyKey = `sch_topup_${crypto.randomUUID()}`;

  // 5. Determine NaJiki API Endpoint
  let endpointUrl = process.env.NAJIKI_API_URL;
  if (!endpointUrl && process.env.NAJIKI_DOMAIN) {
    const domain = process.env.NAJIKI_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
    endpointUrl = `https://${domain}/api/payments`;
  }
  if (!endpointUrl) {
    endpointUrl = 'https://najiki.vercel.app/api/payments';
  }

  const apiKey = process.env.NAJIKI_API_KEY;
  if (!apiKey) {
    console.error('[NaJiki STK Push] NAJIKI_API_KEY is not configured.');
    return { error: 'Mobile Money payments are not configured. Please contact support.' };
  }
  const appCode = process.env.NAJIKI_APP_CODE || "school";

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

  // 6. Record the top-up BEFORE asking for money. The payment webhook only
  //    credits payments that match one of these (school, amount, reference).
  const adminSchool = createAdminClient();

  // Durable limit: the in-memory counter above is per server instance, so
  // with several instances (or after a restart) it can be bypassed. The
  // intents table is shared by every instance.
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: recent, error: recentErr } = await adminSchool
    .from('payment_intents')
    .select('id')
    .eq('school_id', school.id)
    .gte('created_at', since)
    .limit(maxTopUps);
  if (!recentErr && (recent?.length ?? 0) >= maxTopUps) {
    return { error: 'Too many top-up attempts. Please wait 10 minute(s) and try again.' };
  }
  if (recentErr && !isMissingTable(recentErr)) {
    console.error('[NaJiki STK Push] Could not check recent top-ups:', recentErr.message);
    return { error: 'Could not start the payment. Please try again.' };
  }

  let intentRecorded = false;
  const { error: intentErr } = await adminSchool.from('payment_intents').insert({
    school_id: school.id,
    reference: idempotencyKey,
    amount,
    currency: 'UGX',
    phone: formattedPhoneNumeric,
    created_by: userData.user.id,
  });
  if (!intentErr) {
    intentRecorded = true;
  } else if (isMissingTable(intentErr)) {
    // FAIL CLOSED: without migration 05 a paid top-up cannot be matched and
    // credited safely, so don't take the parent's / school's money at all.
    console.error('[NaJiki STK Push] school.payment_intents missing: top-ups refused. Run supabase_migrations/05_sms_payment_integrity.sql.');
    return { error: 'Top-ups are temporarily unavailable. Please contact support.' };
  } else {
    console.error('[NaJiki STK Push] Could not record payment intent:', intentErr.message);
    return { error: 'Could not start the payment. Please try again.' };
  }
  const markIntentFailed = async () => {
    if (!intentRecorded) return;
    await adminSchool.from('payment_intents').update({ status: 'failed' }).eq('reference', idempotencyKey).eq('status', 'pending');
  };

  try {
    console.log(`[NaJiki STK Push] Sending request to ${endpointUrl} for ${formattedPhoneNumeric} (${amount} UGX) with tenant "${tenantCode}"`);

    const response = await fetch(endpointUrl, {
      method: 'POST',
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
    let resData: any = {};
    try {
      textData = await response.text();
      if (textData) {
        resData = JSON.parse(textData);
      }
    } catch (parseErr) {
      console.warn('[NaJiki API] Failed to parse JSON response. Raw text:', textData.substring(0, 200));
    }

    if (!response.ok) {
      console.error(`[NaJiki TopUp API] Failed with status ${response.status}:`, resData || textData);
      // The provider refused the request: no PIN prompt was sent. (On network
      // errors we keep the intent pending: the prompt may still have gone out.)
      await markIntentFailed();
      
      // If payment provider returned a message or error
      const errorMsg = resData.message || resData.error || resData.detail || `Payment provider returned status ${response.status}. Please verify your phone number and try again.`;
      return { 
        error: errorMsg
      };
    }

    console.log('[NaJiki STK Push] Successfully initiated:', resData);

    // NaJiki replies { paymentId, reference, status }. Keep its paymentId on our
    // intent: the completion webhook carries it as paymentIntentId, so the
    // payment still matches even if the echoed metadata were ever lost.
    const najikiPaymentId = typeof resData?.paymentId === 'string' ? resData.paymentId.slice(0, 200) : '';
    if (intentRecorded && najikiPaymentId) {
      const { error: refErr } = await adminSchool.from('payment_intents')
        .update({ provider_ref: najikiPaymentId })
        .eq('reference', idempotencyKey)
        .is('provider_ref', null);
      if (refErr) console.warn('[NaJiki STK Push] Could not store NaJiki paymentId on intent:', refErr.message);
    }
    if (String(resData?.status || '').toLowerCase() === 'failed') {
      await markIntentFailed();
      return { error: 'The payment could not be started. Please check the phone number and try again.' };
    }

    return {
      success: true,
      transactionId: resData.reference || resData.paymentId || resData.transactionId || idempotencyKey,
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
    return { error: err.message || 'Failed to top up balance' };
  }
}
