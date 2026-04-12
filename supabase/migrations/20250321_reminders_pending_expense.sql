-- 待办缴费：完成提醒后再写入 finance_transactions；未完成不落流水
ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS pending_expense_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS pending_expense_category text,
  ADD COLUMN IF NOT EXISTS linked_event_id uuid REFERENCES public.family_events (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.reminders.pending_expense_amount IS '完成提醒时写入财务流水的金额；有值表示尚未记支出';
COMMENT ON COLUMN public.reminders.pending_expense_category IS '与 finance_transactions.category 一致';
COMMENT ON COLUMN public.reminders.linked_event_id IS '关联本次 AI 写入的 family_events，便于完成时关联';
