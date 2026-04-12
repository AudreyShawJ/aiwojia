import * as Notifications from 'expo-notifications';
import { DEFAULT_REMIND_LEAD_MINUTES } from './reminderNotifySchedule';
import {
  dateFromShanghaiWallClock,
  formatReminderWallTimeShanghai,
  getShanghaiHourMinuteFromIso,
  getShanghaiYmd,
  getShanghaiYmdFromEventDateField,
  getShanghaiYmdFromIso,
  getUpcomingShanghaiWeekdayOccurrence,
} from './reminderDates';
import { supabase } from './supabase';

/** 周期提醒：按事项 occurrence 再向推前 DEFAULT_REMIND_LEAD_MINUTES（与入库「到点」语义一致） */
const NOTIFY_LEAD_MS = DEFAULT_REMIND_LEAD_MINUTES * 60 * 1000;

/** 目标时刻前 15 分钟；不足 15 分钟则在目标时刻 */
function triggerBeforeEvent(targetAt: Date, now: Date): Date | null {
  if (targetAt.getTime() <= now.getTime()) return null;
  const early = new Date(targetAt.getTime() - NOTIFY_LEAD_MS);
  return early.getTime() > now.getTime() ? early : targetAt;
}

/**
 * 推送触发时刻（上海日历日）：
 * - 事项日不是「今天」：事发前 15 分钟（默认）
 * - 事项日是「今天」且创建日也是「今天」：今天新增的今日待办 → 事发前 15 分钟
 * - 事项日是「今天」且创建日早于「今天」：原定今日待办 → 今天 7:00；若事项钟点早于 7:00 则事发前 15 分钟；若 7 点已过则退回事发前 15 分钟
 */
function computeTriggerAt(
  targetAt: Date,
  now: Date,
  createdAtIso: string,
  eventDate: string | null | undefined
): Date | null {
  const todayYmd = getShanghaiYmd(now);
  const taskYmd =
    eventDate && eventDate.length >= 10
      ? (getShanghaiYmdFromEventDateField(eventDate) ?? getShanghaiYmdFromIso(targetAt.toISOString()))
      : getShanghaiYmdFromIso(targetAt.toISOString());
  const createdYmd = getShanghaiYmdFromIso(createdAtIso);

  if (taskYmd !== todayYmd) {
    return triggerBeforeEvent(targetAt, now);
  }

  if (createdYmd === todayYmd) {
    return triggerBeforeEvent(targetAt, now);
  }

  if (createdYmd < todayYmd) {
    const { hour, minute } = getShanghaiHourMinuteFromIso(targetAt.toISOString());
    const targetMinutes = hour * 60 + minute;
    if (targetMinutes < 7 * 60) {
      return triggerBeforeEvent(targetAt, now);
    }
    const sevenAm = dateFromShanghaiWallClock(todayYmd, 7, 0);
    if (sevenAm.getTime() > now.getTime()) {
      return sevenAm;
    }
    return triggerBeforeEvent(targetAt, now);
  }

  return triggerBeforeEvent(targetAt, now);
}

function notificationBodyForTrigger(
  description: string | null | undefined,
  triggerAt: Date
): string {
  const iso = triggerAt.toISOString();
  const ymd = getShanghaiYmdFromIso(iso);
  const parts = ymd.split('-');
  const month = parts[1] ? parseInt(parts[1], 10) : 0;
  const day = parts[2] ? parseInt(parts[2], 10) : 0;
  const clock = formatReminderWallTimeShanghai(iso);
  const head = `⏰ ${month}月${day}日${clock ? ` ${clock}` : ''}`;
  const desc = (description || '').trim();
  return desc ? `${head}\n${desc}` : head;
}

// 设置通知显示方式
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// 请求通知权限
export const requestNotificationPermission = async (): Promise<boolean> => {
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  if (existingStatus === 'granted') return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
};

// 把所有未完成提醒注册为本地通知
export const scheduleAllReminders = async () => {
  try {
    const granted = await requestNotificationPermission();
    if (!granted) return;

    await Notifications.cancelAllScheduledNotificationsAsync();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: userData } = await supabase
      .from('users').select('family_id').eq('id', user.id).single();
    if (!userData?.family_id) return;

    const { data: reminders } = await supabase
      .from('reminders')
      .select('id, title, description, remind_at, event_date, recurring_rule, recurring_days, created_at')
      .eq('family_id', userData.family_id)
      .eq('is_done', false)
      .order('remind_at', { ascending: true });

    if (!reminders || reminders.length === 0) return;

    const now = new Date();

    for (const reminder of reminders) {
      const remindAt = new Date(reminder.remind_at);
      const createdAtIso = reminder.created_at || remindAt.toISOString();

      if (reminder.recurring_rule === 'weekly' && reminder.recurring_days?.length) {
        const { hour, minute } = getShanghaiHourMinuteFromIso(reminder.remind_at);
        for (const weekday of reminder.recurring_days) {
          const wn = Number(weekday);
          if (!Number.isFinite(wn)) continue;
          for (let week = 0; week < 4; week++) {
            const nextDate = getUpcomingShanghaiWeekdayOccurrence(wn, hour, minute, week, now.getTime());
            if (!nextDate) continue;
            const triggerAt = triggerBeforeEvent(nextDate, now);
            if (!triggerAt) continue;
            await Notifications.scheduleNotificationAsync({
              content: {
                title: reminder.title,
                body: notificationBodyForTrigger(reminder.description, triggerAt),
                sound: true,
                data: { reminderId: reminder.id },
              },
              trigger: {
                type: Notifications.SchedulableTriggerInputTypes.DATE,
                date: triggerAt,
              },
            });
          }
        }
      } else if (reminder.recurring_rule === 'yearly') {
        const baseYmd = getShanghaiYmdFromIso(remindAt.toISOString());
        const { hour, minute } = getShanghaiHourMinuteFromIso(remindAt.toISOString());
        for (let year = 0; year < 3; year++) {
          const targetYmd = `${parseInt(baseYmd.slice(0, 4), 10) + year}-${baseYmd.slice(5, 10)}`;
          const nextDate = dateFromShanghaiWallClock(targetYmd, hour, minute);
          const triggerAt = triggerBeforeEvent(nextDate, now);
          if (!triggerAt) continue;
          await Notifications.scheduleNotificationAsync({
            content: {
              title: reminder.title,
              body: notificationBodyForTrigger(reminder.description, triggerAt),
              sound: true,
              data: { reminderId: reminder.id },
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: triggerAt,
            },
          });
        }
      } else {
        const isOnce = reminder.recurring_rule == null || reminder.recurring_rule === 'once';
        const triggerAt = isOnce
          ? remindAt.getTime() > now.getTime()
            ? remindAt
            : null
          : computeTriggerAt(remindAt, now, createdAtIso, reminder.event_date);
        if (triggerAt) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: reminder.title,
              body: notificationBodyForTrigger(reminder.description, triggerAt),
              sound: true,
              data: { reminderId: reminder.id },
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: triggerAt,
            },
          });
        }
      }
    }

    console.log(`已注册 ${reminders.length} 条提醒通知`);
  } catch (e) {
    console.error('注册通知失败:', e);
  }
};
