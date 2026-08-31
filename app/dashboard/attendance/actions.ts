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

  // Ensure balance is loaded from public.wallets table strictly for this tenant
  if (school?.id) {
    try {
      const publicAdmin = createPublicAdminClient();
      const { data: wallet } = await publicAdmin
        .from('wallets')
        .select('balance')
        .eq('tenant_id', school.id)
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

export async function markTeacherAttendanceAction(
  personId: string, 
  status: 'present' | 'late' = 'present',
  note?: string
) {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { error: 'Unauthorized' };
  }

  const schoolId = await getEffectiveSchoolId(supabase, userData.user.id);
  if (!schoolId) {
    return { error: 'No school tenant context found.' };
  }

  // Verify target teacher belongs to this school
  const { data: targetPerson } = await supabase
    .from('people')
    .select('id, role, school_id')
    .eq('id', personId)
    .eq('school_id', schoolId)
    .maybeSingle();

  if (!targetPerson) {
    return { error: 'Staff member does not belong to your school.' };
  }

  try {
    const now = new Date();
    // Check if after 8:00 AM for late calculation if not explicitly set
    let finalStatus = status;
    const hours = now.getHours();
    const minutes = now.getMinutes();
    if (hours > 8 || (hours === 8 && minutes > 0)) {
      finalStatus = 'late';
    }

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

export async function getSchoolBalance() {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return { error: 'Unauthorized' };

  const schoolId = await getEffectiveSchoolId(supabase, userData.user.id);
  if (!schoolId) return { error: 'No school tenant context found.' };

  try {
    const publicAdmin = createPublicAdminClient();
    const { data: wallet } = await publicAdmin
      .from('wallets')
      .select('balance')
      .eq('tenant_id', schoolId)
      .maybeSingle();

    return { balance: wallet?.balance !== null && wallet?.balance !== undefined ? Number(wallet.balance) : 0 };
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
    return { error: 'Unauthorized' };
  }

  const schoolId = await getEffectiveSchoolId(supabase, userData.user.id);
  if (!schoolId) {
    return { error: 'No school context resolved for this account.' };
  }

  const { data: school } = await supabase
    .from('schools')
    .select('id, settings')
    .eq('id', schoolId)
    .maybeSingle();

  if (!school) {
    return { error: 'School record not found.' };
  }

  // Strict lookup from public.tenants where id = school.id using public admin client (bypasses schema & RLS)
  let tenantCode = "";
  try {
    const { data: tenantData, error: tenantErr } = await publicAdmin
      .from('tenants')
      .select('id, code, name')
      .eq('id', school.id)
      .maybeSingle() as any;

    if (tenantData?.code) {
      tenantCode = tenantData.code;
    } else {
      return { 
        error: `Invalid tenant: No record found in public.tenants matching school ID '${school.id}'. Please ensure the school ID exists in public.tenants.` 
      };
    }
  } catch (err) {
    console.error('Error querying public.tenants table:', err);
    return { error: 'Failed to query tenant record from database.' };
  }

  // Ensure row exists in public.wallets for school.id
  let walletId = "";
  try {
    const { data: existingWallet } = await publicAdmin
      .from('wallets')
      .select('id, balance')
      .eq('tenant_id', school.id)
      .maybeSingle();

    if (existingWallet?.id) {
      walletId = existingWallet.id;
    } else {
      const generatedWalletId = crypto.randomUUID();
      const { data: createdWallet, error: walletInsertErr } = await publicAdmin
        .from('wallets')
        .insert({
          id: generatedWalletId,
          tenant_id: school.id,
          balance: school.settings?.balance || 0,
          currency: 'UGX',
          sms_rate: 50
        })
        .select('id')
        .maybeSingle();

      if (createdWallet?.id) {
        walletId = createdWallet.id;
      } else {
        walletId = generatedWalletId;
        console.warn('Wallet creation note:', walletInsertErr);
      }
    }
  } catch (wErr) {
    console.error('Error ensuring public.wallets record:', wErr);
  }

  // Format phone number to standard international format (+256...) if needed
  const formattedPhone = phoneNumber.startsWith('0') ? `+256${phoneNumber.slice(1)}` : phoneNumber;

  // Generate unique idempotency key
  const idempotencyKey = `sch_topup_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  const endpointUrl = process.env.NAJIKI_API_URL || 'https://najiki.vercel.app/api/payments';
  const apiKey = process.env.NAJIKI_API_KEY || 'test_key';

  const payload = {
    applicationCode: process.env.NAJIKI_APP_CODE || "school",
    paymentTypeCode: "general",
    externalEntityId: school.id,
    amount: amount,
    currency: "UGX",
    phoneNumber: formattedPhone,
    idempotencyKey: idempotencyKey,
    tenantCode: tenantCode,
    metadata: {
      type: "topup",
      schoolId: school.id
    }
  };

  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-Tenant-Code': tenantCode
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
      console.error('[NaJiki API] Failed to parse JSON response. Raw text:', textData.substring(0, 200));
      if (!response.ok) {
         return { error: `Payment service returned an invalid response (Status ${response.status}). Please try again.` };
      }
    }

    if (!response.ok) {
      console.error(`[NaJiki TopUp API] Failed with status ${response.status}`, resData);
      return { 
        error: resData.message || resData.error || 'Payment initiation failed. Please check your phone number and try again.' 
      };
    }

    return {
      success: true,
      transactionId: resData.transactionId || idempotencyKey,
      message: 'Mobile Money prompt sent to your phone! Please enter your PIN to authorize payment.'
    };
  } catch (err: any) {
    console.error('NaJiki TopUp API error:', err);
    return { error: 'Network error communicating with payment provider.' };
  }
}
