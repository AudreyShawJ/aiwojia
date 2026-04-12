-- APP 版本管理表（用于客户端检查更新）
CREATE TABLE IF NOT EXISTS public.app_versions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform      text        NOT NULL CHECK (platform IN ('android', 'ios')),
  version_name  text        NOT NULL,          -- 展示版本号，如 "1.2.0"
  version_code  integer     NOT NULL,          -- 内部版本号，整数递增，用于比较
  download_url  text        NOT NULL,          -- APK 下载直链（蒲公英或 OSS）
  release_notes text        NOT NULL DEFAULT '',  -- 更新内容描述
  force_update  boolean     NOT NULL DEFAULT false, -- 是否强制更新（不可跳过）
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 任何已登录用户均可读，只有 service_role 可写（后台维护）
ALTER TABLE public.app_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "app_versions_select"
  ON public.app_versions FOR SELECT
  TO authenticated
  USING (true);
