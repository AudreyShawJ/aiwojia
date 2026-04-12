/** 与 App 内 lib/phoneAuth.ts 保持一致（手机账号对应 Auth email） */
export const SMS_EMAIL_DOMAIN = 'sms.auth.aiwojia.app';

export function syntheticEmailFromDigits11(digits11: string): string {
  return `86${digits11}@${SMS_EMAIL_DOMAIN}`;
}
