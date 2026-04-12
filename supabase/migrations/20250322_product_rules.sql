-- 周期提醒：记录已完成次数
ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS completed_occurrence_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.reminders.completed_occurrence_count IS '周期提醒每次点「完成」递增，不结束整条提醒';
