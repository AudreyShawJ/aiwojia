-- ============================================================
-- Storage bucket: family-documents
-- 应用内路径规则：{family_id}/{timestamp}.{ext}（见 app/chat、family-files、documents）
-- 仅允许：当前登录用户在其 users.family_id 对应「文件夹」下读/写/删
-- ============================================================
-- 前置：Dashboard → Storage 中已创建 bucket，名称必须为 family-documents
-- 若 bucket 设为 Public：任意人拿到完整 URL 仍可直链访问（与旧版行为一致）；策略仍限制 API 列出/上传路径
-- ============================================================

DROP POLICY IF EXISTS "family_documents_select_own_family" ON storage.objects;
DROP POLICY IF EXISTS "family_documents_insert_own_family" ON storage.objects;
DROP POLICY IF EXISTS "family_documents_update_own_family" ON storage.objects;
DROP POLICY IF EXISTS "family_documents_delete_own_family" ON storage.objects;

-- 读（列表、下载、生成签名 URL 等经 Storage API 的请求）
CREATE POLICY "family_documents_select_own_family"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'family-documents'
    AND split_part(name, '/', 1) = (
      SELECT u.family_id::text
      FROM public.users u
      WHERE u.id = auth.uid()
      LIMIT 1
    )
  );

-- 上传：路径第一段必须是自己所在家庭 id
CREATE POLICY "family_documents_insert_own_family"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'family-documents'
    AND split_part(name, '/', 1) = (
      SELECT u.family_id::text
      FROM public.users u
      WHERE u.id = auth.uid()
      LIMIT 1
    )
  );

CREATE POLICY "family_documents_update_own_family"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'family-documents'
    AND split_part(name, '/', 1) = (
      SELECT u.family_id::text
      FROM public.users u
      WHERE u.id = auth.uid()
      LIMIT 1
    )
  )
  WITH CHECK (
    bucket_id = 'family-documents'
    AND split_part(name, '/', 1) = (
      SELECT u.family_id::text
      FROM public.users u
      WHERE u.id = auth.uid()
      LIMIT 1
    )
  );

CREATE POLICY "family_documents_delete_own_family"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'family-documents'
    AND split_part(name, '/', 1) = (
      SELECT u.family_id::text
      FROM public.users u
      WHERE u.id = auth.uid()
      LIMIT 1
    )
  );
