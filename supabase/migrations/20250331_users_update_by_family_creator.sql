-- 家庭创建者可更新同家庭其他成员的 users 行（用于「家庭成员 → 权限」中修改 access_tier / perm_*）
-- 原有 users_update_own 仅允许更新自己；管理员改他人权限时会被 RLS 静默拒绝（0 行），界面却可能仍提示已保存。

DROP POLICY IF EXISTS "users_update_by_family_creator" ON public.users;

CREATE POLICY "users_update_by_family_creator" ON public.users
  FOR UPDATE
  USING (
    auth.uid() IS NOT NULL
    AND users.family_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.families f
      WHERE CAST(f.id AS text) = CAST(users.family_id AS text)
        AND f.created_by IS NOT NULL
        AND CAST(f.created_by AS text) = CAST(auth.uid() AS text)
    )
  )
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND users.family_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.families f
      WHERE CAST(f.id AS text) = CAST(users.family_id AS text)
        AND f.created_by IS NOT NULL
        AND CAST(f.created_by AS text) = CAST(auth.uid() AS text)
    )
  );

COMMENT ON POLICY "users_update_by_family_creator" ON public.users IS
  '家庭创建者可更新同一 family_id 下成员账号；与 users_update_own 并存（本人改自己仍走原策略）';
