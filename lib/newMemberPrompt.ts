import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY_PREFIX = 'aiwojia:declineNewMemberNames:';

export function normalizeUnknownMemberName(raw: string): string {
  return raw.trim().replace(/\s+/g, '');
}

/**
 * 明显职场/公务敬称，不触发「是否添加家庭成员」询问。
 * 与意图分类器提示一致，并在客户端再拦一层以防模型误判。
 */
export function isWorkplaceHonorific(name: string): boolean {
  const n = normalizeUnknownMemberName(name);
  if (n.length < 2) return false;
  if (/^.+总$/.test(n)) return true;
  const suffixes = [
    '局长',
    '科长',
    '处长',
    '厅长',
    '部长',
    '主任',
    '经理',
    '总监',
    '园长',
    '校长',
    '院长',
    '书记',
    '董秘',
  ];
  return suffixes.some(s => n.endsWith(s));
}

function storageKey(userId: string) {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

export async function loadDeclinedNewMemberNames(userId: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(userId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return [...new Set(arr.map(normalizeUnknownMemberName).filter(Boolean))];
  } catch {
    return [];
  }
}

export async function recordDeclinedNewMemberName(userId: string, name: string): Promise<void> {
  const key = normalizeUnknownMemberName(name);
  if (!key || !userId) return;
  const list = await loadDeclinedNewMemberNames(userId);
  if (list.includes(key)) return;
  list.push(key);
  await AsyncStorage.setItem(storageKey(userId), JSON.stringify(list));
}
