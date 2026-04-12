import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { LogBox, Platform } from 'react-native';

/**
 * 刷新会话失败时库仍会 console.error，避免开发模式红屏刷屏。
 * iOS：SecureStore 在自动刷新 tick、设备锁屏/前后台切换时可能短时读钥匙串失败（User interaction is not allowed），属瞬态。
 */
LogBox.ignoreLogs([
  /Invalid Refresh Token/i,
  /Refresh Token Not Found/i,
  /Auto refresh tick failed/i,
  /User interaction is not allowed/i,
  /getValueWithKeyAsync/i,
]);

/**
 * iOS 默认 keychain 为 WHEN_UNLOCKED，在后台自动 refreshSession 读 token 时易触发
 * "User interaction is not allowed"。AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY 允许「重启后首次解锁」后即可读，更适配自动刷新。
 * （已存旧条目仍为旧属性；用户重新登录或清除会话后会按新策略写入。）
 */
const secureStoreOpts: SecureStore.SecureStoreOptions | undefined =
  Platform.OS === 'ios'
    ? { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }
    : undefined;

const ExpoSecureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key, secureStoreOpts),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value, secureStoreOpts),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key, secureStoreOpts),
};

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

function isAuthTokenUrl(input: RequestInfo | URL): boolean {
  try {
    const u = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    return u.includes('/auth/v1/token');
  } catch {
    return false;
  }
}

function isRefreshTokenFailureBody(status: number, json: unknown): boolean {
  if (status !== 400 && status !== 401) return false;
  if (!json || typeof json !== 'object') return false;
  const o = json as Record<string, unknown>;
  const err = String(o.error || '').toLowerCase();
  const desc = String(o.error_description || o.message || '').toLowerCase();
  if (err === 'invalid_grant') return true;
  return desc.includes('refresh') && (desc.includes('invalid') || desc.includes('not found'));
}

function isInvalidStoredSessionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const m = String((err as { message?: string }).message ?? err).toLowerCase();
  return m.includes('invalid refresh token') || m.includes('refresh token not found');
}

const clientRef: { current: SupabaseClient | null } = { current: null };

const supabaseFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (clientRef.current && isAuthTokenUrl(input) && (res.status === 400 || res.status === 401)) {
    try {
      const j = await res.clone().json();
      if (isRefreshTokenFailureBody(res.status, j)) {
        void clientRef.current.auth.signOut({ scope: 'local' });
      }
    } catch {
      /* 非 JSON 或解析失败则忽略 */
    }
  }
  return res;
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: { fetch: supabaseFetch },
  auth: {
    storage: ExpoSecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

clientRef.current = supabase;

void supabase.auth.getSession().then(({ error }) => {
  if (error && isInvalidStoredSessionError(error)) {
    void supabase.auth.signOut({ scope: 'local' });
  }
});
