-- 同家庭内可读取其他成员的 users 行（家庭成员页「APP账户」等）
-- 注意：不得在 users 的 RLS 策略里再子查询 users，否则会触发「infinite recursion detected in policy for relation users」，
-- 导致 users、family_members 等依赖「查自己 family_id」的语句全部失败、列表为空。
-- 做法：SECURITY DEFINER 函数内读 users（绕过 RLS），策略里只调用该函数比较 family_id。

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

COMMENT ON FUNCTION public.current_user_family_id() IS
  '当前登录用户在 public.users 中的 family_id；供 RLS 使用，避免 users 策略嵌套查询 users 导致递归';

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

COMMENT ON POLICY "users_select_same_family" ON public.users IS
  '同 family_id 可读彼此 users 行；依赖 current_user_family_id() 避免策略递归';
