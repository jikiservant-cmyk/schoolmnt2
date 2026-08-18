'use server';

import { createClient } from '@/utils/supabase/server';
import { createPublicAdminClient } from '@/utils/supabase/admin';
import { revalidatePath } from 'next/cache';

async function getEffectiveSchoolId(supabase: any, userId?: string) {
  if (userId) {
    try {
      const { data: staffData } = await supabase
        .from('staff_users')
        .select('person_id, people(school_id)')
        .eq('auth_user_id', userId)
        .maybeSingle();

      if (staffData?.people?.school_id) {
        return staffData.people.school_id;
      }
    } catch (err) {
      console.error('Error resolving staff_users:', err);
    }
  }

  try {
    const { data: recentLog } = await supabase
      .from('attendance_logs')
      .select('school_id')
      .not('school_id', 'is', null)
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentLog?.school_id) {
      return recentLog.school_id;
    }

    const { data: personSchool } = await supabase
      .from('people')
      .select('school_id')
      .not('school_id', 'is', null)
      .limit(1)
      .maybeSingle();

    if (personSchool?.school_id) {
      return personSchool.school_id;
    }

    const { data: school } = await supabase
      .from('schools')
      .select('id')
      .limit(1)
      .maybeSingle();

    if (school?.id) {
      return school.id;
    }
  } catch (err) {
    console.error('Error resolving default school:', err);
  }

  return null;
}

export async function getAttendanceData() {
  const supabase = await createClient();
  
  const { data: userData } = await supabase.auth.getUser();
  const schoolId = await getEffectiveSchoolId(supabase, userData?.user?.id);

  // 1. Get attendance logs (all recent logs with full people and class details)
  let logs: any[] = [];
  if (schoolId) {
    const { data, error } = await supabase
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

    if (!error && data && data.length > 0) {
      logs = data;
    }
  }
  
  if (logs.length === 0) {
    // Fallback: fetch all recent attendance logs regardless of school_id filter
    const { data, error } = await supabase
      .from('attendance_logs')
      .select(`
        *,
        people:people (
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
      .order('occurred_at', { ascending: false })
      .limit(500);

    if (!error && data) {
      logs = data;
    }
  }

  // 2. Fetch classes
  let classes: any[] = [];
  if (schoolId) {
    const { data } = await supabase.from('classes').select('id, name').eq('school_id', schoolId).order('name');
    if (data && data.length > 0) classes = data;
  }
  if (classes.length === 0) {
    const { data } = await supabase.from('classes').select('id, name').order('name');
    if (data) classes = data;
  }

  // 3. Fetch all registered people (students, teachers, support_staff, admins)
  let people: any[] = [];
  if (schoolId) {
    const { data } = await supabase.from('people').select(`
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
      `).eq('school_id', schoolId).order('full_name');
    if (data && data.length > 0) people = data;
  }
  if (people.length === 0) {
    const { data } = await supabase.from('people').select(`
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
      `).order('full_name');
    if (data) people = data;
  }

  // 4. Fetch school details
  let school: any = null;
  if (schoolId) {
    const { data } = await supabase
      .from('schools')
      .select('id, name, settings')
      .eq('id', schoolId)
      .maybeSingle();

    if (data) {
      school = data;
    }
  }

  if (!school) {
    const { data } = await supabase
      .from('schools')
      .select('id, name, settings')
      .limit(1)
      .maybeSingle();

    if (data) {
      school = data;
    }
  }

  // Ensure balance is loaded from public.wallets table for accuracy
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

export async function topUpBalance(amount: number, phoneNumber: string) {
  const supabase = await createClient();
  const publicAdmin = createPublicAdminClient();
  
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { error: 'Unauthorized' };
  }

  const schoolId = await getEffectiveSchoolId(supabase, userData.user.id);

  let school: any = null;
  if (schoolId) {
    const { data } = await supabase
      .from('schools')
      .select('id, settings')
      .eq('id', schoolId)
      .maybeSingle();
    school = data;
  }

  if (!school) {
    const { data } = await supabase
      .from('schools')
      .select('id, settings')
      .limit(1)
      .maybeSingle();
    school = data;
  }

  if (!school) {
    return { error: 'No school found to top up balance' };
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

  const najikiDomain = process.env.NAJIKI_DOMAIN || 'api.najiki.com';
  const najikiUrl = najikiDomain.startsWith('http') ? najikiDomain : `https://${najikiDomain}`;
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
    const response = await fetch(`${najikiUrl}/api/v1/payments/collect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-Tenant-Code': tenantCode
      },
      body: JSON.stringify(payload)
    });

    const resData = await response.json();

    if (!response.ok) {
      return { 
        error: resData.message || 'Payment initiation failed. Please check your phone number and try again.' 
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
