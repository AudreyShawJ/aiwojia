/**
 * 写入 family_events 前的亲属消解：防止「我爸」挂靠到妻子父亲等跨桶错误；缺人时不硬填 related_member。
 */

import type { MemberBrief } from '@/lib/sharedRecordDeictic';

export type KinshipResolveResult = {
  storedRelatedMember: string;
  subjectNameForStrip: string;
  modelSuggestionRejected: boolean;
  /** 模型把当事人写成成员名但与指代冲突、或标题丢了「我妈」等时，用用户原话作入库标题 */
  canonTitleFromUtterance: string | null;
};

type Deictic = 'MY_FATHER' | 'MY_MOTHER';

function norm(s: string): string {
  return (s || '').trim();
}

/** 母系祖辈行（妻子侧父母）：丈夫侧「我爸」绝不能落到妻子父亲 */
function isMaternalGrandLine(m: MemberBrief): boolean {
  const role = m.role || '';
  const name = m.name || '';
  if (/妻子父亲|妻子母亲/.test(role)) return true;
  if (/外公|外婆/.test(role)) return true;
  return /外公|外婆/.test(name);
}

function isPaternalGrandLine(m: MemberBrief): boolean {
  const role = m.role || '';
  if (/妻子父亲|妻子母亲/.test(role)) return false;
  if (/丈夫父亲|丈夫母亲/.test(role)) return true;
  return /爷爷|奶奶/.test(role);
}

function isStaff(m: MemberBrief): boolean {
  return /保姆|司机/.test(m.role || '');
}

function speakerFlags(recorderLinkedRole: string | null): {
  isWife: boolean;
  isHusband: boolean;
  isChild: boolean;
} {
  const r = recorderLinkedRole || '';
  return {
    isWife: /妻子|老婆|太太/.test(r),
    isHusband: /丈夫|老公|先生/.test(r),
    isChild: /儿子|女儿|孩子|宝宝|娃/.test(r),
  };
}

/** 「本人父亲」候选：按记录人身份分桶 */
function candidatesMyFather(members: MemberBrief[], recorderLinkedRole: string | null): MemberBrief[] {
  const { isWife, isHusband, isChild } = speakerFlags(recorderLinkedRole);
  return members.filter(m => {
    if (isStaff(m)) return false;
    if (isPaternalGrandLine(m)) return false;
    if (isHusband || isChild || (!isWife && !isHusband)) {
      if (isMaternalGrandLine(m)) return false;
      return /爸爸|父亲/.test(m.role || '') || norm(m.name) === '爸爸';
    }
    // 妻子：允许「妻子父亲」表示其父亲（产品常见）
    if (isMaternalGrandLine(m)) {
      return /妻子父亲|外公/.test(m.role || '') || /外公/.test(m.name || '');
    }
    return /爸爸|父亲/.test(m.role || '') || norm(m.name) === '爸爸';
  });
}

/** 「本人母亲」候选 */
function candidatesMyMother(members: MemberBrief[], recorderLinkedRole: string | null): MemberBrief[] {
  const { isWife, isHusband, isChild } = speakerFlags(recorderLinkedRole);
  return members.filter(m => {
    if (isStaff(m)) return false;
    if (isPaternalGrandLine(m)) return false;
    if (isHusband || isChild || (!isWife && !isHusband)) {
      if (isMaternalGrandLine(m)) return false;
      if (/公公/.test(m.role + m.name)) return false;
      return /妈妈|母亲|婆婆/.test(m.role || '') || norm(m.name) === '妈妈';
    }
    // 妻子：允许「妻子母亲」表示其母亲
    if (/妻子母亲|外婆/.test(m.role || '') || /外婆/.test(m.name || '')) return true;
    if (/公公/.test(m.role + m.name)) return false;
    return /妈妈|母亲/.test(m.role || '') || norm(m.name) === '妈妈';
  });
}

/** 须与用户原话、标题一并检测，避免抽取模型改写标题后只剩成员名 */
function detectDeictic(
  modelRelated: string,
  title: string,
  description: string,
  utteranceText?: string | null
): Deictic | null {
  const mr = norm(modelRelated);
  if (/^(我的?爸爸|我的父亲|我爸爸|我爸|我爹)$/.test(mr)) return 'MY_FATHER';
  if (/^(我的?妈妈|我的母亲|我妈妈|我妈)$/.test(mr)) return 'MY_MOTHER';
  const blob = `${utteranceText || ''}${title || ''}${description || ''}`;
  if (/(我的爸爸|我的父亲|我爸爸|我爸|我爹)/.test(blob)) return 'MY_FATHER';
  if (/(我的妈妈|我的母亲|我妈妈|我妈)/.test(blob)) return 'MY_MOTHER';
  return null;
}

function hasFirstPersonParentPronounIn(s: string): boolean {
  return /(我的妈妈|我的母亲|我妈妈|我妈|我的爸爸|我的父亲|我爸爸|我爸|我爹)/.test(s || '');
}

function pickOne(candidates: MemberBrief[], recorderLinkedRole: string | null, kind: Deictic): MemberBrief | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const r = recorderLinkedRole || '';
  if (kind === 'MY_FATHER') {
    const isHusband = /丈夫|老公|先生/.test(r);
    const isWife = /妻子|老婆|太太/.test(r);
    if (isHusband) {
      const gong = candidates.find(m => /公公/.test(m.name + m.role));
      if (gong) return gong;
    }
    if (isWife) {
      const wg = candidates.find(m => /妻子父亲|外公/.test(m.name + m.role));
      if (wg) return wg;
      const noGong = candidates.find(m => !/公公/.test(m.name + m.role));
      if (noGong) return noGong;
    }
    return candidates[0];
  }
  // MY_MOTHER
  const isHusbandM = /丈夫|老公|先生/.test(r);
  const isWifeM = /妻子|老婆|太太/.test(r);
  if (isHusbandM) {
    const po = candidates.find(m => /婆婆/.test(m.name + m.role));
    if (po) return po;
  }
  if (isWifeM) {
    const wm = candidates.find(m => /妻子母亲|外婆/.test(m.name + m.role));
    if (wm) return wm;
    const noPo = candidates.find(m => !/婆婆/.test(m.name + m.role));
    if (noPo) return noPo;
  }
  return candidates[0];
}

function memberByExactName(members: MemberBrief[], name: string): MemberBrief | null {
  const n = norm(name);
  if (!n) return null;
  return members.find(m => norm(m.name) === n) || null;
}

function allowedListForDeictic(d: Deictic, members: MemberBrief[], role: string | null): MemberBrief[] {
  return d === 'MY_FATHER' ? candidatesMyFather(members, role) : candidatesMyMother(members, role);
}

/** 妻子侧：成员行角色为公公/婆婆（或名称含） */
function isSpouseParentLine(m: MemberBrief): boolean {
  return /公公|婆婆/.test(m.role || '') || /公公|婆婆/.test(m.name || '');
}

/**
 * 记录人已关联为丈夫/妻子时，禁止把「妻子父亲/妻子母亲」或「公公/婆婆」误挂到未提及该辈分的陈述上
 * （典型：抽取把标题写成「晓老肝炎」并 related=晓老，而用户原话是「我爸爸肝炎」）。
 */
function scrubCrossBucketRelatedMember(
  storedRelated: string,
  members: MemberBrief[],
  recorderLinkedRole: string | null,
  title: string,
  description: string,
  utteranceText: string | null | undefined
): { stored: string; clearSubjectStrip: boolean } {
  const name = norm(storedRelated);
  if (!name) return { stored: '', clearSubjectStrip: false };
  const mem = memberByExactName(members, name);
  if (!mem) return { stored: name, clearSubjectStrip: false };
  const blob = `${utteranceText || ''}${title || ''}${description || ''}`;
  const r = recorderLinkedRole || '';

  if (/丈夫|老公|先生/.test(r)) {
    if (isMaternalGrandLine(mem)) {
      const explicit =
        /外公|外婆|岳父|岳母|泰山|娘家|亲家/.test(blob) ||
        /(妻|老婆|爱人|媳妇)[^。，；;\n]{0,12}(爸|妈|父|母)/.test(blob);
      if (!explicit) {
        return { stored: '', clearSubjectStrip: true };
      }
    }
  }

  if (/妻子|老婆|太太/.test(r)) {
    if (isSpouseParentLine(mem)) {
      const explicit =
        /公公|婆婆|婆家/.test(blob) ||
        /(老公|丈夫|爱人|配偶)[^。，；;\n]{0,12}(爸|妈|父|母)/.test(blob) ||
        /(爸|妈|父|母)[^。，；;\n]{0,8}(公公|婆婆)/.test(blob);
      if (!explicit) {
        return { stored: '', clearSubjectStrip: true };
      }
    }
  }

  return { stored: name, clearSubjectStrip: false };
}

function finalizePersonKinship(
  inner: KinshipResolveResult,
  members: MemberBrief[],
  recorderLinkedRole: string | null,
  title: string,
  description: string,
  utteranceText: string | null | undefined
): KinshipResolveResult {
  const { stored, clearSubjectStrip } = scrubCrossBucketRelatedMember(
    inner.storedRelatedMember,
    members,
    recorderLinkedRole,
    title,
    description,
    utteranceText
  );
  if (stored === inner.storedRelatedMember && !clearSubjectStrip) return inner;
  return {
    ...inner,
    storedRelatedMember: stored,
    subjectNameForStrip: clearSubjectStrip ? '' : inner.subjectNameForStrip,
  };
}

/**
 * 读库展示「家庭近期记录」时再次消解：修复库里 related_member 误挂妻子父亲等；标题含「我妈」等时与写入规则一致。
 * 不依赖用户原话（库中无 utterance），故无法修正「标题也被模型改成仅晓老」的极端脏数据。
 */
export function effectiveRelatedMemberForHistoryLine(
  relatedMember: string | null | undefined,
  title: string,
  description: string | null | undefined,
  members: MemberBrief[],
  recorderLinkedRole: string | null,
  eventType?: string | null
): string {
  if (eventType === 'plant_pet') return (relatedMember || '').trim();
  const kr = resolveKinshipForRecordedEvent({
    members,
    recorderLinkedRole,
    modelRelatedMember: relatedMember || '',
    title: title || '',
    description: description || '',
    utteranceText: null,
    isPerson: true,
  });
  return kr.storedRelatedMember;
}

/**
 * 库里有误：related 曾挂妻子父亲、标题却以「晓老肝炎」形式呈现。消解后去掉姓名前缀并加短注。
 */
export function adjustHistoryTitleForScrubbedGrandRelated(
  title: string,
  originalRelatedMember: string | null | undefined,
  displayRelatedMember: string,
  members: MemberBrief[],
  recorderLinkedRole: string | null
): string {
  const orig = norm(originalRelatedMember || '');
  const disp = norm(displayRelatedMember || '');
  if (!orig || orig === disp) return title || '';
  if (!/丈夫|老公|先生/.test(recorderLinkedRole || '')) return title || '';
  const mem = memberByExactName(members, orig);
  if (!mem || !isMaternalGrandLine(mem)) return title || '';
  const n = norm(mem.name);
  const t = (title || '').trim();
  if (!n || !t.startsWith(n)) return title || '';
  let rest = t.slice(n.length).replace(/^[：:，,\s、]+/, '').trim();
  if (!rest) rest = '健康';
  return `（丈夫自述父亲辈，勿等同列表中妻子父亲）${rest}`;
}

/**
 * 非人物/宠物：不跑父母桶规则，related_member 原样（若在表中）保留。
 */
export function resolveKinshipForRecordedEvent(params: {
  members: MemberBrief[];
  recorderLinkedRole: string | null;
  modelRelatedMember: string;
  title: string;
  description: string;
  /** 当前轮用户原话，用于指代检测与标题回退（防模型改成「晓老××」并误绑 related_member） */
  utteranceText?: string | null;
  isPerson: boolean;
}): KinshipResolveResult {
  const {
    members,
    recorderLinkedRole,
    modelRelatedMember,
    title,
    description,
    utteranceText,
    isPerson,
  } = params;

  const empty = (): KinshipResolveResult => ({
    storedRelatedMember: '',
    subjectNameForStrip: '',
    modelSuggestionRejected: false,
    canonTitleFromUtterance: null,
  });

  if (!isPerson) {
    const mr = norm(modelRelatedMember);
    return {
      storedRelatedMember: mr,
      subjectNameForStrip: '',
      modelSuggestionRejected: false,
      canonTitleFromUtterance: null,
    };
  }

  const ut = norm(utteranceText || '');
  const deictic = detectDeictic(modelRelatedMember, title, description, utteranceText);
  let modelSuggestionRejected = false;
  const modelMember = memberByExactName(members, modelRelatedMember);

  let result: KinshipResolveResult;

  if (!deictic) {
    const mr = norm(modelRelatedMember);
    if (!mr) {
      result = empty();
    } else {
      const byName = memberByExactName(members, mr);
      if (byName) {
        result = {
          storedRelatedMember: byName.name.trim(),
          subjectNameForStrip: '',
          modelSuggestionRejected: false,
          canonTitleFromUtterance: null,
        };
      } else {
        result = {
          storedRelatedMember: mr,
          subjectNameForStrip: '',
          modelSuggestionRejected: false,
          canonTitleFromUtterance: null,
        };
      }
    }
    return finalizePersonKinship(result, members, recorderLinkedRole, title, description, utteranceText);
  }

  const allowed = allowedListForDeictic(deictic, members, recorderLinkedRole);

  if (modelMember) {
    const ok = allowed.some(a => norm(a.name) === norm(modelMember.name));
    if (ok) {
      result = {
        storedRelatedMember: modelMember.name.trim(),
        subjectNameForStrip: modelMember.name.trim(),
        modelSuggestionRejected: false,
        canonTitleFromUtterance: null,
      };
      return finalizePersonKinship(result, members, recorderLinkedRole, title, description, utteranceText);
    }
    modelSuggestionRejected = true;
  }

  const picked = pickOne(allowed, recorderLinkedRole, deictic);
  const subjectNameForStrip = picked ? picked.name.trim() : '';
  const storedRelatedMember = subjectNameForStrip;

  const blobTD = `${title || ''}${description || ''}`;
  const pronounInCanon = hasFirstPersonParentPronounIn(blobTD);
  const wrongNameInCanon =
    !!modelMember &&
    modelSuggestionRejected &&
    blobTD.includes((modelMember.name || '').trim());

  let canonTitleFromUtterance: string | null = null;
  if (!subjectNameForStrip && ut) {
    if (wrongNameInCanon || !pronounInCanon) {
      canonTitleFromUtterance = ut.slice(0, 240);
    }
  }

  result = {
    storedRelatedMember,
    subjectNameForStrip,
    modelSuggestionRejected: modelSuggestionRejected || allowed.length === 0,
    canonTitleFromUtterance,
  };
  return finalizePersonKinship(result, members, recorderLinkedRole, title, description, utteranceText);
}
