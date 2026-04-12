// 角色映射表
// roleMap[记录里的角色][当前用户的角色] = 显示称呼
const roleMap: Record<string, Record<string, string>> = {
  丈夫: {
    丈夫: '我',
    妻子: '老公',
    儿子: '爸爸',
    女儿: '爸爸',
    丈夫父亲: '儿子',
    丈夫母亲: '儿子',
    妻子父亲: '女婿',
    妻子母亲: '女婿',
    保姆: '爸爸',
    司机: '爸爸',
  },
  妻子: {
    丈夫: '老婆',
    妻子: '我',
    儿子: '妈妈',
    女儿: '妈妈',
    丈夫父亲: '儿媳',
    丈夫母亲: '儿媳',
    妻子父亲: '女儿',
    妻子母亲: '女儿',
    保姆: '妈妈',
    司机: '妈妈',
  },
  儿子: {
    丈夫: '儿子',
    妻子: '儿子',
    女儿: '哥哥',
    丈夫父亲: '孙子',
    丈夫母亲: '孙子',
    妻子父亲: '外孙',
    妻子母亲: '外孙',
    保姆: '儿子',
    司机: '儿子',
  },
  女儿: {
    丈夫: '女儿',
    妻子: '女儿',
    儿子: '姐姐',
    丈夫父亲: '孙女',
    丈夫母亲: '孙女',
    妻子父亲: '外孙女',
    妻子母亲: '外孙女',
    保姆: '女儿',
    司机: '女儿',
  },
  丈夫父亲: {
    丈夫: '爸爸',
    妻子: '公公',
    儿子: '爷爷',
    女儿: '爷爷',
    丈夫父亲: '我',
    丈夫母亲: '老伴',
    保姆: '爷爷',
    司机: '爷爷',
  },
  丈夫母亲: {
    丈夫: '妈妈',
    妻子: '婆婆',
    儿子: '奶奶',
    女儿: '奶奶',
    丈夫父亲: '老伴',
    丈夫母亲: '我',
    保姆: '奶奶',
    司机: '奶奶',
  },
  妻子父亲: {
    丈夫: '岳父',
    妻子: '爸爸',
    儿子: '外公',
    女儿: '外公',
    妻子父亲: '我',
    妻子母亲: '老伴',
    保姆: '外公',
    司机: '外公',
  },
  妻子母亲: {
    丈夫: '岳母',
    妻子: '妈妈',
    儿子: '外婆',
    女儿: '外婆',
    妻子父亲: '老伴',
    妻子母亲: '我',
    保姆: '外婆',
    司机: '外婆',
  },
  保姆: {
    丈夫: '保姆',
    妻子: '保姆',
    儿子: '保姆',
    女儿: '保姆',
    丈夫父亲: '保姆',
    丈夫母亲: '保姆',
    妻子父亲: '保姆',
    妻子母亲: '保姆',
    保姆: '我',
    司机: '保姆',
  },
  司机: {
    丈夫: '司机',
    妻子: '司机',
    儿子: '司机',
    女儿: '司机',
    丈夫父亲: '司机',
    丈夫母亲: '司机',
    妻子父亲: '司机',
    妻子母亲: '司机',
    保姆: '司机',
    司机: '我',
  },
};

// 兄弟姐妹特殊处理
const siblingMap: Record<string, Record<string, string>> = {
  儿子: {
    elder: '哥哥',
    younger: '弟弟',
  },
  女儿: {
    elder: '姐姐',
    younger: '妹妹',
  },
};

export type FamilyMember = {
  id: string;
  name: string;
  role: string;
  linked_user_id: string | null;
  sibling_order: string | null;
};

/**
 * 转换称呼
 * @param targetMember 记录里的成员
 * @param currentUserId 当前登录用户的id
 * @param currentUserRole 当前登录用户对应的角色
 * @param allMembers 家庭所有成员列表
 */
export function resolveDisplayName(
  targetMember: FamilyMember,
  currentUserId: string,
  currentUserRole: string,
  allMembers: FamilyMember[]
): string {
  // 如果是自己，直接返回「我」
  if (targetMember.linked_user_id === currentUserId) {
    return '我';
  }

  const targetRole = targetMember.role;

  // 兄弟姐妹特殊处理
  if (
    (targetRole === '儿子' || targetRole === '女儿') &&
    (currentUserRole === '儿子' || currentUserRole === '女儿')
  ) {
    const siblingOrder = targetMember.sibling_order;
    if (siblingOrder && siblingMap[targetRole]?.[siblingOrder]) {
      return siblingMap[targetRole][siblingOrder];
    }
  }

  // 查映射表
  const mapped = roleMap[targetRole]?.[currentUserRole];
  if (mapped) return mapped;

  // 找不到映射，返回原始名字
  return targetMember.name;
}

/**
 * 获取当前用户在家庭里的角色
 */
export function getCurrentUserRole(currentUserId: string, allMembers: FamilyMember[]): string | null {
  const linked = allMembers.find(m => m.linked_user_id === currentUserId);
  return linked?.role || null;
}
