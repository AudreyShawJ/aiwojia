/**
 * 提醒去重 / 同一件事口播：未完成提醒（任意来源）+ 近期已完成的 AI 提醒，与抽取结果比对。
 */
import {
  formatReminderDisplayTime,
  formatReminderWallTimeShanghai,
  getShanghaiHourMinuteFromIso,
  getShanghaiWeekday17FromYmd,
  getShanghaiYmdFromEventDateField,
  getShanghaiYmdFromIso,
} from '@/lib/reminderDates';
import { supabase } from '@/lib/supabase';

/** 由 chat send() 在定稿 system 时前置；记录模板「例外」与 quickDedup guard 依赖此文 */
export const SAME_EVENT_PROMPT_MARK = '[SAME_EVENT_DETECTED]';

export type SameEventDiffType = 'exact' | 'time' | 'member' | 'location';

/** 口播 / inject 与 chat 共用 */
export type SameEventVoiceHint =
  | {
      kind: 'already_recorded';
      summary: string;
      scope: 'reminder' | 'family_event';
      diffType: 'exact';
      /** 候选 created_by 是否等于当前说话人 */
      recorderIsSelf: boolean;
      /** 非本人记录时在 family 中的展示名；本人或非本人但未知时为 null */
      recorderDisplayName: string | null;
    }
  | {
      kind: 'ask_update';
      scope: 'reminder' | 'family_event';
      diffType: 'time' | 'member' | 'location';
      previousSummary: string;
      oldPersonLabel: string;
      newPersonLabel: string;
      oldTimeLabel: string;
      newTimeLabel: string;
      /** diffType=location 时使用；从标题抽取的「去处」短语 */
      oldPlaceLabel?: string;
      newPlaceLabel?: string;
      personChanged: boolean;
      timeChanged: boolean;
      locationChanged: boolean;
      recorderIsSelf: boolean;
      recorderDisplayName: string | null;
    };

/** 有多项差异时优先问时间，再问人物，最后问地点 */
export function pickAskUpdateDiffType(flags: {
  timeChanged: boolean;
  personChanged: boolean;
  locationChanged: boolean;
}): 'time' | 'member' | 'location' {
  if (flags.timeChanged) return 'time';
  if (flags.personChanged) return 'member';
  return 'location';
}

const WEEKDAY_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 口播用：如「周六3月15日」 */
export function formatYmdBriefChinese(ymd: string): string {
  if (!ymd || ymd.length < 10 || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return ymd || '';
  const mo = parseInt(ymd.slice(5, 7), 10);
  const d = parseInt(ymd.slice(8, 10), 10);
  const w = getShanghaiWeekday17FromYmd(ymd.slice(0, 10));
  if (!Number.isFinite(w) || w < 1 || w > 7) return `${parseInt(ymd.slice(5, 7), 10)}月${parseInt(ymd.slice(8, 10), 10)}日`;
  const wk = WEEKDAY_ZH[w - 1] ?? '';
  return `${wk}${mo}月${d}日`;
}

/** 从标题里抓「去处」线索供地点差异口播（无独立 location 列时） */
export function extractPlaceCueForSameEvent(text: string): string | null {
  const t = String(text || '').trim();
  if (!t) return null;
  const patterns: RegExp[] = [
    /去([^，。；、\s]{1,12}(?:家|那儿|那里|店|馆|园|小区|写字楼))/,
    /在([^，。；、\s]{1,10}(?:家|店|馆|园))/,
    /([^，。；、\s]{2,8}家)(?:吃|吃晚|聚|坐|喝茶|吃饭)/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) return String(m[1]).trim();
  }
  const rel = t.match(/(邻居|同学|同事|朋友|亲戚)家?/);
  if (rel?.[0]) return rel[0].trim();
  return null;
}

function normPlaceCue(s: string): string {
  return s.replace(/[\s\u3000]/g, '').toLowerCase();
}

export function sameEventLocationCueChanged(oldTitle: string, newTitle: string): boolean {
  const a = extractPlaceCueForSameEvent(oldTitle);
  const b = extractPlaceCueForSameEvent(newTitle);
  if (!a && !b) return false;
  if (!a || !b) return true;
  return normPlaceCue(a) !== normPlaceCue(b);
}

export function voiceReminderTimeLabel(row: { remind_at: string; event_date: string | null }): string {
  const dayPart = formatReminderDisplayTime({
    remind_at: row.remind_at,
    event_date: row.event_date,
  });
  const clock = formatReminderWallTimeShanghai(row.remind_at);
  if (clock && !dayPart.includes(':')) return `${dayPart}（提醒时刻 ${clock}）`;
  return [dayPart, clock].filter(Boolean).join(' ');
}

/** whoRecordedLine: 第二参 recordedBy 为非本人时的展示名；与 hint.recorderIsSelf 配合 */
function subjectPrefixForAskUpdate(hint: SameEventVoiceHint & { kind: 'ask_update' }, recordedBy: string | null): string {
  if (hint.recorderIsSelf) return '你';
  if (recordedBy) return recordedBy;
  return '家人';
}

/** 仅口播正文；同件事引导由 chat 的 assistant 预填 + 本段注入配合 */
/** @param recordedBy 候选非当前用户时的记录人展示名；本人记的为 null（与 hint.recorderIsSelf 一致时传 null） */
export function buildSameEventVoiceInject(hint: SameEventVoiceHint, recordedBy: string | null): string {
  if (hint.kind === 'already_recorded') {
    const whoLine = hint.recorderIsSelf
      ? `必须用自然口语说明：**这个用户自己之前已经提过了，已经记好了**；不要说「替你又记了一条」。`
      : recordedBy
        ? `必须用自然口语说明：**这个之前${recordedBy}已经记过了**，可问一句要不要再看看或有什么要改；**禁止**说「你已经记过了」暗示本轮是用户本人记的。`
        : `必须用自然口语说明这件事**家里已经记过了**（未指明记录人）；语气温暖简短。`;
    return (
      `\n\n【同一件事·口播·必须遵守】用户本轮与已有${hint.scope === 'reminder' ? '未完成提醒' : '家庭记录'}「${hint.summary.slice(0, 120)}」疑似同一件事，且与库中在**人物、日期、去处表述**上完全一致。\n` +
      `本轮**没有任何数据库写入**（不插入、不更新、不合并）。\n` +
      `${whoLine}\n` +
      `**禁止**单独一行「✓ 已记录」；**禁止**说「新建提醒」「又设了一条」「帮你设好提醒」或暗示本条写入了数据库。\n`
    );
  }
  const scopeN = hint.scope === 'reminder' ? '提醒' : '记录';
  const subj = subjectPrefixForAskUpdate(hint, recordedBy);
  const oneLineGuide = (() => {
    switch (hint.diffType) {
      case 'time':
        return `只问**一句**自然口语，例如：${subj}上次记的是「${hint.oldTimeLabel}」，这次说的是「${hint.newTimeLabel}」，要改一下吗？**不要**展开说教。`;
      case 'member':
        return `只问**一句**自然口语，例如：上次记的是和「${hint.oldPersonLabel}」相关，这次提到「${hint.newPersonLabel}」，是换人了吗还是说错了？**不要**替用户改库。`;
      case 'location':
        return `只问**一句**自然口语，例如：之前记的是「${hint.oldPlaceLabel ?? hint.oldTimeLabel}」，这次是「${hint.newPlaceLabel ?? hint.newTimeLabel}」，是换地方了还是说错了？**不要**替用户改库。`;
      default:
        return `只问**一句**是否按新的为准；**不要**改库。`;
    }
  })();
  return (
    `\n\n【同一件事·口播·必须遵守】用户本轮与已有${scopeN}「${hint.previousSummary.slice(0, 120)}」疑似同一件事，但**${hint.diffType === 'time' ? '时间' : hint.diffType === 'member' ? '涉及人物' : '去处/地点表述'}**与库中不一致。\n` +
    `本轮**没有任何数据库写入**（不插入、不更新）。\n` +
    `${oneLineGuide}\n` +
    `**禁止**声称已新建或已更新数据库；**禁止**单独一行「✓ 已记录」。\n`
  );
}

/** 传给 buildSameEventVoiceInject 的第二参：本人为 null；家人为展示名（无则 null → inject 用泛化「已经记过了」） */
export function sameEventVoiceRecordedByForInject(hint: SameEventVoiceHint): string | null {
  if (hint.recorderIsSelf) return null;
  const n = hint.recorderDisplayName?.trim();
  return n || null;
}

/** 与 quickDedupCheck 一致：对大段文本做 dice 相似度 */
export function diceCoefficientForDedupe(a: string, b: string): number {
  return diceBigramSimilarity(a, b);
}

export type QuickDedupHit = {
  source: 'event' | 'reminder';
  id: string;
  score: number;
  title: string;
  created_by: string | null;
};

/**
 * 从用户文本中提取所有明确提到的星期几（1=周一 … 7=周日）。
 * 用于 quickDedupCheck 中排除「同课不同天」的误判。
 */
function extractWeekdaysFromText(text: string): number[] {
  const patterns: [RegExp, number][] = [
    [/周一|星期一|礼拜一/g, 1],
    [/周二|星期二|礼拜二/g, 2],
    [/周三|星期三|礼拜三/g, 3],
    [/周四|星期四|礼拜四/g, 4],
    [/周五|星期五|礼拜五/g, 5],
    [/周六|星期六|礼拜六/g, 6],
    [/周日|周天|星期日|星期天|礼拜日|礼拜天/g, 7],
  ];
  const days = new Set<number>();
  for (const [re, day] of patterns) {
    if (re.test(text)) days.add(day);
  }
  return [...days];
}

/**
 * 仅用用户原句与近端库行比对；库中无 raw_text 列时用 description。
 * reminders：未完成，或近 14 天内 completed_at 有值。
 */
export async function quickDedupCheck(userText: string, familyId: string): Promise<QuickDedupHit | null> {
  const t = String(userText || '').trim();
  if (t.length < 3 || !familyId) return null;
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const since14 = new Date(Date.now() - 14 * 86400000).toISOString();

  // 提前提取用户文本中的星期几，用于后续周期提醒去重保护
  const userWeekdays = extractWeekdaysFromText(t);

  const [evRes, remRes] = await Promise.all([
    supabase
      .from('family_events')
      .select('id, title, event_date, description, created_at, created_by')
      .eq('family_id', familyId)
      .gte('created_at', since30)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('reminders')
      .select('id, title, remind_at, event_date, description, created_by, recurring_rule, recurring_days')
      .eq('family_id', familyId)
      .or(`is_done.eq.false,completed_at.gte."${since14}"`)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  let best: QuickDedupHit | null = null;
  const consider = (
    source: 'event' | 'reminder',
    id: string,
    title: string,
    raw: string | null,
    createdBy: string | null,
    recurringRule?: string | null,
    recurringDays?: number[] | null,
  ) => {
    const titleS = String(title || '');
    const rawS = String(raw || '');
    const sTitle = diceBigramSimilarity(t, titleS);
    const sRaw = rawS.length >= 2 ? diceBigramSimilarity(t, rawS) : 0;
    const score = Math.max(sTitle, sRaw);
    if (score > 0.55 && (!best || score > best.score)) {
      // 周期提醒保护：若用户文本明确指定了星期几，而候选提醒是周重复且星期不重叠，跳过
      if (
        source === 'reminder' &&
        userWeekdays.length > 0 &&
        recurringRule === 'weekly' &&
        Array.isArray(recurringDays) &&
        recurringDays.length > 0
      ) {
        const overlap = userWeekdays.some(d => recurringDays.includes(d));
        if (!overlap) return; // 不同天的同类课程，不视为重复
      }
      best = {
        source,
        id,
        score,
        title: titleS || rawS.slice(0, 80),
        created_by: createdBy,
      };
    }
  };

  const evCandidates = (evRes.data || []).filter(r => (r.title || '').length > 4);
  const remCandidates = (remRes.data || []).filter(r => (r.title || '').length > 4);

  for (const row of evCandidates) {
    consider(
      'event',
      String(row.id),
      String(row.title || ''),
      row.description != null ? String(row.description) : null,
      row.created_by != null ? String(row.created_by) : null
    );
  }
  for (const row of remCandidates) {
    consider(
      'reminder',
      String(row.id),
      String(row.title || ''),
      row.description != null ? String(row.description) : null,
      row.created_by != null ? String(row.created_by) : null,
      row.recurring_rule != null ? String(row.recurring_rule) : null,
      Array.isArray(row.recurring_days) ? (row.recurring_days as number[]) : null,
    );
  }
  return best;
}

/** spec：聚餐/访友族；库内 daily/relationship/child/health 等映射到同族 */
const VISIT_MEAL_TYPES = ['visit', 'meal', 'gathering', 'dinner', 'lunch'] as const;
const DB_EVENT_IN_VISIT_MEAL_BUCKET = new Set<string>([
  ...VISIT_MEAL_TYPES,
  'daily',
  'relationship',
  'child',
  'health',
]);

function familyEventTypesSoftMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const ia = DB_EVENT_IN_VISIT_MEAL_BUCKET.has(a);
  const ib = DB_EVENT_IN_VISIT_MEAL_BUCKET.has(b);
  if (ia && ib) return true;
  return false;
}

/** member：双向子串即视为同一人相关，避免因简称差异跳过 */
function relatedMemberSoftForFamilyEvent(a: string | null | undefined, b: string | null | undefined): boolean {
  const s = String(a ?? '').trim();
  const t = String(b ?? '').trim();
  if (!s && !t) return true;
  if (s && t) {
    if (s === t) return true;
    if (s.includes(t) || t.includes(s)) return true;
  }
  return false;
}

function eventYmdDayOnly(isoOrDate: string | null | undefined, fallbackIso: string): string {
  if (isoOrDate && isoOrDate.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(isoOrDate)) {
    return getShanghaiYmdFromEventDateField(isoOrDate) ?? getShanghaiYmdFromIso(fallbackIso);
  }
  return getShanghaiYmdFromIso(fallbackIso);
}

export type ReminderDedupeRow = {
  id: string;
  title: string;
  related_member: string | null;
  remind_at: string;
  event_date: string | null;
  recurring_rule: string | null;
  recurring_days: number[] | null;
  event_type: string;
  /** 创建者 user id，供口播区分本人/家人；合成候选可为 null */
  created_by: string | null;
};

const DICE_THRESHOLD = 0.52;
const DICE_THRESHOLD_RELAXED = 0.4;
const MIN_TITLE_LEN_FOR_DICE = 3;

function normalizeTitle(s: string): string {
  return String(s || '')
    .replace(/[\s\u3000，。！？、；：""''（）【】《》「」·.]/g, '')
    .toLowerCase()
    .slice(0, 120);
}

function diceBigramSimilarity(a: string, b: string): number {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x.length || !y.length) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bigrams = (s: string) => {
    const arr: string[] = [];
    for (let i = 0; i < s.length - 1; i++) arr.push(s.slice(i, i + 2));
    return arr;
  };
  const A = bigrams(x);
  const B = bigrams(y);
  const map = new Map<string, number>();
  for (const g of A) map.set(g, (map.get(g) || 0) + 1);
  let inter = 0;
  for (const g of B) {
    const c = map.get(g);
    if (c) {
      inter++;
      map.set(g, c - 1);
    }
  }
  return (2 * inter) / (A.length + B.length);
}

/** 导出供家庭记录等同日去重 */
export function titlesLookSame(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true;
  if (x.length >= MIN_TITLE_LEN_FOR_DICE && y.length >= MIN_TITLE_LEN_FOR_DICE) {
    return diceBigramSimilarity(a, b) >= DICE_THRESHOLD;
  }
  return false;
}

/** 同日、聚餐/访友类：表述差异大（邻居/朋友、吃晚饭/吃饭）仍可能同一件事 */
function looseSameSocialMealOrVisit(a: string, b: string): boolean {
  if (diceBigramSimilarity(a, b) >= DICE_THRESHOLD_RELAXED) return true;
  const s = normalizeTitle(a);
  const t = normalizeTitle(b);
  if (s.length < 4 || t.length < 4) return false;
  const meal = (u: string) => /[饭餐吃聚晚]|晚饭|聚餐|请客/.test(u);
  const social = (u: string) => /[家友邻亲戚]|做客|拜访|吃饭/.test(u);
  if (!meal(s) || !meal(t)) return false;
  if (!social(s) || !social(t)) return false;
  return diceBigramSimilarity(a, b) >= 0.18;
}

/**
 * 拜访对象表述不同（同学家/邻居家/朋友家）但同为「去××家吃饭」类同一件事。
 */
function looseSameVisitMealRoughlySameHost(a: string, b: string): boolean {
  if (diceBigramSimilarity(a, b) >= 0.22) return true;
  const s = normalizeTitle(a);
  const t = normalizeTitle(b);
  if (s.length < 4 || t.length < 4) return false;
  const meal = (u: string) => /[饭餐吃聚晚]|晚饭|聚餐|请客|吃饭/.test(u);
  const visitHome = (u: string) =>
    /(同学|同事|邻居|朋友|亲戚|亲友)家/.test(u) || (/家/.test(u) && /吃|饭|餐|聚/.test(u));
  if (!meal(s) || !meal(t)) return false;
  if (!visitHome(s) || !visitHome(t)) return false;
  return diceBigramSimilarity(a, b) >= 0.14;
}

function relatedMemberCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const s = String(a ?? '').trim();
  const t = String(b ?? '').trim();
  if (!s && !t) return true;
  if (s && t) {
    if (s === t) return true;
    if (s.includes(t) || t.includes(s)) return true;
  }
  return false;
}

function recurringDaysEqual(
  a: number[] | null | undefined,
  b: number[] | null | undefined,
): boolean {
  const sa = [...(a || [])].sort((p, q) => p - q).join(',');
  const sb = [...(b || [])].sort((p, q) => p - q).join(',');
  return sa === sb;
}

function normalizeRecurringRule(r: string | null | undefined): string | null {
  if (r == null || r === '' || r === 'once') return null;
  return r;
}

function dayOfMonthFromRow(r: { event_date: string | null; remind_at: string }): number | null {
  const ed = r.event_date;
  if (ed && /^\d{4}-\d{2}-\d{2}/.test(ed)) {
    const d = parseInt(ed.slice(8, 10), 10);
    if (Number.isFinite(d) && d >= 1 && d <= 31) return d;
  }
  const ymd = getShanghaiYmdFromIso(r.remind_at);
  const d = parseInt(ymd.slice(8, 10), 10);
  return Number.isFinite(d) && d >= 1 && d <= 31 ? d : null;
}

function monthDayFromEventDate(isoOrDate: string | null): string | null {
  if (!isoOrDate || !/^\d{4}-\d{2}-\d{2}/.test(isoOrDate)) return null;
  return isoOrDate.slice(5, 10);
}

/** 未完成提醒（不限 source），用于与本轮抽取去重 */
export async function fetchIncompleteRemindersForDedupe(familyId: string): Promise<ReminderDedupeRow[]> {
  const { data, error } = await supabase
    .from('reminders')
    .select(
      'id, title, related_member, remind_at, event_date, recurring_rule, recurring_days, event_type, created_by'
    )
    .eq('family_id', familyId)
    .eq('is_done', false)
    .order('created_at', { ascending: false })
    .limit(60);

  if (error || !data?.length) {
    if (error) console.warn('[reminderDuplicate] fetch incomplete reminders:', error.message);
    return [];
  }

  return data.map(row => ({
    id: String(row.id),
    title: String(row.title || ''),
    related_member: row.related_member != null ? String(row.related_member) : null,
    remind_at: String(row.remind_at),
    event_date: row.event_date != null ? String(row.event_date) : null,
    recurring_rule: row.recurring_rule != null ? String(row.recurring_rule) : null,
    recurring_days: Array.isArray(row.recurring_days) ? (row.recurring_days as number[]) : null,
    event_type: String(row.event_type || 'daily'),
    created_by: row.created_by != null ? String(row.created_by) : null,
  }));
}

/**
 * 近期在 App 内点过「完成」的提醒（仍可能与用户重复叙述的是同一件事）。
 */
export async function fetchRecentCompletedRemindersForVoiceDedupe(
  familyId: string,
  opts?: { days?: number; limit?: number }
): Promise<ReminderDedupeRow[]> {
  const days = opts?.days ?? 14;
  const limit = opts?.limit ?? 30;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await supabase
    .from('reminders')
    .select(
      'id, title, related_member, remind_at, event_date, recurring_rule, recurring_days, event_type, created_by'
    )
    .eq('family_id', familyId)
    .eq('is_done', true)
    .gte('completed_at', since)
    .order('completed_at', { ascending: false })
    .limit(limit);

  if (error || !data?.length) {
    if (error) console.warn('[reminderDuplicate] fetch completed reminders:', error.message);
    return [];
  }

  return data.map(row => ({
    id: String(row.id),
    title: String(row.title || ''),
    related_member: row.related_member != null ? String(row.related_member) : null,
    remind_at: String(row.remind_at),
    event_date: row.event_date != null ? String(row.event_date) : null,
    recurring_rule: row.recurring_rule != null ? String(row.recurring_rule) : null,
    recurring_days: Array.isArray(row.recurring_days) ? (row.recurring_days as number[]) : null,
    event_type: String(row.event_type || 'daily'),
    created_by: row.created_by != null ? String(row.created_by) : null,
  }));
}

/** 未完成 ∪ 近期已完成，去 id 重后供口播/去重 */
export async function fetchReminderDedupeCandidatesForVoice(familyId: string): Promise<ReminderDedupeRow[]> {
  const [inc, done] = await Promise.all([
    fetchIncompleteRemindersForDedupe(familyId),
    fetchRecentCompletedRemindersForVoiceDedupe(familyId),
  ]);
  const byId = new Map<string, ReminderDedupeRow>();
  for (const r of inc) byId.set(r.id, r);
  for (const r of done) {
    if (!byId.has(r.id)) byId.set(r.id, r);
  }
  return [...byId.values()].slice(0, 90);
}

/** @deprecated 使用 fetchReminderDedupeCandidatesForVoice；保留别名以免外部引用断裂 */
export async function fetchAiReminderDedupeCandidates(familyId: string): Promise<ReminderDedupeRow[]> {
  return fetchReminderDedupeCandidatesForVoice(familyId);
}

export type NewReminderShape = {
  title: string;
  description?: string | null;
  remind_at: string;
  event_date?: string | null;
  recurring_rule: string | null;
  recurring_days?: number[] | null;
  event_type: string;
  related_member?: string | null;
  pending_expense_amount?: number;
  pending_expense_category?: string | null;
  linked_event_id?: string | null;
};

/**
 * 若命中候选则返回该条（仅高置信）；否则 null。
 */
export function findDuplicateAiReminder(
  incoming: NewReminderShape,
  candidates: ReminderDedupeRow[],
): ReminderDedupeRow | null {
  const incRule = normalizeRecurringRule(incoming.recurring_rule);
  const incDays = incoming.recurring_days || null;

  for (const c of candidates) {
    if (c.event_type !== incoming.event_type) continue;
    if (normalizeRecurringRule(c.recurring_rule) !== incRule) continue;
    if (!recurringDaysEqual(c.recurring_days, incDays)) continue;
    if (!relatedMemberCompatible(c.related_member, incoming.related_member)) continue;
    if (!titlesLookSame(c.title, incoming.title)) continue;
    if (!scheduleCompatibleForDedupe(incoming, c, incRule)) continue;
    return c;
  }
  /* 一次性提醒：同日同时刻 + 聚餐/访友类宽松同题 */
  if (incRule === null) {
    const ymd = getShanghaiYmdFromIso(incoming.remind_at);
    const hm = getShanghaiHourMinuteFromIso(incoming.remind_at);
    for (const c of candidates) {
      if (normalizeRecurringRule(c.recurring_rule) !== null) continue;
      if (c.event_type !== incoming.event_type) continue;
      if (!relatedMemberCompatible(c.related_member, incoming.related_member)) continue;
      if (getShanghaiYmdFromIso(c.remind_at) !== ymd) continue;
      const chm = getShanghaiHourMinuteFromIso(c.remind_at);
      if (chm.hour !== hm.hour || chm.minute !== hm.minute) continue;
      if (titlesLookSame(c.title, incoming.title)) continue;
      if (looseSameSocialMealOrVisit(c.title, incoming.title)) return c;
      if (looseSameVisitMealRoughlySameHost(c.title, incoming.title)) return c;
    }
  }
  return null;
}

export type FamilyEventDedupeRow = {
  id: string;
  title: string;
  event_date: string | null;
  event_type: string;
  related_member: string | null;
  created_at: string;
  created_by: string | null;
};

export async function fetchRecentFamilyEventsForDedupe(familyId: string): Promise<FamilyEventDedupeRow[]> {
  const { data, error } = await supabase
    .from('family_events')
    .select('id, title, event_date, event_type, related_member, created_at, created_by')
    .eq('family_id', familyId)
    .order('created_at', { ascending: false })
    .limit(80);

  if (error || !data?.length) {
    if (error) console.warn('[reminderDuplicate] fetch family_events:', error.message);
    return [];
  }

  return data.map(row => ({
    id: String(row.id),
    title: String(row.title || ''),
    event_date: row.event_date != null ? String(row.event_date) : null,
    event_type: String(row.event_type || 'daily'),
    related_member: row.related_member != null ? String(row.related_member) : null,
    created_at: String(row.created_at),
    created_by: row.created_by != null ? String(row.created_by) : null,
  }));
}

export function findDuplicateFamilyEventForMerge(input: {
  title: string;
  event_type: string;
  related_member: string;
  /** YYYY-MM-DD，与用户说「今天/今晚」对应的日历日 */
  eventDayYmd: string;
  candidates: FamilyEventDedupeRow[];
}): FamilyEventDedupeRow | null {
  const inputDay = input.eventDayYmd.slice(0, 10);
  for (const c of input.candidates) {
    if (!familyEventTypesSoftMatch(c.event_type, input.event_type)) continue;
    if (!relatedMemberSoftForFamilyEvent(c.related_member, input.related_member)) continue;
    const candYmd = eventYmdDayOnly(c.event_date, c.created_at);
    if (candYmd !== inputDay) continue;
    if (titlesLookSame(c.title, input.title)) return c;
    if (looseSameSocialMealOrVisit(c.title, input.title)) return c;
    if (looseSameVisitMealRoughlySameHost(c.title, input.title)) return c;
  }
  return null;
}

function scheduleCompatibleForDedupe(
  incoming: NewReminderShape,
  existing: ReminderDedupeRow,
  incRule: string | null,
): boolean {
  const newIso = incoming.remind_at;
  const oldIso = existing.remind_at;

  if (incRule == null) {
    return getShanghaiYmdFromIso(newIso) === getShanghaiYmdFromIso(oldIso);
  }

  /* 周期类：recurring_* 与标题已在主流程对齐；允许仅改钟点仍视为同一条（合并 update） */
  if (incRule === 'weekly') {
    return true;
  }

  if (incRule === 'monthly') {
    const d1 = dayOfMonthFromRow({
      event_date: incoming.event_date ?? null,
      remind_at: newIso,
    });
    const d2 = dayOfMonthFromRow({
      event_date: existing.event_date,
      remind_at: oldIso,
    });
    return d1 != null && d2 != null && d1 === d2;
  }

  if (incRule === 'daily') {
    return true;
  }

  if (incRule === 'yearly') {
    const m1 =
      monthDayFromEventDate(incoming.event_date ?? null) ??
      monthDayFromEventDate(getShanghaiYmdFromIso(newIso));
    const m2 =
      monthDayFromEventDate(existing.event_date) ?? monthDayFromEventDate(getShanghaiYmdFromIso(oldIso));
    return Boolean(m1 && m2 && m1 === m2);
  }

  return getShanghaiYmdFromIso(newIso) === getShanghaiYmdFromIso(oldIso);
}

/** 口播：人物须与库中完全一致（含均为空），「兼容」不算一致 */
export function strictSameRelatedForVoice(a: string | null | undefined, b: string | null | undefined): boolean {
  return String(a ?? '').trim() === String(b ?? '').trim();
}

/**
 * 口播 / 去重后兜底：只比较两条 remind_at 在上海日历的**同一日**与**时:分**（忽略秒）。
 * 任一无效或非同一天则视为不一致（返回 false）。
 */
export function isSameRemindAtShanghaiMinute(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  if (!sa || !sb) return false;
  if (Number.isNaN(new Date(sa).getTime()) || Number.isNaN(new Date(sb).getTime())) return false;
  if (getShanghaiYmdFromIso(sa) !== getShanghaiYmdFromIso(sb)) return false;
  const ha = getShanghaiHourMinuteFromIso(sa);
  const hb = getShanghaiHourMinuteFromIso(sb);
  return ha.hour === hb.hour && ha.minute === hb.minute;
}

/** 同一件事、人物一致但提醒时刻变化：构造「要改一下吗」口播（本轮不写库） */
export function buildReminderTimeUpdateVoiceHint(
  dup: ReminderDedupeRow,
  incoming: Pick<NewReminderShape, 'remind_at' | 'event_date' | 'related_member'>,
  vr: { recorderIsSelf: boolean; recorderDisplayName: string | null }
): SameEventVoiceHint {
  const oldPerson = (dup.related_member && String(dup.related_member).trim()) || '（未填写）';
  const newPerson = (incoming.related_member && String(incoming.related_member).trim()) || '（未填写）';
  const oldT = voiceReminderTimeLabel({ remind_at: dup.remind_at, event_date: dup.event_date });
  const newT = voiceReminderTimeLabel({
    remind_at: incoming.remind_at,
    event_date: incoming.event_date ?? null,
  });
  return {
    kind: 'ask_update',
    scope: 'reminder',
    diffType: 'time',
    previousSummary: dup.title,
    oldPersonLabel: oldPerson,
    newPersonLabel: newPerson,
    oldTimeLabel: oldT,
    newTimeLabel: newT,
    personChanged: false,
    timeChanged: true,
    locationChanged: false,
    recorderIsSelf: vr.recorderIsSelf,
    recorderDisplayName: vr.recorderDisplayName,
  };
}

/**
 * 口播：与已有提醒在事项/响铃规则上「同一档」且同一钟点（上海时区）。
 */
export function strictSameRemindMomentForVoice(
  existing: ReminderDedupeRow,
  incoming: NewReminderShape,
): boolean {
  const incRule = normalizeRecurringRule(incoming.recurring_rule);
  const oldIso = existing.remind_at;
  const newIso = incoming.remind_at;
  const hA = getShanghaiHourMinuteFromIso(oldIso);
  const hB = getShanghaiHourMinuteFromIso(newIso);
  if (hA.hour !== hB.hour || hA.minute !== hB.minute) return false;

  if (incRule === null) {
    return getShanghaiYmdFromIso(oldIso) === getShanghaiYmdFromIso(newIso);
  }
  if (incRule === 'weekly') {
    return recurringDaysEqual(existing.recurring_days, incoming.recurring_days);
  }
  if (incRule === 'monthly') {
    const d1 = dayOfMonthFromRow({
      event_date: incoming.event_date ?? null,
      remind_at: newIso,
    });
    const d2 = dayOfMonthFromRow({
      event_date: existing.event_date,
      remind_at: oldIso,
    });
    return d1 != null && d2 != null && d1 === d2;
  }
  if (incRule === 'daily') {
    return true;
  }
  if (incRule === 'yearly') {
    const m1 =
      monthDayFromEventDate(incoming.event_date ?? null) ??
      monthDayFromEventDate(getShanghaiYmdFromIso(newIso));
    const m2 =
      monthDayFromEventDate(existing.event_date) ?? monthDayFromEventDate(getShanghaiYmdFromIso(oldIso));
    return Boolean(m1 && m2 && m1 === m2);
  }
  return getShanghaiYmdFromIso(oldIso) === getShanghaiYmdFromIso(newIso);
}

/** 家庭记录去重口播：同一日历日 + 人物一致 */
export function familyEventSameDayAndPerson(
  row: FamilyEventDedupeRow,
  relatedMember: string,
  eventDayYmd: string,
): boolean {
  const candYmd =
    row.event_date && /^\d{4}-\d{2}-\d{2}/.test(row.event_date)
      ? (getShanghaiYmdFromEventDateField(row.event_date) ?? getShanghaiYmdFromIso(row.created_at))
      : getShanghaiYmdFromIso(row.created_at);
  if (candYmd !== eventDayYmd) return false;
  return strictSameRelatedForVoice(row.related_member, relatedMember);
}

/** 合并写入：保留原 id，以新数据覆盖可安全覆盖的字段 */
export function buildReminderMergePatch(
  existingId: string,
  incoming: Record<string, unknown>,
  nowIso: string,
): { id: string; patch: Record<string, unknown> } {
  const patch: Record<string, unknown> = {
    updated_at: nowIso,
    title: incoming.title,
    description: incoming.description ?? null,
    remind_at: incoming.remind_at,
    event_date: incoming.event_date ?? null,
    recurring_rule: incoming.recurring_rule ?? null,
    recurring_days: incoming.recurring_days ?? null,
    related_member: incoming.related_member ?? '',
    event_type: incoming.event_type,
  };
  const amt = incoming.pending_expense_amount;
  if (amt != null && Number(amt) > 0) {
    patch.pending_expense_amount = amt;
    patch.pending_expense_category = incoming.pending_expense_category ?? null;
    patch.linked_event_id = incoming.linked_event_id ?? null;
  }
  return { id: existingId, patch };
}

/**
 * 将刚决定插入的一条「拟写入」加入候选，供同批次后续行去重。
 */
export function upsertCandidateAfterInsert(
  candidates: ReminderDedupeRow[],
  synthetic: ReminderDedupeRow,
): void {
  const idx = candidates.findIndex(c => c.id === synthetic.id);
  if (idx >= 0) candidates[idx] = synthetic;
  else candidates.unshift(synthetic);
}

export function reminderRowToDedupeRow(id: string, row: Record<string, unknown>): ReminderDedupeRow {
  return {
    id,
    title: String(row.title || ''),
    related_member: row.related_member != null ? String(row.related_member) : null,
    remind_at: String(row.remind_at),
    event_date: row.event_date != null ? String(row.event_date) : null,
    recurring_rule: row.recurring_rule != null ? String(row.recurring_rule) : null,
    recurring_days: Array.isArray(row.recurring_days) ? (row.recurring_days as number[]) : null,
    event_type: String(row.event_type || 'daily'),
    created_by: row.created_by != null ? String(row.created_by) : null,
  };
}
