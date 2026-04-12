/**
 * 全家共享的 family_events / 提醒：入库前把「我妈、我爸」等换成成员姓名，避免其他家人误读为「自己」的父母。
 * 对话上下文里为「配偶听对方记录」追加硬性听众提示，防止模型对妻子说「你的爸爸」等。
 */

export type MemberBrief = { name: string; role: string };

export type MemberWithLink = MemberBrief & { linked_user_id?: string | null };

function pickAmongMoms(candidates: MemberBrief[], recorderRole: string | null): MemberBrief | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const r = recorderRole || '';
  const isHusband = /丈夫|老公|先生/.test(r);
  const isWife = /妻子|老婆|太太/.test(r);
  if (isHusband) {
    const byPo = candidates.find(m => /婆婆/.test(m.name + m.role));
    if (byPo) return byPo;
  }
  if (isWife) {
    const noPo = candidates.find(m => !/婆婆/.test(m.name + m.role));
    if (noPo) return noPo;
  }
  return candidates[0];
}

function pickAmongDads(candidates: MemberBrief[], recorderRole: string | null): MemberBrief | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const r = recorderRole || '';
  const isHusband = /丈夫|老公|先生/.test(r);
  const isWife = /妻子|老婆|太太/.test(r);
  if (isHusband) {
    const byGong = candidates.find(m => /公公/.test(m.name + m.role));
    if (byGong) return byGong;
  }
  if (isWife) {
    const noGong = candidates.find(m => !/公公/.test(m.name + m.role));
    if (noGong) return noGong;
  }
  return candidates[0];
}

/**
 * 由 related_member 与成员表解析应用作替换的「当事人姓名」（须与成员 name 一致以便列表展示）。
 * related_member 为空时，从 title/description 中是否出现「我爸爸、我妈」等推断。
 */
export function resolveSubjectNameForSharedRecord(
  relatedMemberRaw: string,
  members: MemberBrief[],
  recorderLinkedRole: string | null,
  fallbackTitle?: string,
  fallbackDescription?: string
): string {
  let raw = (relatedMemberRaw || '').trim();
  if (!raw) {
    const blob = `${fallbackTitle || ''}${fallbackDescription || ''}`;
    if (/(我的爸爸|我的父亲|我爸爸|我爸|我爹)/.test(blob)) raw = '我爸';
    else if (/(我的妈妈|我的母亲|我妈妈|我妈)/.test(blob)) raw = '我妈';
  }
  if (!raw) return '';

  const exact = members.find(m => (m.name || '').trim() === raw);
  if (exact) return exact.name.trim();

  const momToken = /^(我的?妈妈|我的母亲|我妈|我妈妈)$/;
  const dadToken = /^(我的?爸爸|我的父亲|我爸|我爸爸|我爹)$/;

  if (momToken.test(raw)) {
    const moms = members.filter(
      m =>
        /妈妈|母亲|婆婆/.test(m.role || '') ||
        /妈妈|母亲|婆婆/.test(m.name || '')
    );
    const picked = pickAmongMoms(moms, recorderLinkedRole);
    return picked?.name.trim() || '';
  }

  if (dadToken.test(raw)) {
    const dads = members.filter(
      m =>
        /爸爸|父亲|公公/.test(m.role || '') ||
        /爸爸|父亲/.test(m.name || '')
    );
    const picked = pickAmongDads(dads, recorderLinkedRole);
    return picked?.name.trim() || '';
  }

  return raw;
}

/** 将 title/description 中的第一人称父母称呼替换为 subjectName（须非空） */
export function stripDeicticKinshipForSharedRecord(
  title: string,
  description: string,
  subjectName: string
): { title: string; description: string } {
  const sub = (subjectName || '').trim();
  if (!sub) return { title, description };

  const replacers: Array<[RegExp, string]> = [
    [/我的妈妈/g, sub],
    [/我的母亲/g, sub],
    [/我妈妈/g, sub],
    [/我妈/g, sub],
    [/我的爸爸/g, sub],
    [/我的父亲/g, sub],
    [/我爸爸/g, sub],
    [/我爸/g, sub],
    [/我爹/g, sub],
  ];

  let t = title;
  let d = description;
  for (const [re, s] of replacers) {
    t = t.replace(re, s);
    d = d.replace(re, s);
  }
  return { title: t, description: d };
}

export function stripDeicticKinshipInPlainText(text: string, subjectName: string): string {
  const sub = (subjectName || '').trim();
  if (!sub) return text;
  let out = text;
  const replacers: Array<[RegExp, string]> = [
    [/我的妈妈/g, sub],
    [/我的母亲/g, sub],
    [/我妈妈/g, sub],
    [/我妈/g, sub],
    [/我的爸爸/g, sub],
    [/我的父亲/g, sub],
    [/我爸爸/g, sub],
    [/我爸/g, sub],
    [/我爹/g, sub],
  ];
  for (const [re, s] of replacers) {
    out = out.replace(re, s);
  }
  return out;
}

/**
 * 记录人 ≠ 当前提问者且为夫妻另一方时，注入「对当前听众」的硬性表述规则（给主模型读）。
 */
export type CrossPerspectiveRoleFallback = {
  /** users 表 role，在尚未关联 family_members 时备用 */
  listenerRoleFromUser?: string | null;
  recorderRoleFromUser?: string | null;
};

export function buildHistoryLineCrossPerspectiveNote(
  createdBy: string | null | undefined,
  relatedMember: string | null | undefined,
  title: string | null | undefined,
  members: MemberWithLink[],
  currentUserId: string | undefined | null,
  roleFallback?: CrossPerspectiveRoleFallback | null,
  description?: string | null
): string {
  if (!currentUserId || !createdBy || createdBy === currentUserId) return '';

  const recorderRow = members.find(m => m.linked_user_id === createdBy);
  const listenerRow = members.find(m => m.linked_user_id === currentUserId);
  const recorderRole = (
    recorderRow?.role ||
    roleFallback?.recorderRoleFromUser ||
    ''
  ).trim();
  const listenerRole = (
    listenerRow?.role ||
    roleFallback?.listenerRoleFromUser ||
    ''
  ).trim();
  if (!recorderRole || !listenerRole) return '';

  const relName = (relatedMember || '').trim();
  const subject = relName ? members.find(m => (m.name || '').trim() === relName) : null;
  /** 须含 description：模型常把细节写在描述里 */
  const blob = `${title || ''}${description || ''}`;

  /**
   * 根因修复：原先 infer 要求 !subject。若 related_member 被误填成「妻子父亲」等，subject 非空则
   * 标题里的「我妈」永不触发推断，系统注缺失，主模型会把「晓老：」当成脱发当事人。
   * 现改为：标题/描述里出现第一人称父母用语时，与 subject 角色一并参与判断（OR 合并）。
   */
  const inferDadRaw = /(我的爸爸|我的父亲|我爸爸|我爸|我爹)/.test(blob);
  const inferMomRaw = /(我的妈妈|我的母亲|我妈妈|我妈)/.test(blob);
  /** 历史行经消解后写入的短注，等价于「记录人自述父/母辈」 */
  const metaPaternal = /丈夫自述父亲辈|自述父亲辈/.test(blob);
  const metaMaternal = /丈夫自述母亲辈|妻子自述母亲辈|自述母亲辈/.test(blob);

  const rolePack = (subject?.role || '') + (subject?.name || '');
  const paternal =
    /爸爸|父亲|爹/.test(rolePack) || (!!subject && /公公/.test(rolePack)) || inferDadRaw || metaPaternal;
  const maternal =
    /妈妈|母亲/.test(rolePack) || (!!subject && /婆婆|岳母/.test(rolePack)) || inferMomRaw || metaMaternal;

  if (paternal && maternal) return '';

  const recH = /丈夫|老公|先生/.test(recorderRole);
  const recW = /妻子|老婆|太太/.test(recorderRole);
  const lisH = /丈夫|老公|先生/.test(listenerRole);
  const lisW = /妻子|老婆|太太/.test(listenerRole);

  if (recH && paternal && !maternal && lisW) {
    return '〔→**当前向你提问的用户是妻子**：本条为**丈夫**记录、涉其**生父**一辈；回答须用「你爱人的爸爸/公公」等，**禁止**说「你的爸爸」。〕';
  }
  if (recH && maternal && !paternal && lisW) {
    return '〔→**当前提问者为妻子**：本条为**丈夫**记录、涉其**生母**一辈；须用「你爱人的妈妈/婆婆」，**禁止**说「你的妈妈」。〕';
  }
  if (recW && paternal && !maternal && lisH) {
    return '〔→**当前提问者为丈夫**：本条为**妻子**记录、涉其**生父**一辈；须用「你爱人的爸爸/岳父」等，**禁止**说「你的爸爸」。〕';
  }
  if (recW && maternal && !paternal && lisH) {
    return '〔→**当前提问者为丈夫**：本条为**妻子**记录、涉其**生母**一辈；须用「你爱人的妈妈/岳母」，**禁止**说「你的妈妈」。〕';
  }

  return '';
}
