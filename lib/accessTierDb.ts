import type { PostgrestError } from '@supabase/supabase-js';

/** PostgreSQL undefined_column — 库尚未执行含 access_tier 的迁移时使用 */
export function isMissingAccessTierColumnError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as PostgrestError;
  return (
    err.code === '42703' &&
    typeof err.message === 'string' &&
    err.message.includes('access_tier')
  );
}
