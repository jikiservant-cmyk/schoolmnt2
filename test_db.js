const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
sb.rpc('credit_wallet', { p_school_id: 'test', p_amount: 100, p_tx_ref: 'test' }).then(console.log).catch(console.error);
