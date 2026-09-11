'use server';

import crypto from 'crypto';
import { createClient } from '@/utils/supabase/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';
import { revalidatePath } from 'next/cache';

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

export async function getAttendanceData() {
  const supabase = await createClient();
  
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return {
      logs: [],
      school: null,
      classes: [],
      people: [],
      error: 'Not authenticated. Please log in.'
    };
  }

  const schoolId = await getEffectiveSchoolId(supabase, userData.user.id);
  if (!schoolId) {
    return {
      logs: [],
      school: null,
      classes: [],
      people: [],
      error: 'Your account is not linked to an active school tenant.'
    };
  }

  // 1. Get attendance logs strictly scoped to this school
  let logs: any[] = [];
  const { data: logsData, error: logsError } = await supabase
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
    .order('occurred_at', { ascending: false })
    .limit(500);

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
    error: undefined as string | undefined
  };
}

export async function recordTeacherAttendance(personId: string, status?: 'present' | 'late' | 'excused') {
  const supabase = await createClient();
  
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { error: 'Unauthorized' };
  }

  const schoolId = await getEffectiveSchoolId(supabase, userData.user.id);
  if (!schoolId) {
    return { error: 'No school tenant context found.' };
  }

  try {
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
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return { error: 'Unauthorized' };

  const schoolId = await getEffectiveSchoolId(supabase, userData.user.id);
  if (!schoolId) return { error: 'No school tenant context found.' };

  try {
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

export async function topUpBalance(amount: number, phoneNumber: string) {
  const supabase = await createClient();
  const publicAdmin = createPublicAdminClient();
  
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { error: 'Unauthorized. Please log in to top up.' };
  }

  const schoolId = await getEffectiveSchoolId(supabase, userData.user.id);
  if (!schoolId) {
    return { error: 'No school context resolved for this account.' };
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

  // 2. Ensure row exists in public.wallets for this school
  try {
    const { data: existingWallet } = await publicAdmin
      .from('wallets')
      .select('id, balance')
      .or(`tenant_id.eq.${school.id},school_id.eq.${school.id}`)
      .maybeSingle();

    if (!existingWallet) {
      const generatedWalletId = crypto.randomUUID();
      try {
        await publicAdmin
          .from('wallets')
          .insert({
            id: generatedWalletId,
            tenant_id: school.id,
            school_id: school.id,
            balance: school.settings?.balance || 0,
            currency: 'UGX',
            sms_rate: 50
          });
      } catch (wInsertErr) {
        console.warn('Wallet insertion note:', wInsertErr);
      }
    }
  } catch (wErr) {
    console.warn('Notice ensuring public.wallets record:', wErr);
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

  const phoneWithPlus = `+${formattedPhoneNumeric}`;
  const phoneLocal07 = formattedPhoneNumeric.startsWith('256') 
    ? `0${formattedPhoneNumeric.slice(3)}` 
    : formattedPhoneNumeric;

  // 4. Generate unique transaction / idempotency key
  const idempotencyKey = `sch_topup_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  // 5. Determine NaJiki API Endpoint
  let endpointUrl = process.env.NAJIKI_API_URL;
  if (!endpointUrl && process.env.NAJIKI_DOMAIN) {
    const domain = process.env.NAJIKI_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
    endpointUrl = `https://${domain}/api/payments`;
  }
  if (!endpointUrl) {
    endpointUrl = 'https://najiki.vercel.app/api/payments';
  }

  const apiKey = process.env.NAJIKI_API_KEY || 'test_key';
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
      
      // If payment provider returned a message or error
      const errorMsg = resData.message || resData.error || resData.detail || `Payment provider returned status ${response.status}. Please verify your phone number and try again.`;
      return { 
        error: errorMsg
      };
    }

    console.log('[NaJiki STK Push] Successfully initiated:', resData);

    return {
      success: true,
      transactionId: resData.transactionId || resData.reference || resData.id || idempotencyKey,
      message: `Mobile Money PIN prompt sent to ${phoneLocal07}! Please enter your PIN on your phone to complete payment.`
    };
  } catch (err: any) {
    console.error('NaJiki TopUp API connection error:', err);
    return { 
      error: 'Could not connect to payment gateway. Please check your network connection and try again.' 
    };
  }
}
