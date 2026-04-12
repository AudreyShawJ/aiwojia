import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { aliyunPnvsSendSmsVerifyCode } from '../_shared/aliyun-sms.ts';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';

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

Deno.serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  let body: { phone?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const norm = normalizeChinaPhone(body.phone || '');
  if (!norm) {
    return jsonResponse({ error: '请输入有效的中国大陆手机号' }, 400);
  }

  const accessKeyId = (Deno.env.get('ALIYUN_ACCESS_KEY_ID') || '').trim();
  const accessKeySecret = (Deno.env.get('ALIYUN_ACCESS_KEY_SECRET') || '').trim();
  const signNameRaw = (Deno.env.get('ALIYUN_SMS_SIGN_NAME') || '').trim();
  // 判断是否是 base64 编码（仅 Base64 字符集则按 base64 解码为 UTF-8 中文签名）
  let signName: string;
  try {
    signName = /^[A-Za-z0-9+/=]+$/.test(signNameRaw)
      ? new TextDecoder().decode(Uint8Array.from(atob(signNameRaw), c => c.charCodeAt(0)))
      : signNameRaw;
  } catch {
    signName = signNameRaw;
  }
  const templateCode = (Deno.env.get('ALIYUN_SMS_TEMPLATE_CODE') || '').trim();
  const pepper = Deno.env.get('SMS_OTP_PEPPER') || '';

  if (!accessKeyId || !accessKeySecret || !signName || !templateCode || !pepper) {
    console.error('[send-phone-otp] missing Aliyun or SMS_OTP_PEPPER env');
    return jsonResponse({ error: '服务端短信未配置完成' }, 503);
  }

  console.log('[send-phone-otp] env check:', {
    signName,
    signNameBytes: [...new TextEncoder().encode(signName)],
    templateCode,
  });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const now = Date.now();
  const { data: lastRows } = await sb
    .from('phone_otp_challenges')
    .select('created_at')
    .eq('phone_e164', norm.e164)
    .order('created_at', { ascending: false })
    .limit(1);

  const last = lastRows?.[0] as { created_at: string } | undefined;
  if (last && now - new Date(last.created_at).getTime() < 55_000) {
    return jsonResponse({ error: '发送过于频繁，请稍后再试' }, 429);
  }

  const validMinutes = 5;
  const validSeconds = validMinutes * 60;
  const expiresAt = new Date(now + validMinutes * 60 * 1000).toISOString();

  const pnvsFlag = (Deno.env.get('ALIYUN_USE_PNVS_SMS_AUTH') || '').trim().toLowerCase();
  const usePnvs = pnvsFlag === 'true' || pnvsFlag === '1' || pnvsFlag === 'yes';
  const omitMinRaw = (Deno.env.get('ALIYUN_PNVS_TEMPLATE_OMIT_MIN') || '').trim().toLowerCase();
  const pnvsOmitMin = omitMinRaw === 'true' || omitMinRaw === '1' || omitMinRaw === 'yes';
  const explicitRaw = (Deno.env.get('ALIYUN_PNVS_EXPLICIT_CODE') || '').trim().toLowerCase();
  const pnvsExplicit = explicitRaw === 'true' || explicitRaw === '1' || explicitRaw === 'yes';

  /** 未开 ALIYUN_USE_PNVS_SMS_AUTH 时仍走号码认证 SendSmsVerifyCode（免资质不能用 dysms SendSms）；服务端明文码 + 自建库校验 */
  if (!usePnvs) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await sha256hex(`${code}:${norm.e164}:${pepper}`);
    const { error: insErr } = await sb.from('phone_otp_challenges').insert({
      phone_e164: norm.e164,
      code_hash: codeHash,
      expires_at: expiresAt,
    });
    if (insErr) {
      console.error('[send-phone-otp] insert', insErr);
      return jsonResponse({ error: '记录验证码失败' }, 500);
    }
    const templateParamPnvsDefault: Record<string, string> = pnvsOmitMin
      ? { code }
      : { code, min: String(validMinutes) };
    console.log('[send-phone-otp] sms channel: pnvs SendSmsVerifyCode (explicit code, usePnvs=false)');
    console.log(
      '[send-phone-otp] sending with params:',
      JSON.stringify({
        phoneNumber11: norm.digits11,
        signName,
        templateCode,
        templateParam: templateParamPnvsDefault,
      }),
    );
    const ali = await aliyunPnvsSendSmsVerifyCode({
      accessKeyId,
      accessKeySecret,
      phoneNumber11: norm.digits11,
      signName,
      templateCode,
      templateParam: templateParamPnvsDefault,
      validTimeSeconds: validSeconds,
      codeLength: 6,
      intervalSeconds: 60,
      returnVerifyCode: false,
    });
    if (!ali.ok) {
      console.error('[send-phone-otp] Aliyun', ali);
      return jsonResponse({ error: `短信发送失败：${ali.message}` }, 502);
    }
    return jsonResponse({ ok: true });
  }

  /** 号码认证：默认阿里云生成 ##code##（适配多数赠送模板）；显式 ALIYUN_PNVS_EXPLICIT_CODE 可走明文码 */
  const templateParamPlaceholder: Record<string, string> = pnvsOmitMin
    ? { code: '##code##' }
    : { code: '##code##', min: String(validMinutes) };

  if (pnvsExplicit) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const templateParamPnvs: Record<string, string> = pnvsOmitMin ? { code } : { code, min: String(validMinutes) };
    const codeHash = await sha256hex(`${code}:${norm.e164}:${pepper}`);
    const { error: insErr } = await sb.from('phone_otp_challenges').insert({
      phone_e164: norm.e164,
      code_hash: codeHash,
      expires_at: expiresAt,
    });
    if (insErr) {
      console.error('[send-phone-otp] insert', insErr);
      return jsonResponse({ error: '记录验证码失败' }, 500);
    }
    console.log('[send-phone-otp] sms channel: pnvs explicit code');
    console.log(
      '[send-phone-otp] sending with params:',
      JSON.stringify({
        phoneNumber11: norm.digits11,
        signName,
        templateCode,
        templateParam: templateParamPnvs,
      }),
    );
    const ali = await aliyunPnvsSendSmsVerifyCode({
      accessKeyId,
      accessKeySecret,
      phoneNumber11: norm.digits11,
      signName,
      templateCode,
      templateParam: templateParamPnvs,
      validTimeSeconds: validSeconds,
      codeLength: 6,
      intervalSeconds: 60,
      returnVerifyCode: false,
    });
    if (!ali.ok) {
      console.error('[send-phone-otp] Aliyun', ali);
      return jsonResponse({ error: `短信发送失败：${ali.message}` }, 502);
    }
    return jsonResponse({ ok: true });
  }

  console.log('[send-phone-otp] sms channel: pnvs ##code## + ReturnVerifyCode');
  console.log(
    '[send-phone-otp] sending with params:',
    JSON.stringify({
      phoneNumber11: norm.digits11,
      signName,
      templateCode,
      templateParam: templateParamPlaceholder,
    }),
  );

  const ali = await aliyunPnvsSendSmsVerifyCode({
    accessKeyId,
    accessKeySecret,
    phoneNumber11: norm.digits11,
    signName,
    templateCode,
    templateParam: templateParamPlaceholder,
    validTimeSeconds: validSeconds,
    codeLength: 6,
    intervalSeconds: 60,
    returnVerifyCode: true,
    codeType: '1',
  });

  if (!ali.ok) {
    console.error('[send-phone-otp] Aliyun', ali);
    return jsonResponse({ error: `短信发送失败：${ali.message}` }, 502);
  }

  const code = String(ali.verifyCode || '').trim();
  if (!/^\d{6}$/.test(code)) {
    console.error('[send-phone-otp] unexpected VerifyCode shape', code);
    return jsonResponse({ error: '短信服务未返回有效验证码' }, 502);
  }

  const codeHash = await sha256hex(`${code}:${norm.e164}:${pepper}`);
  const { error: insErr } = await sb.from('phone_otp_challenges').insert({
    phone_e164: norm.e164,
    code_hash: codeHash,
    expires_at: expiresAt,
  });

  if (insErr) {
    console.error('[send-phone-otp] insert after sms', insErr);
    return jsonResponse({ error: '记录验证码失败' }, 500);
  }

  return jsonResponse({ ok: true });
});
