-- 用户点击「完成」时写入，供对话回顾「什么时候做的」；取消待办不写此字段
ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

COMMENT ON COLUMN public.reminders.completed_at IS '用户在记录/提醒页点「完成」的时刻；取消关闭的待办不填';
