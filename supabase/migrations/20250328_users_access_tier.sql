-- access_tier: family | auxiliary | NULL (pending admin assign)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS access_tier text;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_access_tier_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_access_tier_check
  CHECK (access_tier IS NULL OR access_tier IN ('family', 'auxiliary'));

COMMENT ON COLUMN public.users.access_tier IS 'family | auxiliary; NULL = not set by admin';

-- creators -> family
UPDATE public.users u
SET access_tier = 'family'
WHERE u.access_tier IS NULL
  AND u.family_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.families f
    WHERE CAST(f.id AS text) = CAST(u.family_id AS text)
      AND f.created_by IS NOT NULL
      AND CAST(u.id AS text) = CAST(f.created_by AS text)
  );

-- perm_ai_limited -> auxiliary
UPDATE public.users u
SET access_tier = 'auxiliary'
WHERE u.access_tier IS NULL
  AND u.family_id IS NOT NULL
  AND COALESCE(u.perm_ai_limited, false) = true;

-- other non-creator members with any perm -> family
UPDATE public.users u
SET access_tier = 'family'
WHERE u.access_tier IS NULL
  AND u.family_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.families f
    WHERE CAST(f.id AS text) = CAST(u.family_id AS text)
      AND f.created_by IS NOT NULL
      AND CAST(u.id AS text) = CAST(f.created_by AS text)
  )
  AND (
    COALESCE(u.perm_ai_full, false)
    OR COALESCE(u.perm_upload, false)
    OR COALESCE(u.perm_reminder, false)
    OR COALESCE(u.perm_view_files, false)
  );
