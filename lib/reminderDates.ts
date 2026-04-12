/** 与记录页「提醒」卡片一致：事项日优先 event_date；日期/时刻统一按北京时间（Asia/Shanghai）理解 */

export type ReminderSchedulePriority = 'overdue' | 'today' | 'upcoming' | 'future';

export type ReminderScheduleFields = {
  remind_at: string;
  event_date?: string | null;
};

const TZ = 'Asia/Shanghai';

/** 某日在北京时间的日历 YYYY-MM-DD */
export function getShanghaiYmd(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** ISO 时刻在北京时间对应的日历日 YYYY-MM-DD */
export function getShanghaiYmdFromIso(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return getShanghaiYmd();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/**
 * 从 events/reminders 的 event_date 抽取串得到上海日历日 YYYY-MM-DD。
 * 对带 Z / 偏移的完整 ISO 不能用前缀 slice(0,10)：那是 UTC 日历日，会与上海「事项日」差一天
 *（例：上海 3/31 07:00+08 存库常为 2026-03-30T23:00:00.000Z）。
 */
export function getShanghaiYmdFromEventDateField(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const head = s.slice(0, 10);
  const anchor = head.length === 10 && s.length === 10 ? `${head}T12:00:00+08:00` : s;
  const t = new Date(anchor).getTime();
  if (Number.isNaN(t)) return head;
  return getShanghaiYmdFromIso(anchor);
}

/**
 * 抽取结果 event_date 仅为 YYYY-MM-DD 时落成库用 timestamptz ISO（与聊天落库「今天=当前时刻、非今天=该日 07:00 上海」一致）。
 * 已含时刻/偏移的字符串原样返回；null/空 → null。
 */
export function normalizeExtractEventDateForDb(
  raw: string | null | undefined,
  referenceNow: Date = new Date()
): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const todayYmd = getShanghaiYmd(referenceNow);
    if (s === todayYmd) return referenceNow.toISOString();
    return dateFromShanghaiWallClock(s, 7, 0).toISOString();
  }
  return s;
}

const SHANGHAI_WEEKDAY_EN_TO_17: Record<string, number> = {
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
  Sunday: 7,
};

/** 上海日历日 ymd 是周几：1=周一…7=周日 */
export function getShanghaiWeekday17FromYmd(ymd: string): number {
  const d = new Date(`${ymd}T12:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return 1;
  const long = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' }).format(d);
  return SHANGHAI_WEEKDAY_EN_TO_17[long] ?? 1;
}

/** 上海日历 ymd 加减自然日 */
export function addCalendarDaysShanghaiYmd(ymd: string, deltaDays: number): string {
  const base = new Date(`${ymd}T12:00:00+08:00`);
  if (Number.isNaN(base.getTime())) return ymd;
  const t = base.getTime() + deltaDays * 86400000;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(t));
}

/** 上海日历日 ymd 加减整月（用于月供/月周期提醒滚到下一期） */
export function addCalendarMonthsShanghaiYmd(ymd: string, deltaMonths: number): string {
  const parts = ymd.slice(0, 10).split('-').map(Number);
  const y = parts[0];
  const m = parts[1];
  const day = parts[2];
  if (!y || !m || !day) return ymd;
  const total = y * 12 + (m - 1) + deltaMonths;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(ny, nm, 0).getDate();
  const nd = Math.min(day, lastDay);
  return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

/** 上海墙上时间 → 绝对时刻 Date（存 remind_at） */
export function dateFromShanghaiWallClock(ymd: string, hour: number, minute = 0): Date {
  const h = Math.max(0, Math.min(23, Math.floor(hour)));
  const mi = Math.max(0, Math.min(59, Math.floor(minute)));
  return new Date(
    `${ymd}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+08:00`
  );
}

/** 从 remind_at ISO 取上海时、分 */
export function getShanghaiHourMinuteFromIso(iso: string): { hour: number; minute: number } {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { hour: 9, minute: 0 };
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '9', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  return {
    hour: Number.isFinite(hour) ? hour : 9,
    minute: Number.isFinite(minute) ? minute : 0,
  };
}

/**
 * 从当前上海日历日起，严格晚于 afterMs 的第 weekSlotIndex 次（0=最近）该 weekday（1–7） occurrence。
 */
export function getUpcomingShanghaiWeekdayOccurrence(
  modelWeekday17: number,
  hour: number,
  minute: number,
  weekSlotIndex: number,
  afterMs: number = Date.now()
): Date | null {
  const todayYmd = getShanghaiYmd();
  const slots: Date[] = [];
  for (let i = 0; i < 400; i++) {
    const ymd = addCalendarDaysShanghaiYmd(todayYmd, i);
    if (getShanghaiWeekday17FromYmd(ymd) !== modelWeekday17) continue;
    const cand = dateFromShanghaiWallClock(ymd, hour, minute);
    if (cand.getTime() > afterMs) {
      slots.push(cand);
      if (slots.length > weekSlotIndex) return slots[weekSlotIndex]!;
    }
  }
  return null;
}

/**
 * 每周多个工作日（recurring_days 含多个 1–7）时，取严格晚于 afterMs 的最近一条提醒时刻（上海日历日 + 同一钟点）。
 * 例如 Mon–Fri：周一完成后下一期为周二同一时间，而非仅按 recurring_days[0] 跳到下周一。
 */
export function getNextMultiWeekdayOccurrenceAfter(
  weekdays: number[],
  hour: number,
  minute: number,
  afterMs: number
): Date | null {
  const unique = [
    ...new Set(
      weekdays
        .map(w => Math.floor(Number(w)))
        .filter(w => Number.isFinite(w) && w >= 1 && w <= 7)
    ),
  ];
  if (unique.length === 0) return null;
  unique.sort((a, b) => a - b);

  const startYmd = getShanghaiYmdFromIso(new Date(afterMs).toISOString());

  for (let delta = 0; delta < 400; delta++) {
    const ymd = addCalendarDaysShanghaiYmd(startYmd, delta);
    const wd = getShanghaiWeekday17FromYmd(ymd);
    if (!unique.includes(wd)) continue;
    const cand = dateFromShanghaiWallClock(ymd, hour, minute);
    if (cand.getTime() > afterMs) return cand;
  }
  return null;
}

/** targetYmd - todayYmd，单位：天（可为负） */
function calendarDaysFromTo(todayYmd: string, targetYmd: string): number {
  const [y1, m1, d1] = todayYmd.split('-').map(Number);
  const [y2, m2, d2] = targetYmd.split('-').map(Number);
  const t0 = Date.UTC(y1, m1 - 1, d1);
  const t1 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t1 - t0) / (1000 * 60 * 60 * 24));
}

/** remind_at 在北京时间的时刻，24 小时制 HH:mm */
export function formatReminderWallTimeShanghai(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** 供 AI / 查询上下文：未完成提醒的状态说明（勿与「已做完」混淆） */
export function getReminderIncompleteStatusLabel(status: ReminderSchedulePriority): string {
  switch (status) {
    case 'overdue':
      return '已过期·未完成';
    case 'today':
      return '今天·未完成';
    case 'upcoming':
      return '近7天内·未完成';
    default:
      return '更远日期·未完成';
  }
}

export function getReminderStatus(
  remindAt: string,
  eventDate?: string | null
): ReminderSchedulePriority {
  const todayYmd = getShanghaiYmd();
  let targetYmd: string;
  if (eventDate && eventDate.length >= 10) {
    targetYmd = getShanghaiYmdFromEventDateField(eventDate) ?? getShanghaiYmdFromIso(remindAt);
  } else {
    targetYmd = getShanghaiYmdFromIso(remindAt);
  }
  const diffDays = calendarDaysFromTo(todayYmd, targetYmd);
  if (diffDays < 0) return 'overdue';
  if (diffDays === 0) return 'today';
  if (diffDays <= 7) return 'upcoming';
  return 'future';
}

/** 排序：与记录页一致，event_date（YYYY-MM-DD）优先 */
export function getReminderSortKey(r: ReminderScheduleFields): string {
  return r.event_date && r.event_date.length >= 10 ? r.event_date : r.remind_at;
}

function shanghaiMonthDayFromIso(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    month: 'numeric',
    day: 'numeric',
  })
    .formatToParts(new Date(iso))
    .reduce<Record<string, string>>((acc, x) => {
      if (x.type !== 'literal') acc[x.type] = x.value;
      return acc;
    }, {});
  return `${parseInt(p.month || '1', 10)}月${parseInt(p.day || '1', 10)}日`;
}

/** Chat 写库成功后追加确认行：上海历 M月D日 HH:mm（与 dayjs tz Asia/Shanghai + format 一致） */
export function formatReminderConfirmShanghaiDateTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const datePart = shanghaiMonthDayFromIso(iso);
  const hm = formatReminderWallTimeShanghai(iso);
  return hm ? `${datePart} ${hm}` : datePart;
}

/** 只返回相对日期文字（不带时刻）：今天/明天/后天/M月D日；ymd 格式为 YYYY-MM-DD */
function formatRelativeDayShanghai(ymd: string): string {
  if (!ymd || ymd.length < 10) return '';
  const todayYmd = getShanghaiYmd();
  const d = calendarDaysFromTo(todayYmd, ymd);
  if (d === 0) return '今天';
  if (d === 1) return '明天';
  if (d === 2) return '后天';
  const parts = ymd.split('-');
  if (parts.length >= 3) return `${parseInt(parts[1], 10)}月${parseInt(parts[2], 10)}日`;
  return '';
}

/**
 * 列表/卡片：按上海日历比较 iso 所在日与当地「今天」，展示「今天 HH:mm」「明天 HH:mm」「后天 HH:mm」，否则「M月D日 HH:mm」（与 dayjs isSame(..., 'day') + format 语义一致，无 dayjs 依赖）
 */
export function formatRemindAtRelativeDayAndClockShanghai(iso: string | null | undefined): string {
  if (!iso) return '';
  const clock = formatReminderWallTimeShanghai(iso);
  if (!clock) return '';
  const todayYmd = getShanghaiYmd();
  const ymd = getShanghaiYmdFromIso(iso);
  const d = calendarDaysFromTo(todayYmd, ymd);
  if (d === 0) return `今天 ${clock}`;
  if (d === 1) return `明天 ${clock}`;
  if (d === 2) return `后天 ${clock}`;
  const parts = ymd.split('-');
  if (parts.length >= 3) {
    return `${parseInt(parts[1], 10)}月${parseInt(parts[2], 10)}日 ${clock}`;
  }
  return clock;
}

/** 展示文案：与记录页 formatDisplayTime 一致（事项日以 event_date 为准；带 timestamptz 时显示到点钟点） */
export function formatReminderDisplayTime(item: ReminderScheduleFields): string {
  const status = getReminderStatus(item.remind_at, item.event_date);
  const remindClock = formatReminderWallTimeShanghai(item.remind_at);

  if (item.event_date && item.event_date.length >= 10) {
    const ymd = getShanghaiYmdFromEventDateField(item.event_date) ?? item.event_date.slice(0, 10);
    const parts = ymd.split('-');
    const dateStr = `${parseInt(parts[1], 10)}月${parseInt(parts[2], 10)}日`;
    const hasEventInstant =
      item.event_date.length > 10 || item.event_date.includes('T');
    const eventClock = hasEventInstant ? formatReminderWallTimeShanghai(item.event_date) : '';
    if (status === 'overdue') return `${dateStr} 已过期`;
    if (hasEventInstant && eventClock) {
      return formatRemindAtRelativeDayAndClockShanghai(item.event_date) || `${dateStr} ${eventClock}`;
    }
    // event_date 只有日期（无时刻）：展示相对日期，不用 remind_at 时刻
    const relDate = formatRelativeDayShanghai(ymd);
    return relDate || dateStr;
  }

  const dateStr = shanghaiMonthDayFromIso(item.remind_at);
  if (status === 'overdue') return `${dateStr} 已过期`;
  if (remindClock) {
    const rel = formatRemindAtRelativeDayAndClockShanghai(item.remind_at);
    if (rel) return rel;
  }
  return dateStr;
}

/**
 * 从中文里解析「每月几号」：每月15号、15号、还款日15号 等；避免把 36666 等误当作日期。
 */
export function parseDayOfMonthFromChineseText(blob: string): number | null {
  if (!blob?.trim()) return null;
  const t = blob.replace(/\s/g, '');
  const ordered = [
    /每月(\d{1,2})[日号]/,
    /每个月(\d{1,2})[日号]/,
    /还款(?:日)?(\d{1,2})[日号]/,
    /(\d{1,2})号还/,
    /(?:^|[^\d])([1-9]|[12]\d|3[01])号(?:[^\d]|$)/,
    /(?:^|[^\d])([1-9]|[12]\d|3[01])日(?:[^\d]|$)/,
  ];
  for (const re of ordered) {
    const m = t.match(re);
    if (!m) continue;
    const raw = m[1];
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 31) return n;
  }
  return null;
}

/**
 * 下一期「每月 dom 号」在上海日历上的事项日 YYYY-MM-DD（严格晚于 nowMs 的第一次响铃对应日期）。
 */
export function getNextMonthlyOccurrenceYmd(
  dayOfMonth: number,
  hour: number,
  minute: number,
  nowMs: number = Date.now()
): string {
  const d = Math.min(31, Math.max(1, Math.floor(dayOfMonth)));
  const todayYmd = getShanghaiYmd(new Date(nowMs));
  const y0 = parseInt(todayYmd.slice(0, 4), 10);
  const m0 = parseInt(todayYmd.slice(5, 7), 10);
  const lastDayThis = new Date(y0, m0, 0).getDate();
  const domThis = Math.min(d, lastDayThis);
  const thisMonthYmd = `${y0}-${String(m0).padStart(2, '0')}-${String(domThis).padStart(2, '0')}`;
  const candThis = dateFromShanghaiWallClock(thisMonthYmd, hour, minute);
  if (candThis.getTime() > nowMs) return thisMonthYmd;

  const firstThisMonth = `${y0}-${String(m0).padStart(2, '0')}-01`;
  const nextMonthFirst = addCalendarMonthsShanghaiYmd(firstThisMonth, 1);
  const y1 = parseInt(nextMonthFirst.slice(0, 4), 10);
  const m1 = parseInt(nextMonthFirst.slice(5, 7), 10);
  const lastDayNext = new Date(y1, m1, 0).getDate();
  const domNext = Math.min(d, lastDayNext);
  return `${y1}-${String(m1).padStart(2, '0')}-${String(domNext).padStart(2, '0')}`;
}

/**
 * 下一期「每年 anchor 月日」在上海日历上的事项日（严格晚于 nowMs 的第一次响铃对应日期）。
 * anchorYmd 任一年均可，只取其月、日（如去年 3/15 续费仍可作为今年、明年的 3/15 锚点）。
 */
export function getNextYearlyOccurrenceYmd(
  anchorYmd: string,
  hour: number,
  minute: number,
  nowMs: number = Date.now()
): string {
  const s = anchorYmd.slice(0, 10);
  const mo = parseInt(s.slice(5, 7), 10);
  const dom = parseInt(s.slice(8, 10), 10);
  if (!Number.isFinite(mo) || mo < 1 || mo > 12 || !Number.isFinite(dom) || dom < 1) {
    return addCalendarDaysShanghaiYmd(getShanghaiYmd(new Date(nowMs)), 7);
  }
  const todayYmd = getShanghaiYmd(new Date(nowMs));
  const yStart = parseInt(todayYmd.slice(0, 4), 10);
  for (let delta = 0; delta < 8; delta++) {
    const y = yStart + delta;
    const lastDay = new Date(y, mo, 0).getDate();
    const d = Math.min(dom, lastDay);
    const cand = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const at = dateFromShanghaiWallClock(cand, hour, minute);
    if (at.getTime() > nowMs) return cand;
  }
  const y = yStart + 8;
  const lastDay = new Date(y, mo, 0).getDate();
  const d = Math.min(dom, lastDay);
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 与 chat「抽取写入」口径一致：1=周一…7=周日；兼容 0–6（周日=0） */
const WEEKDAY_LABEL_WEEK17 = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WEEKDAY_LABEL_JS0SUN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function formatWeeklyRecurringDaysChinese(days: number[]): string {
  const parts = days.map(d => {
    if (d >= 1 && d <= 7) return WEEKDAY_LABEL_WEEK17[d] ?? '';
    const js = ((d % 7) + 7) % 7;
    return WEEKDAY_LABEL_JS0SUN[js] ?? '';
  }).filter(Boolean);
  return parts.length ? parts.join('、') : '';
}

/**
 * 提醒列表/卡片：把 recurring_rule 落成「每月」「每年」「每周一、三」等可读文案（勿用笼统「周期性」）。
 * once / null 返回空字符串。
 */
export function formatRecurringRuleLabelChinese(
  rule: string | null | undefined,
  recurringDays?: number[] | null,
  eventDate?: string | null
): string {
  if (!rule || rule === 'once') return '';
  if (rule === 'daily') return '每天';
  if (rule === 'monthly') {
    if (eventDate && eventDate.length >= 10) {
      const dom = parseInt(eventDate.slice(8, 10), 10);
      if (Number.isFinite(dom) && dom >= 1 && dom <= 31) return `每月${dom}日`;
    }
    return '每月';
  }
  if (rule === 'weekly') {
    const inner = recurringDays?.length ? formatWeeklyRecurringDaysChinese(recurringDays) : '';
    return inner ? `每周${inner}` : '每周';
  }
  if (rule === 'yearly') {
    if (eventDate && eventDate.length >= 10) {
      const mo = parseInt(eventDate.slice(5, 7), 10);
      const dom = parseInt(eventDate.slice(8, 10), 10);
      if (
        Number.isFinite(mo) &&
        Number.isFinite(dom) &&
        mo >= 1 &&
        mo <= 12 &&
        dom >= 1 &&
        dom <= 31
      ) {
        return `每年${mo}月${dom}日`;
      }
    }
    return '每年';
  }
  return '周期提醒';
}

/**
 * 提醒 Tab 列表：**事项日/到点**以 event_date 为准（与库注释一致：timestamptz）。
 * - 存了完整时刻则展示「M月D日 HH:mm」
 * - 仅有 YYYY-MM-DD 则只展示月日
 * 无 event_date 时退回用 remind_at
 */
export function formatReminderListMeta(
  remindAt: string,
  eventDate?: string | null,
  _recurringRule?: string | null
): string {
  void _recurringRule;

  if (eventDate && eventDate.length >= 10) {
    const parts = (getShanghaiYmdFromEventDateField(eventDate) ?? eventDate.slice(0, 10)).split('-');
    if (parts.length >= 3) {
      const dateStr = `${parseInt(parts[1], 10)}月${parseInt(parts[2], 10)}日`;
      const hasInstant = eventDate.length > 10 || eventDate.includes('T');
      if (hasInstant) {
        const rel = formatRemindAtRelativeDayAndClockShanghai(eventDate);
        if (rel) return rel;
      }
      const remindRel = formatRemindAtRelativeDayAndClockShanghai(remindAt);
      if (remindRel) return remindRel;
      return dateStr;
    }
  }

  if (!remindAt) return '';
  const clock = formatReminderWallTimeShanghai(remindAt);
  if (clock) {
    const rel = formatRemindAtRelativeDayAndClockShanghai(remindAt);
    if (rel) return rel;
  }
  return shanghaiMonthDayFromIso(remindAt);
}

export function formatDaysLeft(remindAt: string, eventDate?: string | null): string | null {
  const todayYmd = getShanghaiYmd();
  let targetYmd: string;
  if (eventDate && eventDate.length >= 10) {
    targetYmd = getShanghaiYmdFromEventDateField(eventDate) ?? getShanghaiYmdFromIso(remindAt);
  } else {
    targetYmd = getShanghaiYmdFromIso(remindAt);
  }
  const diffDays = calendarDaysFromTo(todayYmd, targetYmd);
  if (diffDays < 0) return `已过期${Math.abs(diffDays)}天`;
  if (diffDays === 0) return null;
  if (diffDays === 1) return '还有1天';
  return `还有${diffDays}天`;
}
