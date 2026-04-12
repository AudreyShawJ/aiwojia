/**
 * 阿里云一句话识别（短语音 REST API）
 * 文档：https://help.aliyun.com/zh/isi/developer-reference/short-sentence-recognition
 *
 * 客户端 POST JSON:
 *   { audio: "<base64 PCM/WAV>", format: "wav", sampleRate: 16000 }
 *
 * 响应:
 *   { text: "识别结果" }  或  { error: "..." }
 */

import { corsHeaders, jsonResponse } from '../_shared/cors.ts';

const ENDPOINT = 'https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/asr';

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

function percentEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

/** 生成阿里云 Token（NLS 服务需要 token 而非直接签名） */
async function getAliyunToken(accessKeyId: string, accessKeySecret: string): Promise<string> {
  const tokenEndpoint = 'https://nls-meta.cn-shanghai.aliyuncs.com/';
  const nonce = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const params: Record<string, string> = {
    AccessKeyId: accessKeyId,
    Action: 'CreateToken',
    Format: 'JSON',
    RegionId: 'cn-shanghai',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: nonce,
    SignatureVersion: '1.0',
    Timestamp: timestamp,
    Version: '2019-02-28',
  };

  const sorted = Object.keys(params).sort();
  const canonical = sorted
    .map(k => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonical)}`;
  const signature = await hmacSha1Base64(`${accessKeySecret}&`, stringToSign);
  params.Signature = signature;

  const qs = Object.keys(params)
    .sort()
    .map(k => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');

  const res = await fetch(`${tokenEndpoint}?${qs}`, { method: 'GET' });
  const json = await res.json() as { Token?: { Id?: string }; message?: string };
  if (!json.Token?.Id) {
    throw new Error(`获取 Token 失败: ${json.message || JSON.stringify(json)}`);
  }
  return json.Token.Id;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const accessKeyId = Deno.env.get('ALIYUN_ACCESS_KEY_ID');
  const accessKeySecret = Deno.env.get('ALIYUN_ACCESS_KEY_SECRET');
  const appKey = Deno.env.get('ALIYUN_NLS_APP_KEY');

  if (!accessKeyId || !accessKeySecret || !appKey) {
    return jsonResponse({ error: '服务配置缺失' }, 500);
  }

  let body: { audio?: string; format?: string; sampleRate?: number };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  if (!body.audio) {
    return jsonResponse({ error: '缺少 audio 字段' }, 400);
  }

  const format = body.format ?? 'wav';
  const sampleRate = body.sampleRate ?? 16000;

  // base64 → binary
  const binaryStr = atob(body.audio);
  const audioBytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    audioBytes[i] = binaryStr.charCodeAt(i);
  }

  try {
    // 获取临时 Token（有效期 24h，可按需缓存，这里每次获取简化逻辑）
    const token = await getAliyunToken(accessKeyId, accessKeySecret);

    const url =
      `${ENDPOINT}?appkey=${appKey}&token=${token}&format=${format}&sample_rate=${sampleRate}` +
      `&enable_punctuation_prediction=true&enable_inverse_text_normalization=true`;

    const asrRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: audioBytes,
    });

    const asrJson = await asrRes.json() as {
      status?: number;
      message?: string;
      result?: string;
    };

    if (asrJson.status === 20000000 && asrJson.result !== undefined) {
      return jsonResponse({ text: asrJson.result ?? '' });
    }

    return jsonResponse(
      { error: asrJson.message || `ASR 错误 status=${asrJson.status}` },
      502,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse({ error: msg }, 500);
  }
});
