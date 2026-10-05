-- Functions a typical production project of this app already has (the
-- original webhook called public.credit_wallet). Created the way Supabase
-- creates them by default: SECURITY DEFINER and EXECUTE granted to PUBLIC.
CREATE OR REPLACE FUNCTION public.credit_wallet(p_school_id uuid, p_amount numeric, p_tx_ref text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE w uuid; nb numeric;
BEGIN
  SELECT id INTO w FROM public.wallets WHERE tenant_id = p_school_id OR school_id = p_school_id ORDER BY balance DESC NULLS LAST LIMIT 1;
  IF w IS NULL THEN
    INSERT INTO public.wallets(id, tenant_id, school_id, balance, currency) VALUES (gen_random_uuid(), p_school_id, p_school_id, 0, 'UGX') RETURNING id INTO w;
  END IF;
  UPDATE public.wallets SET balance = coalesce(balance, 0) + p_amount WHERE id = w RETURNING balance INTO nb;
  INSERT INTO public.transactions(wallet_id, amount, type, reference, status) VALUES (w, p_amount, 'credit', p_tx_ref, 'completed');
  RETURN nb;
END $$;
