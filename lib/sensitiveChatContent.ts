/**
 * 聊天输入侧本地粗检：疑似银行卡号、口令、平台密钥/Token、私钥等。
 * 仅作启发式拦截，可能有误杀或漏网；命中后不应把原文落库或发给第三方模型。
 */

function normalizeSpaces(s: string): string {
  return s.replace(/\s/g, '');
}

/** @returns true 时应拦截本条发送（不存档、不调用模型） */
export function shouldBlockSensitiveChatInput(text: string): boolean {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  const compact = normalizeSpaces(raw);

  /** 银行卡常见 16–19 位；允许空格、连字符分隔 */
  const cardLike = raw.match(/\d[\d\s-]{14,}\d/g);
  if (cardLike) {
    for (const seg of cardLike) {
      const d = seg.replace(/\D/g, '');
      if (d.length >= 16 && d.length <= 19) return true;
    }
  }
  if (/\d{16,19}/.test(compact)) return true;

  /** 常见密钥 / Token 形态 */
  if (/sk-[A-Za-z0-9]{16,}/.test(raw)) return true;
  if (/sk_live_[A-Za-z0-9]{10,}/i.test(raw)) return true;
  if (/AKIA[0-9A-Z]{16}/.test(compact)) return true;
  if (/xox[baprs]-[A-Za-z0-9-]{10,}/i.test(raw)) return true;
  if (/ghp_[A-Za-z0-9]{20,}/i.test(raw)) return true;
  if (/gho_[A-Za-z0-9]{20,}/i.test(raw)) return true;
  if (/Bearer\s+eyJ[\w-]+\.[\w-]+\.[\w-]+/i.test(raw)) return true;
  if (/["']?authorization["']?\s*[:=]\s*["']Bearer\s+[^"'\s]{12,}/i.test(raw)) return true;
  if (/(api[_-]?key|apikey|client[_-]?secret|secret[_-]?key)\s*[:=]\s*\S{8,}/i.test(raw)) return true;

  if (/-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i.test(raw)) return true;

  /** 中文语境下明确的「账号/密码 + 冒号后的取值」 */
  if (/密码\s*[:：是为]\s*\S{6,}/.test(raw)) return true;
  if (/登录口令|登陆密码|访问密码/.test(raw) && /[:：是]\s*\S{6,}/.test(raw)) return true;
  if (/(账号|帐号|用户名)\s*[:：]\s*\S{2,}.{0,40}(密码|口令)\s*[:：]\s*\S{4,}/is.test(raw)) return true;

  return false;
}
