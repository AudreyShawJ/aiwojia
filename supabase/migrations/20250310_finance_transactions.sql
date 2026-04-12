-- ============================================================
-- finance_transactions：家庭财务流水（与 family_events 解耦）
-- 在 Supabase SQL Editor 执行，或合并进现有迁移流程
-- ============================================================

CREATE TABLE IF NOT EXISTS public.finance_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  created_by uuid,
  conversation_id uuid,
  linked_event_id uuid,

  title text NOT NULL,
  description text,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  direction text NOT NULL CHECK (direction IN ('income', 'expense')),
  category text NOT NULL,
  currency text NOT NULL DEFAULT 'CNY',
  occurred_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'ai_extract',
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT finance_transactions_category_check CHECK (
    category IN (
      'health', 'child', 'finance', 'vehicle', 'house',
      'relationship', 'admin', 'plant_pet', 'daily'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_finance_transactions_family_occurred
  ON public.finance_transactions (family_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_finance_transactions_family_direction
  ON public.finance_transactions (family_id, direction, occurred_at DESC);

COMMENT ON TABLE public.finance_transactions IS '财务流水：主题、金额、收/支、分类、业务发生时间';
COMMENT ON COLUMN public.finance_transactions.title IS '主题/摘要，如「买菜」「工资到账」';
COMMENT ON COLUMN public.finance_transactions.direction IS 'income=收入 expense=支出';
COMMENT ON COLUMN public.finance_transactions.category IS '与 family_events.event_type 一致，用于回顾消费习惯汇总';
COMMENT ON COLUMN public.finance_transactions.occurred_at IS '业务发生时间（用户表述的日期，默认当天）';
COMMENT ON COLUMN public.finance_transactions.linked_event_id IS '若本次同时写入 family_events，可关联';

ALTER TABLE public.finance_transactions ENABLE ROW LEVEL SECURITY;

-- 若已先跑过 20250309_enable_rls.sql 且当时表已存在，策略可能已创建；先删再建避免 42710
DROP POLICY IF EXISTS "finance_transactions_all" ON public.finance_transactions;

CREATE POLICY "finance_transactions_all" ON public.finance_transactions
  FOR ALL USING (
    auth.uid() IS NOT NULL
    AND (
      SELECT CAST(u.family_id AS text)
      FROM public.users u
      WHERE CAST(u.id AS text) = CAST(auth.uid() AS text)
      LIMIT 1
    ) = CAST(finance_transactions.family_id AS text)
  );
