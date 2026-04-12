-- 若已执行过「含 EXISTS 子查询 users」的旧版 20250324，会出现策略递归、家庭成员列表全空。
-- 本文件与修正后的 20250324 等价；已正确部署者可重复执行（幂等）。
-- 在 Dashboard SQL Editor 粘贴本文件或 20250324 修正版全文均可。

DROP POLICY IF EXISTS "users_select_same_family" ON public.users;

CREATE OR REPLACE FUNCTION public.current_user_family_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CAST(u.family_id AS text)
  FROM public.users u
  WHERE CAST(u.id AS text) = CAST(auth.uid() AS text)
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.current_user_family_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_family_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_family_id() TO service_role;

CREATE POLICY "users_select_same_family" ON public.users
  FOR SELECT
  USING (
    auth.uid() IS NOT NULL
    AND users.family_id IS NOT NULL
    AND public.current_user_family_id() IS NOT NULL
    AND CAST(users.family_id AS text) = public.current_user_family_id()
  );
