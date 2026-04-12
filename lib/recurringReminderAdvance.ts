import {
  addCalendarDaysShanghaiYmd,
  addCalendarMonthsShanghaiYmd,
  dateFromShanghaiWallClock,
  getNextMultiWeekdayOccurrenceAfter,
  getShanghaiHourMinuteFromIso,
  getShanghaiYmd,
  getShanghaiYmdFromEventDateField,
  getShanghaiYmdFromIso,
} from '@/lib/reminderDates';

export type RecurringRule = 'daily' | 'weekly' | 'monthly' | 'yearly' | string | null;

/**
 * 周期提醒点「完成」后：滚到下一周期同一钟点（上海），并返回新 event_date（若有）。
 */
export function computeNextOccurrenceAfterComplete(input: {
  recurring_rule: RecurringRule;
  recurring_days: number[] | null | undefined;
  remind_at: string;
  event_date: string | null | undefined;
}): { remind_at: string; event_date: string | null } | null {
  const rule = input.recurring_rule;
  if (!rule || rule === 'once') return null;

  const { hour, minute } = getShanghaiHourMinuteFromIso(input.remind_at);
  const afterMs = new Date(input.remind_at).getTime() + 60_000;

  if (rule === 'daily') {
    const ymd = getShanghaiYmdFromIso(input.remind_at);
    const nextYmd = addCalendarDaysShanghaiYmd(ymd, 1);
    const d = dateFromShanghaiWallClock(nextYmd, hour, minute);
    return { remind_at: d.toISOString(), event_date: nextYmd };
  }

  if (rule === 'weekly' && input.recurring_days?.length) {
    const next = getNextMultiWeekdayOccurrenceAfter(input.recurring_days, hour, minute, afterMs);
    if (!next) return null;
    const nextYmd = getShanghaiYmdFromIso(next.toISOString());
    return { remind_at: next.toISOString(), event_date: nextYmd };
  }

  if (rule === 'monthly') {
    const todayYmd = getShanghaiYmd();
    const baseYmd =
      input.event_date && input.event_date.length >= 10
        ? (getShanghaiYmdFromEventDateField(input.event_date) ?? getShanghaiYmdFromIso(input.remind_at))
        : getShanghaiYmdFromIso(input.remind_at);
    let nextYmd = addCalendarMonthsShanghaiYmd(baseYmd, 1);
    /** 只滚一期可能仍早于今天（例如事项日每月3号、今天已24号），会导致点完「完成」仍显示已过期·未完成 */
    let guard = 0;
    while (nextYmd < todayYmd && guard++ < 120) {
      nextYmd = addCalendarMonthsShanghaiYmd(nextYmd, 1);
    }
    const d = dateFromShanghaiWallClock(nextYmd, hour, minute);
    return { remind_at: d.toISOString(), event_date: nextYmd };
  }

  if (rule === 'yearly') {
    const todayYmd = getShanghaiYmd();
    const baseYmd =
      input.event_date && input.event_date.length >= 10
        ? (getShanghaiYmdFromEventDateField(input.event_date) ?? getShanghaiYmdFromIso(input.remind_at))
        : getShanghaiYmdFromIso(input.remind_at);
    let nextYmd = addCalendarMonthsShanghaiYmd(baseYmd, 12);
    let guard = 0;
    while (nextYmd < todayYmd && guard++ < 50) {
      nextYmd = addCalendarMonthsShanghaiYmd(nextYmd, 12);
    }
    const d = dateFromShanghaiWallClock(nextYmd, hour, minute);
    return { remind_at: d.toISOString(), event_date: nextYmd };
  }

  return null;
}
