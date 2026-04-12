import { isMissingAccessTierColumnError } from '@/lib/accessTierDb';
import { supabase } from '@/lib/supabase';

/** 兼容 PostgREST/驱动返回的 boolean，避免字符串 "false" 被当成 true */
export function parsePermBool(v: unknown): boolean {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0' || s === '') return false;
  }
  return Boolean(v);
}

export type AccessTier = 'family' | 'auxiliary';

export function parseAccessTier(v: unknown): AccessTier | null {
  if (v === 'family' || v === 'auxiliary') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'family') return 'family';
    if (s === 'auxiliary') return 'auxiliary';
  }
  return null;
}

/** 无 access_tier 列或值为空时，由 perm_* 推断（与权限页逻辑一致） */
export function deriveAccessTierFromLegacyPerms(data: {
  access_tier?: unknown;
  perm_ai_limited?: unknown;
  perm_ai_full?: unknown;
  perm_upload?: unknown;
  perm_reminder?: unknown;
  perm_view_files?: unknown;
} | null | undefined): AccessTier | null {
  if (!data) return null;
  const fromCol = parseAccessTier(data.access_tier);
  if (fromCol) return fromCol;
  if (parsePermBool(data.perm_ai_limited)) return 'auxiliary';
  if (
    parsePermBool(data.perm_ai_full) ||
    parsePermBool(data.perm_upload) ||
    parsePermBool(data.perm_reminder) ||
    parsePermBool(data.perm_view_files)
  ) {
    return 'family';
  }
  return null;
}

const USERS_SELECT_WITH_TIER =
  'family_id, name, role, access_tier, perm_ai_full, perm_ai_limited, perm_upload, perm_reminder, perm_view_files';
const USERS_SELECT_NO_TIER =
  'family_id, name, role, perm_ai_full, perm_ai_limited, perm_upload, perm_reminder, perm_view_files';

/** 与「我的 / 权限」页一致的当前用户家庭权限快照（来自 public.users + families） */
export type FamilyAccessState = {
  userId: string;
  familyId: string | null;
  familyName: string | null;
  familyCreatedBy: string | null;
  adminDisplayName: string | null;
  role: string;
  /** 家庭权限 | 辅助权限；未配置为 null */
  accessTier: AccessTier | null;
  perm_ai_full: boolean;
  perm_ai_limited: boolean;
  perm_upload: boolean;
  perm_reminder: boolean;
  perm_view_files: boolean;
};

export async function loadFamilyAccess(): Promise<FamilyAccessState | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  let u:
    | {
        family_id?: string | null;
        name?: string | null;
        role?: string | null;
        access_tier?: unknown;
        perm_ai_full?: unknown;
        perm_ai_limited?: unknown;
        perm_upload?: unknown;
        perm_reminder?: unknown;
        perm_view_files?: unknown;
      }
    | null = null;
  const resTier = await supabase.from('users').select(USERS_SELECT_WITH_TIER).eq('id', user.id).maybeSingle();
  if (resTier.error && isMissingAccessTierColumnError(resTier.error)) {
    const resNo = await supabase.from('users').select(USERS_SELECT_NO_TIER).eq('id', user.id).maybeSingle();
    if (resNo.error) return null;
    u = resNo.data;
  } else if (resTier.error) {
    return null;
  } else {
    u = resTier.data;
  }

  const familyId = u?.family_id ?? null;
  let familyName: string | null = null;
  let familyCreatedBy: string | null = null;
  let adminDisplayName: string | null = null;

  if (familyId) {
    const { data: fam } = await supabase
      .from('families')
      .select('name, created_by')
      .eq('id', familyId)
      .maybeSingle();
    familyName = fam?.name ?? null;
    familyCreatedBy = fam?.created_by ?? null;
    if (familyCreatedBy) {
      const { data: ad } = await supabase
        .from('users')
        .select('name')
        .eq('id', familyCreatedBy)
        .maybeSingle();
      adminDisplayName = ad?.name?.trim() || null;
    }
  }

  return {
    userId: user.id,
    familyId,
    familyName,
    familyCreatedBy,
    adminDisplayName,
    role: typeof u?.role === 'string' ? u.role : 'member',
    accessTier: deriveAccessTierFromLegacyPerms(u),
    perm_ai_full: parsePermBool(u?.perm_ai_full),
    perm_ai_limited: parsePermBool(u?.perm_ai_limited),
    perm_upload: parsePermBool(u?.perm_upload),
    perm_reminder: parsePermBool(u?.perm_reminder),
    perm_view_files: parsePermBool(u?.perm_view_files),
  };
}

/** 非创建者且尚未分配 access_tier、五项均为关：等待管理员在「权限」中配置 */
export function isWelcomePending(a: FamilyAccessState | null): boolean {
  if (!a?.familyId) return false;
  if (a.userId === (a.familyCreatedBy || '')) return false;
  if (a.accessTier === 'family' || a.accessTier === 'auxiliary') return false;
  return (
    !a.perm_ai_full &&
    !a.perm_ai_limited &&
    !a.perm_upload &&
    !a.perm_reminder &&
    !a.perm_view_files
  );
}

/** 辅助账号：仅聊天等，不进入记录 Tab */
export function isAuxiliaryAccess(a: FamilyAccessState | null): boolean {
  return a?.accessTier === 'auxiliary';
}

/**
 * 记录 Tab：仅「辅助权限」隐藏；「家庭权限」始终可见。
 * 无 access_tier 的旧数据：有任一项家庭类权限则显示记录入口。
 */
export function showRecordsTab(a: FamilyAccessState | null): boolean {
  if (!a) return true;
  if (a.accessTier === 'auxiliary') return false;
  if (a.accessTier === 'family') return true;
  return a.perm_reminder || a.perm_view_files || a.perm_upload || a.perm_ai_full;
}

/** 「我的」中家庭资料入口：家庭权限可见；辅助权限不可见 */
export function showFamilyFilesMenu(a: FamilyAccessState | null): boolean {
  if (!a) return false;
  if (a.accessTier === 'auxiliary') return false;
  if (a.accessTier === 'family') return true;
  return a.perm_upload || a.perm_view_files;
}

/** 记录页「回顾」子页：家庭权限可见 */
export function showRecordsReviewTab(a: FamilyAccessState | null): boolean {
  if (!a) return false;
  if (a.accessTier === 'auxiliary') return false;
  if (a.accessTier === 'family') return true;
  return a.perm_view_files;
}

/** 记录页「提醒」子页：家庭权限可见 */
export function showRecordsReminderTab(a: FamilyAccessState | null): boolean {
  if (!a) return false;
  if (a.accessTier === 'auxiliary') return false;
  if (a.accessTier === 'family') return true;
  return a.perm_reminder;
}
