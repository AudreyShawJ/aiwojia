-- ============================================================
-- users 表增加 avatar_url 字段
-- Storage bucket: avatars（public）
-- 路径规则：avatars/{user_id}/avatar.{ext}
-- ============================================================

-- 1. users 表加字段
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_url text;

-- 2. Storage RLS：用户只能读写自己的头像目录
--    bucket 需在 Dashboard → Storage 中创建，名称：avatars，设为 Public
DROP POLICY IF EXISTS "avatars_select_own" ON storage.objects;
DROP POLICY IF EXISTS "avatars_insert_own" ON storage.objects;
DROP POLICY IF EXISTS "avatars_update_own" ON storage.objects;
DROP POLICY IF EXISTS "avatars_delete_own" ON storage.objects;

CREATE POLICY "avatars_select_own"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND split_part(name, '/', 2) = auth.uid()::text
  );

CREATE POLICY "avatars_insert_own"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND split_part(name, '/', 2) = auth.uid()::text
  );

CREATE POLICY "avatars_update_own"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND split_part(name, '/', 2) = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND split_part(name, '/', 2) = auth.uid()::text
  );

CREATE POLICY "avatars_delete_own"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND split_part(name, '/', 2) = auth.uid()::text
  );
