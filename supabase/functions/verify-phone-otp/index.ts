import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { syntheticEmailFromDigits11 } from '../_shared/sms-constants.ts';

function normalizeChinaPhone(raw: string): { e164: string; digits11: string } | null {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return { e164: `+86${d}`, digits11: d };
  if (d.length === 13 && d.startsWith('86')) {
    const rest = d.slice(2);
    if (rest.length === 11 && rest.startsWith('1')) return { e164: `+86${rest}`, digits11: rest };
  }
  return null;
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  let body: { phone?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const norm = normalizeChinaPhone(body.phone || '');
  const code = String(body.code || '').trim();
  if (!norm || !/^\d{6}$/.test(code)) {
    return jsonResponse({ error: '手机号或验证码格式不正确' }, 400);
  }

  const pepper = Deno.env.get('SMS_OTP_PEPPER') || '';
  if (!pepper) {
    return jsonResponse({ error: '服务端未配置 SMS_OTP_PEPPER' }, 503);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: rows, error: selErr } = await sb
    .from('phone_otp_challenges')
    .select('id, code_hash, expires_at, consumed_at')
    .eq('phone_e164', norm.e164)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(5);

  if (selErr || !rows?.length) {
    return jsonResponse({ error: '验证码无效或已过期' }, 400);
  }

  const now = new Date();
  const hash = await sha256hex(`${code}:${norm.e164}:${pepper}`);
  let matched: { id: string } | null = null;
  for (const r of rows as { id: string; code_hash: string; expires_at: string }[]) {
    if (new Date(r.expires_at) < now) continue;
    if (timingSafeEqualHex(hash, r.code_hash)) {
      matched = { id: r.id };
      break;
    }
  }

  if (!matched) {
    return jsonResponse({ error: '验证码错误或已过期' }, 400);
  }

  await sb.from('phone_otp_challenges').update({ consumed_at: now.toISOString() }).eq('id', matched.id);

  const email = syntheticEmailFromDigits11(norm.digits11);
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error: ce } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    phone: norm.e164,
    phone_confirm: true,
    user_metadata: { phone_e164: norm.e164, register_channel: 'sms' },
  });

  const dup =
    ce &&
    (String(ce.message).toLowerCase().includes('already') ||
      String(ce.message).toLowerCase().includes('registered') ||
      (ce as { code?: string }).code === 'email_exists');

  if (ce && !dup) {
    console.error('[verify-phone-otp] createUser', ce);
    return jsonResponse({ error: `创建用户失败：${ce.message}` }, 500);
  }

  const { data: link, error: le } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });

  if (le || !link?.properties) {
    console.error('[verify-phone-otp] generateLink', le);
    return jsonResponse({ error: le?.message || '签发登录链接失败' }, 500);
  }

  const props = link.properties as Record<string, string | undefined>;
  const token_hash = props.hashed_token;
  const email_otp = props.email_otp;

  return jsonResponse({
    email,
    token_hash: token_hash ?? null,
    email_otp: email_otp ?? null,
  });
});
