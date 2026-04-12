-- 手机短信验证码挑战（仅服务端 Edge Function 通过 service_role 写入/读取；匿名用户无策略即不可访问）
CREATE TABLE IF NOT EXISTS public.phone_otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_phone_otp_phone_created
  ON public.phone_otp_challenges (phone_e164, created_at DESC);

ALTER TABLE public.phone_otp_challenges ENABLE ROW LEVEL SECURITY;
