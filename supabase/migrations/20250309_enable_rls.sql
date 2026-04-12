-- ============================================================
-- 启用 RLS 并创建策略，解决 Supabase 安全警示
-- 在 Supabase Dashboard -> SQL Editor 中执行此文件
-- 全部使用 CAST(x AS text) 显式转换，避免 text=uuid 错误
-- ============================================================

-- ============================================================
-- 1. users 表
-- ============================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_select_own" ON public.users
  FOR SELECT USING ( CAST(auth.uid() AS text) = CAST(id AS text) );

CREATE POLICY "users_insert_own" ON public.users
  FOR INSERT WITH CHECK ( CAST(auth.uid() AS text) = CAST(id AS text) );

CREATE POLICY "users_update_own" ON public.users
  FOR UPDATE USING ( CAST(auth.uid() AS text) = CAST(id AS text) );

-- ============================================================
-- 2. families 表
-- ============================================================
ALTER TABLE public.families ENABLE ROW LEVEL SECURITY;

CREATE POLICY "families_select_member" ON public.families
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND (
      (SELECT CAST(u.family_id AS text) FROM public.users u WHERE CAST(u.id AS text) = CAST(auth.uid() AS text) LIMIT 1) = CAST(families.id AS text)
      OR CAST(families.created_by AS text) = CAST(auth.uid() AS text)
    )
  );

CREATE POLICY "families_insert_authenticated" ON public.families
  FOR INSERT WITH CHECK ( auth.uid() IS NOT NULL AND CAST(created_by AS text) = CAST(auth.uid() AS text) );

CREATE POLICY "families_update_creator" ON public.families
  FOR UPDATE USING ( CAST(created_by AS text) = CAST(auth.uid() AS text) );

-- RPC：通过邀请码获取家庭（用于加入流程）
CREATE OR REPLACE FUNCTION public.get_family_by_invite_code(p_code text)
RETURNS TABLE(id uuid, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT f.id, f.name FROM families f
  WHERE CAST(f.invite_code AS text) = upper(trim(p_code))
  LIMIT 1;
$$;

-- ============================================================
-- 3. family_members 表
-- ============================================================
ALTER TABLE public.family_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "family_members_all" ON public.family_members
  FOR ALL USING (
    auth.uid() IS NOT NULL
    AND (SELECT CAST(u.family_id AS text) FROM public.users u WHERE CAST(u.id AS text) = CAST(auth.uid() AS text) LIMIT 1) = CAST(family_members.family_id AS text)
  );

-- ============================================================
-- 4. conversations 表
-- ============================================================
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversations_all" ON public.conversations
  FOR ALL USING (
    auth.uid() IS NOT NULL
    AND CAST(conversations.user_id AS text) = CAST(auth.uid() AS text)
  );

-- ============================================================
-- 5. messages 表
-- ============================================================
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "messages_select" ON public.messages
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE CAST(c.id AS text) = CAST(messages.conversation_id AS text)
        AND CAST(c.user_id AS text) = CAST(auth.uid() AS text)
    )
  );

CREATE POLICY "messages_insert" ON public.messages
  FOR INSERT WITH CHECK (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE CAST(c.id AS text) = CAST(messages.conversation_id AS text)
        AND CAST(c.user_id AS text) = CAST(auth.uid() AS text)
    )
  );

CREATE POLICY "messages_update" ON public.messages
  FOR UPDATE USING (
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE CAST(c.id AS text) = CAST(messages.conversation_id AS text)
        AND CAST(c.user_id AS text) = CAST(auth.uid() AS text)
    )
  );

-- ============================================================
-- 6. reminders 表
-- ============================================================
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reminders_all" ON public.reminders
  FOR ALL USING (
    auth.uid() IS NOT NULL
    AND (SELECT CAST(u.family_id AS text) FROM public.users u WHERE CAST(u.id AS text) = CAST(auth.uid() AS text) LIMIT 1) = CAST(reminders.family_id AS text)
  );

-- ============================================================
-- 7. family_events 表
-- ============================================================
ALTER TABLE public.family_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "family_events_all" ON public.family_events
  FOR ALL USING (
    auth.uid() IS NOT NULL
    AND (SELECT CAST(u.family_id AS text) FROM public.users u WHERE CAST(u.id AS text) = CAST(auth.uid() AS text) LIMIT 1) = CAST(family_events.family_id AS text)
  );

-- ============================================================
-- 8. child_growth 表
-- ============================================================
ALTER TABLE public.child_growth ENABLE ROW LEVEL SECURITY;

CREATE POLICY "child_growth_all" ON public.child_growth
  FOR ALL USING (
    auth.uid() IS NOT NULL
    AND (SELECT CAST(u.family_id AS text) FROM public.users u WHERE CAST(u.id AS text) = CAST(auth.uid() AS text) LIMIT 1) = CAST(child_growth.family_id AS text)
  );

-- ============================================================
-- 8b. finance_transactions 表（需先执行 20250310_finance_transactions.sql 建表）
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'finance_transactions') THEN
    ALTER TABLE public.finance_transactions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "finance_transactions_all" ON public.finance_transactions;
    CREATE POLICY "finance_transactions_all" ON public.finance_transactions
      FOR ALL USING (
        auth.uid() IS NOT NULL
        AND (SELECT CAST(u.family_id AS text) FROM public.users u WHERE CAST(u.id AS text) = CAST(auth.uid() AS text) LIMIT 1) = CAST(finance_transactions.family_id AS text)
      );
  END IF;
END $$;

-- ============================================================
-- 9. documents 表
-- ============================================================
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "documents_all" ON public.documents
  FOR ALL USING (
    auth.uid() IS NOT NULL
    AND (SELECT CAST(u.family_id AS text) FROM public.users u WHERE CAST(u.id AS text) = CAST(auth.uid() AS text) LIMIT 1) = CAST(documents.family_id AS text)
  );

-- ============================================================
-- 10. invitations 表（若存在）
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'invitations') THEN
    ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'family_id') THEN
      CREATE POLICY "invitations_family" ON public.invitations FOR ALL USING (
        auth.uid() IS NOT NULL
        AND (SELECT CAST(u.family_id AS text) FROM public.users u WHERE CAST(u.id AS text) = CAST(auth.uid() AS text) LIMIT 1) = CAST(invitations.family_id AS text)
      );
    ELSE
      CREATE POLICY "invitations_authenticated" ON public.invitations FOR ALL USING (auth.uid() IS NOT NULL);
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'invitations: %', SQLERRM;
END $$;

-- ============================================================
-- 11. records 表（若存在）
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'records') THEN
    ALTER TABLE public.records ENABLE ROW LEVEL SECURITY;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'records' AND column_name = 'family_id') THEN
      CREATE POLICY "records_family" ON public.records FOR ALL USING (
        auth.uid() IS NOT NULL
        AND (SELECT CAST(u.family_id AS text) FROM public.users u WHERE CAST(u.id AS text) = CAST(auth.uid() AS text) LIMIT 1) = CAST(records.family_id AS text)
      );
    ELSE
      CREATE POLICY "records_authenticated" ON public.records FOR ALL USING (auth.uid() IS NOT NULL);
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'records: %', SQLERRM;
END $$;

-- ============================================================
-- 12. event_versions 表（若存在）
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'event_versions') THEN
    ALTER TABLE public.event_versions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "event_versions_authenticated" ON public.event_versions FOR ALL USING (auth.uid() IS NOT NULL);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'event_versions: %', SQLERRM;
END $$;
