import type { SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

function edgeHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${supabaseAnonKey}`,
    apikey: supabaseAnonKey,
  };
}

async function postFunction(name: string, body: object): Promise<Record<string, unknown>> {
  const res = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method: 'POST',
    headers: edgeHeaders(),
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const msg = typeof json.error === 'string' ? json.error : `请求失败（${res.status}）`;
    throw new Error(msg);
  }
  return json;
}

/** 与 Edge Functions 内校验规则一致（中国大陆 11 位手机号）。 */
export function normalizeChinaPhone(raw: string): { e164: string; digits11: string } | null {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return { e164: `+86${d}`, digits11: d };
  if (d.length === 13 && d.startsWith('86')) {
    const rest = d.slice(2);
    if (rest.length === 11 && rest.startsWith('1')) return { e164: `+86${rest}`, digits11: rest };
  }
  return null;
}

// Apple review test account: phone=13800000001, code=888888
const TEST_PHONE = '13800000001';
const TEST_CODE = '888888';
const TEST_EMAIL = 'test_13800000001@aiwojia.internal';
const TEST_PASSWORD = 'review_888888';

export async function sendPhoneOtp(phoneInput: string): Promise<void> {
  const digits = String(phoneInput).replace(/\D/g, '').replace(/^86/, '');
  if (digits === TEST_PHONE) return; // test account, skip SMS
  await postFunction('send-phone-otp', { phone: phoneInput });
}

export type VerifyPhoneOtpResult = { email: string };

/**
 * 调用 verify-phone-otp 后用 Supabase Auth 建立本地会话（register_channel: sms 的用户为 synthetic email）。
 */

export async function verifyPhoneOtpAndSignIn(
  client: SupabaseClient,
  phoneInput: string,
  code: string,
): Promise<VerifyPhoneOtpResult> {
  const digits = String(phoneInput).replace(/\D/g, '').replace(/^86/, '');
  if (digits === TEST_PHONE && code.trim() === TEST_CODE) {
    const { error } = await client.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    if (error) throw new Error('测试账号登录失败');
    return { email: TEST_EMAIL };
  }

  const json = await postFunction('verify-phone-otp', { phone: phoneInput, code });
  const access_token = typeof json.access_token === 'string' ? json.access_token : '';
  const refresh_token = typeof json.refresh_token === 'string' ? json.refresh_token : '';
  if (access_token && refresh_token) {
    const { error } = await client.auth.setSession({ access_token, refresh_token });
    if (error) throw error;
    const email = typeof json.email === 'string' ? json.email : '';
    return { email };
  }

  const email = typeof json.email === 'string' ? json.email : '';
  const token_hash = typeof json.token_hash === 'string' ? json.token_hash : null;
  const email_otp = typeof json.email_otp === 'string' ? json.email_otp : null;
  if (!email) throw new Error('登录失败：未返回账号信息');

  let lastErr: Error | null = null;

  if (token_hash) {
    const { error } = await client.auth.verifyOtp({ token_hash, type: 'magiclink' });
    if (!error) return { email };
    lastErr = error;
  }

  if (email_otp) {
    const { error } = await client.auth.verifyOtp({ email, token: email_otp, type: 'email' });
    if (!error) return { email };
    lastErr = error;
  }

  throw lastErr ?? new Error('登录失败：无法建立会话');
}

/** 写入业务表 `users.phone` 时使用，避免把 synthetic email 当成手机号。 */
export function profilePhoneFromAuthUser(user: {
  phone?: string | null;
  user_metadata?: Record<string, unknown> | null;
}): string | null {
  if (user.phone) return user.phone;
  const meta = user.user_metadata?.phone_e164;
  if (typeof meta === 'string' && meta.length > 0) return meta;
  return null;
}
