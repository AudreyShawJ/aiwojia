-- 谁点的「完成」≠ 谁创建的待办（created_by）
ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS completed_by uuid REFERENCES public.users (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.reminders.completed_by IS '在 App 内点击「完成」时的登录用户 id；与 created_by 不同';
