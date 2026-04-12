import {
  adjustHistoryTitleForScrubbedGrandRelated,
  effectiveRelatedMemberForHistoryLine,
} from '@/lib/kinshipResolver';
import type { KinshipMemberRow } from '@/lib/kinshipPrompt';

/** 账户 id → 展示用「记录人」标签（关联成员优先，否则账户名+未关联提示） */
export function buildRecorderLabelByUserId(
  members: KinshipMemberRow[],
  familyUsers: { id: string; name: string | null }[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const u of familyUsers) {
    const id = u.id;
    const linked = members.find(m => m.linked_user_id === id);
    if (linked) {
      out[id] = `${linked.name}（${linked.role}）`;
    } else {
      const nm = (u.name || '').trim() || '家人';
      out[id] = `${nm}（账户·未关联成员）`;
    }
  }
  return out;
}

/** 与 formatFamilyEventHistoryLine 使用同一套消解，供交叉视角注等读取「展示用标题/当事人」 */
export function getFamilyEventHistoryPerspectiveFields(
  e: {
    title: string;
    description?: string | null;
    related_member?: string | null;
    created_by?: string | null;
    event_type?: string;
  },
  members?: KinshipMemberRow[]
): { displayTitle: string; displayRelated: string } {
  const uid = e.created_by;
  if (!members?.length || !uid) {
    return {
      displayTitle: e.title || '',
      displayRelated: (e.related_member || '').trim(),
    };
  }
  const recRole = members.find(m => m.linked_user_id === uid)?.role ?? null;
  const displayRelated = effectiveRelatedMemberForHistoryLine(
    e.related_member,
    e.title || '',
    e.description ?? null,
    members,
    recRole,
    e.event_type
  );
  const displayTitle = adjustHistoryTitleForScrubbedGrandRelated(
    e.title || '',
    e.related_member,
    displayRelated,
    members,
    recRole
  );
  return { displayTitle, displayRelated };
}

export function formatFamilyEventHistoryLine(
  e: {
    event_type: string;
    title: string;
    event_date?: string | null;
    related_member?: string | null;
    created_by?: string | null;
    description?: string | null;
  },
  recorderByUserId: Record<string, string>,
  /** 传入时按亲属规则净化 related_member（避免库里误挂妻子父亲仍显示在「晓老：」前缀） */
  members?: KinshipMemberRow[]
): string {
  const uid = e.created_by;
  const rec =
    uid && recorderByUserId[uid]
      ? recorderByUserId[uid]
      : uid
        ? '其他家庭成员账户'
        : '未知';
  const { displayTitle, displayRelated } = getFamilyEventHistoryPerspectiveFields(e, members);
  const rm = displayRelated ? `${displayRelated}：` : '';
  const datePart = e.event_date ? `（${e.event_date}）` : '';
  return `[${e.event_type}] 记录人：${rec}｜${rm}${displayTitle}${datePart}`;
}
