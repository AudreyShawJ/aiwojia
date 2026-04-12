/**
 * 阿里云短信 SendSms（RPC 风格 GET + HMAC-SHA1）
 * 文档：https://help.aliyun.com/document_detail/101343.html
 */

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
}

async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function buildStringToSign(method: string, params: Record<string, string>): string {
  const sorted = Object.keys(params).sort();
  const canonical = sorted.map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  return `${method}&${percentEncode('/')}&${percentEncode(canonical)}`;
}

export type SendSmsParams = {
  accessKeyId: string;
  accessKeySecret: string;
  /** 国内 11 位，无 +86 */
  phoneNumbers11: string;
  signName: string;
  templateCode: string;
  /** 模板变量键名须与控制台一致，例如 { code, min } */
  templateParam: Record<string, string>;
  regionId?: string;
};

export async function aliyunSendSms(p: SendSmsParams): Promise<{ ok: boolean; message: string; requestId?: string }> {
  const regionId = p.regionId || Deno.env.get('ALIYUN_SMS_REGION') || 'cn-hangzhou';
  const nonce = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const query: Record<string, string> = {
    AccessKeyId: p.accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: p.phoneNumbers11,
    RegionId: regionId,
    SignName: p.signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: nonce,
    SignatureVersion: '1.0',
    TemplateCode: p.templateCode,
    TemplateParam: JSON.stringify(p.templateParam),
    Timestamp: timestamp,
    Version: '2017-05-25',
  };

  const stringToSign = buildStringToSign('GET', query);
  const signature = await hmacSha1Base64(`${p.accessKeySecret}&`, stringToSign);
  query.Signature = signature;

  const url =
    'https://dysmsapi.aliyuncs.com/?' +
    Object.keys(query)
      .sort()
      .map(k => `${percentEncode(k)}=${percentEncode(query[k])}`)
      .join('&');

  const res = await fetch(url, { method: 'GET' });
  const json = (await res.json()) as {
    Message?: string;
    Code?: string;
    RequestId?: string;
    BizId?: string;
  };

  if (json.Code === 'OK') {
    return { ok: true, message: 'OK', requestId: json.RequestId };
  }
  return {
    ok: false,
    message: json.Message || json.Code || `HTTP ${res.status}`,
    requestId: json.RequestId,
  };
}

/** 号码认证 - 短信认证（SendSmsVerifyCode），与短信服务 SendSms 不同产品、不同 Endpoint */
export type PnvsSendSmsVerifyCodeParams = {
  accessKeyId: string;
  accessKeySecret: string;
  /** 国内 11 位，不含国家码 */
  phoneNumber11: string;
  countryCode?: string;
  signName: string;
  templateCode: string;
  templateParam: Record<string, string>;
  /** 验证码有效秒数，与业务表 expires_at 对齐 */
  validTimeSeconds?: number;
  codeLength?: number;
  /** 发送间隔秒（接口频控，默认 60） */
  intervalSeconds?: number;
  regionId?: string;
  /**
   * true：按官方推荐由阿里云生成验证码（TemplateParam 里 code 填 ##code##），响应 Model.VerifyCode 可取回明文。
   * false：TemplateParam 传具体数字（部分赠送模板不接受明文，会报签名或模板无效）。
   */
  returnVerifyCode?: boolean;
  /** returnVerifyCode 为 true 时必填，默认 1=纯数字 */
  codeType?: string;
};

/**
 * https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode
 * RAM 需 dypns:SendSmsVerifyCode（如 AliyunDypnsFullAccess）。
 */
export async function aliyunPnvsSendSmsVerifyCode(
  p: PnvsSendSmsVerifyCodeParams,
): Promise<{ ok: boolean; message: string; requestId?: string; verifyCode?: string }> {
  const regionId = p.regionId || Deno.env.get('ALIYUN_PNVS_REGION') || Deno.env.get('ALIYUN_SMS_REGION') || 'cn-hangzhou';
  const nonce = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const validTime = String(p.validTimeSeconds ?? 300);
  const codeLen = String(p.codeLength ?? 6);
  const interval = String(p.intervalSeconds ?? 60);
  const wantReturn = p.returnVerifyCode === true;

  const query: Record<string, string> = {
    AccessKeyId: p.accessKeyId,
    Action: 'SendSmsVerifyCode',
    CountryCode: p.countryCode || '86',
    Format: 'JSON',
    PhoneNumber: p.phoneNumber11,
    RegionId: regionId,
    SignName: p.signName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: nonce,
    SignatureVersion: '1.0',
    TemplateCode: p.templateCode,
    TemplateParam: JSON.stringify(p.templateParam),
    Timestamp: timestamp,
    Version: '2017-05-25',
    CodeLength: codeLen,
    ValidTime: validTime,
    DuplicatePolicy: '1',
    Interval: interval,
    ReturnVerifyCode: wantReturn ? 'true' : 'false',
  };

  if (wantReturn) {
    query.CodeType = p.codeType ?? '1';
  }

  const stringToSign = buildStringToSign('GET', query);
  const signature = await hmacSha1Base64(`${p.accessKeySecret}&`, stringToSign);
  query.Signature = signature;

  const url =
    'https://dypnsapi.aliyuncs.com/?' +
    Object.keys(query)
      .sort()
      .map(k => `${percentEncode(k)}=${percentEncode(query[k])}`)
      .join('&');

  const res = await fetch(url, { method: 'GET' });
  const json = (await res.json()) as {
    Message?: string;
    Code?: string;
    RequestId?: string;
    Success?: boolean;
    Model?: { VerifyCode?: string };
  };

  console.log('[aliyun-pnvs] raw response:', JSON.stringify(json), 'status:', res.status);

  if (json.Code === 'OK' && json.Success !== false) {
    const verifyCode = json.Model?.VerifyCode;
    return {
      ok: true,
      message: 'OK',
      requestId: json.RequestId,
      verifyCode: wantReturn ? verifyCode : undefined,
    };
  }
  return {
    ok: false,
    message: json.Message || json.Code || `HTTP ${res.status}`,
    requestId: json.RequestId,
  };
}
