/**
 * 一次性提醒：事项时刻 event 与通知时刻 remind 的关系（产品规则）
 * - 默认提前 15 分钟；可通过用户原话或抽取字段覆盖
 * - 仅日期无钟点时事项默认为当日 7:00（上海）
 */

import {
  addCalendarDaysShanghaiYmd,
  dateFromShanghaiWallClock,
  getShanghaiHourMinuteFromIso,
  getShanghaiYmdFromEventDateField,
  getShanghaiYmdFromIso,
} from './reminderDates';

export const DEFAULT_EVENT_HOUR_WHEN_DATE_ONLY = 7;
export const DEFAULT_REMIND_LEAD_MINUTES = 15;

/**
 * 「5分钟后」「再过10分钟」「半小时后」等：相对**当前时刻**的偏移分钟数。
 * 用于「到点即事项的短时提醒」，事项时刻与提醒时刻均为 now+N（不再套用默认提前 15 分钟）。
 */
export function parseMinutesOffsetFromNowFromChinese(text: string): number | null {
  if (!text?.trim()) return null;
  const t = text.replace(/\s/g, '');
  if (/半小时后|半个钟头后|过半小时/.test(t)) return 30;
  if (/一小时后|一个钟头后|过一小时/.test(t)) return 60;
  const after = t.match(/(\d{1,4})\s*分钟(?:钟)?(?:之)?后/);
  if (after) {
    const n = parseInt(after[1], 10);
    if (Number.isFinite(n) && n > 0 && n <= 24 * 60) return n;
  }
  const guo = t.match(/再过(\d{1,4})\s*分钟(?:钟)?/);
  if (guo) {
    const n = parseInt(guo[1], 10);
    if (Number.isFinite(n) && n > 0 && n <= 24 * 60) return n;
  }
  /** 如「10分后」，避免误匹配「提前10分」类 */
  if (!/提前|最晚|不晚于/.test(t)) {
    const fen = t.match(/(\d{1,4})\s*分(?:钟)?后/);
    if (fen) {
      const n = parseInt(fen[1], 10);
      if (Number.isFinite(n) && n > 0 && n <= 24 * 60) return n;
    }
  }
  return null;
}

/** 从用户话里解析「提前 X 分钟/小时」；未提及返回 null */
export function parseRemindLeadMinutesFromChinese(text: string): number | null {
  if (!text?.trim()) return null;
  const t = text.replace(/\s/g, '');
  if (/提前半(?:个)?小时|前半小时|半个钟头/.test(t)) return 30;
  const h = t.match(/(?:提前|前)(\d+)\s*(?:小时|钟头)/);
  if (h) {
    const n = parseInt(h[1], 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n * 60, 24 * 60);
  }
  const m = t.match(/(?:提前|前)(\d+)\s*(?:分钟|分)(?:钟)?/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 24 * 60);
  }
  return null;
}

/**
 * remind_at：通知栏实际触发时刻
 * - 若 event - created <= lead 分钟，则 remind = created（尽快、且不早于创建时刻）
 * - 否则 remind = event - lead
 */
export function computeRemindAtFromEventInstant(
  eventAt: Date,
  createdAt: Date,
  leadMinutes: number
): Date {
  const leadMs = Math.max(0, leadMinutes) * 60 * 1000;
  const delta = eventAt.getTime() - createdAt.getTime();
  if (delta <= leadMs) {
    return createdAt;
  }
  return new Date(eventAt.getTime() - leadMs);
}

export type ResolveOnceReminderInput = {
  recurringType: string;
  reminder: { event_date?: string | null; remind_before_minutes?: number | null };
  relatedEvent: { event_date?: string | null };
  beforeDays: number;
  userText: string;
  recentBlob: string;
  parsedClock: { hour: number; minute: number } | null;
  /** 链式逻辑算完后的事件日锚（YYYY-MM-DD 或更长） */
  storedEventDateAfterChain: string | null;
  /** 链式逻辑得到的「到点」时刻（尚未减提前量） */
  remindAtFromChain: Date;
  createdAt: Date;
};

/**
 * 一次性提醒：由事项时刻 event_date、提前分钟数、创建时刻算出 remind_at，并返回完整 event timestamptz ISO。
 */
export function resolveOnceEventAndRemindAt(
  opts: ResolveOnceReminderInput
): { eventAt: Date; remindAt: Date; eventDateIso: string } | null {
  if (opts.recurringType !== 'once') return null;

  let lead: number | null =
    typeof opts.reminder.remind_before_minutes === 'number' &&
    !Number.isNaN(opts.reminder.remind_before_minutes) &&
    opts.reminder.remind_before_minutes > 0
      ? Math.floor(opts.reminder.remind_before_minutes)
      : null;
  if (lead == null) lead = parseRemindLeadMinutesFromChinese(opts.userText);
  if (lead == null) lead = parseRemindLeadMinutesFromChinese(opts.recentBlob);
  if (lead == null) lead = DEFAULT_REMIND_LEAD_MINUTES;

  let ymd: string | null = null;
  for (const cand of [
    opts.storedEventDateAfterChain,
    opts.reminder.event_date,
    opts.relatedEvent.event_date,
  ]) {
    const y = getShanghaiYmdFromEventDateField(cand != null ? String(cand) : null);
    if (y) {
      ymd = y;
      break;
    }
  }

  let hour: number;
  let minute: number;

  if (opts.parsedClock) {
    hour = opts.parsedClock.hour;
    minute = opts.parsedClock.minute;
  } else {
    hour = DEFAULT_EVENT_HOUR_WHEN_DATE_ONLY;
    minute = 0;
  }

  if (!ymd) {
    const iso = opts.remindAtFromChain.toISOString();
    ymd = getShanghaiYmdFromIso(iso);
    if (!opts.parsedClock) {
      const hm = getShanghaiHourMinuteFromIso(iso);
      hour = hm.hour;
      minute = hm.minute;
    }
  }

  const eventAt = dateFromShanghaiWallClock(ymd, hour, minute);

  let remindAt: Date;
  if (opts.beforeDays > 0) {
    const notifyYmd = addCalendarDaysShanghaiYmd(ymd, -opts.beforeDays);
    remindAt = dateFromShanghaiWallClock(notifyYmd, hour, minute);
    if (remindAt.getTime() < opts.createdAt.getTime()) {
      remindAt = opts.createdAt;
    }
  } else {
    remindAt = computeRemindAtFromEventInstant(eventAt, opts.createdAt, lead);
  }

  return { eventAt, remindAt, eventDateIso: eventAt.toISOString() };
}
