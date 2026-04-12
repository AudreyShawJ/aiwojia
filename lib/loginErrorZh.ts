/**
 * 登录/验证码相关：把 Supabase、网络、Edge 常见英文错误转为中文提示。
 */
export function loginErrorToChinese(err: unknown): string {
  const msg =
    err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string'
      ? String((err as { message: string }).message).trim()
      : typeof err === 'string'
        ? err.trim()
        : '';
  if (!msg) return '操作失败，请重试';

  const exact: Record<string, string> = {
    'Invalid login credentials': '邮箱或密码错误，请检查后重试',
    'Invalid email or password': '邮箱或密码错误，请检查后重试',
    'Email not confirmed': '请先在邮箱中完成验证后再登录',
    'User already registered': '该邮箱已注册，请直接登录',
    'Signups not allowed for this instance': '当前暂不支持新用户注册',
    'Password should be at least 6 characters': '密码至少需要 6 位',
    'Unable to validate email address: invalid format': '邮箱格式不正确',
    'Email rate limit exceeded': '操作过于频繁，请稍后再试',
    'Token has expired or is invalid': '验证码无效或已过期，请重新获取',
    'Invalid token': '验证码无效或已过期，请重新获取',
    'otp_expired': '验证码已过期，请重新获取',
    'For security purposes, you can only request this after': '请稍后再试',
    'Method not allowed': '请求方式不支持，请更新应用后重试',
    'Invalid JSON': '请求数据异常，请重试',
    'Request failed': '请求失败，请稍后再试',
  };
  if (exact[msg]) return exact[msg]!;

  const low = msg.toLowerCase();
  if (low.includes('invalid login credentials') || low.includes('invalid email or password')) {
    return '邮箱或密码错误，请检查后重试';
  }
  if (low.includes('email not confirmed')) return '请先在邮箱中完成验证后再登录';
  if (low.includes('user already registered')) return '该邮箱已注册，请直接登录';
  if (low.includes('signups not allowed')) return '当前暂不支持新用户注册';
  if (low.includes('password should be at least') || low.includes('at least 6 characters')) {
    return '密码至少需要 6 位';
  }
  if (low.includes('invalid format') && low.includes('email')) return '邮箱格式不正确';
  if (low.includes('rate limit') || low.includes('too many requests')) return '操作过于频繁，请稍后再试';
  if (
    low.includes('token has expired') ||
    low.includes('link is invalid or has expired') ||
    low.includes('invalid otp') ||
    low.includes('otp expired')
  ) {
    return '验证码无效或已过期，请重新获取';
  }
  if (
    low.includes('network request failed') ||
    low.includes('failed to fetch') ||
    low.includes('network error') ||
    low.includes('load failed')
  ) {
    return '网络连接失败，请检查网络后重试';
  }
  if (low.includes('timeout') || low.includes('timed out')) return '请求超时，请稍后再试';
  if (low.includes('method not allowed')) return '请求方式不支持，请更新应用后重试';
  if (low.includes('invalid json')) return '请求数据异常，请重试';
  if (low.startsWith('创建用户失败：')) {
    const tail = msg.replace(/^创建用户失败：/u, '');
    if (!tail || /[\u4e00-\u9fff]/.test(tail)) return msg;
    return '创建账号失败，请稍后再试或联系客服';
  }

  if (/[\u4e00-\u9fff]/.test(msg)) return msg;

  return '操作失败，请稍后再试';
}
