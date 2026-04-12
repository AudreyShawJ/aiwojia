import { scheduleAllReminders } from '@/lib/notifications';
import { computeNextOccurrenceAfterComplete } from '@/lib/recurringReminderAdvance';
import { supabase } from '@/lib/supabase';

const RECURRING = new Set(['daily', 'weekly', 'monthly', 'yearly']);

function dbg(...args: unknown[]) {
  if (__DEV__) console.log('[completeReminder]', ...args);
}

/** 与 computeNextOccurrenceAfterComplete 一致：空串 / once 视为非周期，避免库里有 'once' 却仍走周期分支 */
function normalizeReminderRecurringRule(raw: string | null | undefined): string | null {
  if (raw == null || typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t === '' || t.toLowerCase() === 'once') return null;
  return t;
}

/** 仅当 PostgREST 明确报「schema 里没有该列」时才降级；勿把 FK/RLS 等含列名的报错误判为缺列 */
function isSchemaCacheMissingColumn(message: string, column: string): boolean {
  const m = message || '';
  if (!m.includes(column)) return false;
  return /schema cache/i.test(m) || /could not find the '/i.test(m);
}

export type CompleteReminderResult =
  | { ok: true; mode: 'recurring_advanced' | 'done' }
  | { ok: false; error: string };

/**
 * 记录页 / 提醒页 共用：单次提醒标记完成；周期提醒「完成本次」并滚到下一期。
 */
export async function completeReminderOccurrence(reminderId: string): Promise<CompleteReminderResult> {
  dbg('start', { reminderId });
  const { data: row, error: fetchErr } = await supabase
    .from('reminders')
    .select(
      'id, family_id, created_by, title, description, remind_at, event_date, recurring_rule, recurring_days, is_done, pending_expense_amount, pending_expense_category, linked_event_id, completed_occurrence_count'
    )
    .eq('id', reminderId)
    .single();

  if (fetchErr || !row) {
    return { ok: false, error: fetchErr?.message || '未找到提醒' };
  }

  const pending =
    row.pending_expense_amount != null ? Number(row.pending_expense_amount) : 0;
  if (pending > 0) {
    const { error: finErr } = await supabase.from('finance_transactions').insert({
      family_id: row.family_id,
      created_by: row.created_by,
      conversation_id: null,
      linked_event_id: row.linked_event_id || null,
      title: (row.title || '支出').slice(0, 200),
      description: row.description ? String(row.description).slice(0, 2000) : null,
      amount: pending,
      direction: 'expense',
      category: row.pending_expense_category || 'daily',
      occurred_at: new Date().toISOString(),
      source: 'reminder_complete',
    } as any);
    if (finErr) return { ok: false, error: finErr.message };
  }

  const { data: authData } = await supabase.auth.getUser();
  const completedByUserId = authData?.user?.id ?? null;
  const completedAtIso = new Date().toISOString();

  const rule = normalizeReminderRecurringRule(row.recurring_rule as string | null);
  const isRecurring = rule != null && RECURRING.has(rule);
  dbg('loaded', {
    rawRecurringRule: row.recurring_rule,
    normalizedRule: rule,
    isRecurring,
    completedByUserId: completedByUserId ? `${completedByUserId.slice(0, 8)}…` : null,
    completedAtIso,
  });

  if (isRecurring) {
    const next = computeNextOccurrenceAfterComplete({
      recurring_rule: rule,
      recurring_days: row.recurring_days,
      remind_at: row.remind_at,
      event_date: row.event_date,
    });
    if (next) {
      dbg('recurring branch', { hasNext: true });
      const count = Number(row.completed_occurrence_count) || 0;
      const baseRecurring = {
        completed_occurrence_count: count + 1,
        remind_at: next.remind_at,
        event_date: next.event_date,
        is_done: false,
        pending_expense_amount: null,
        pending_expense_category: null,
      };
      /** 周期「完成本次」也记录本次勾选时间与操作者，供对话与审计；滚期后 is_done 仍为 false */
      const recurringPayloads: Record<string, unknown>[] = [
        { ...baseRecurring, completed_at: completedAtIso, completed_by: completedByUserId },
        { ...baseRecurring, completed_at: completedAtIso },
        { ...baseRecurring },
      ];
      let lastRecurringMsg = '';
      for (let ri = 0; ri < recurringPayloads.length; ri++) {
        const { error: upErr } = await supabase
          .from('reminders')
          .update(recurringPayloads[ri] as any)
          .eq('id', reminderId);
        if (!upErr) {
          dbg('recurring ok', { payloadTry: ri, keys: Object.keys(recurringPayloads[ri]) });
          await scheduleAllReminders();
          return { ok: true, mode: 'recurring_advanced' };
        }
        lastRecurringMsg = upErr.message || '';
        dbg('recurring update err', { try: ri, message: lastRecurringMsg });
        const retry =
          (ri === 0 &&
            (isSchemaCacheMissingColumn(lastRecurringMsg, 'completed_by') ||
              isSchemaCacheMissingColumn(lastRecurringMsg, 'completed_at'))) ||
          (ri === 1 && isSchemaCacheMissingColumn(lastRecurringMsg, 'completed_at'));
        if (!retry) return { ok: false, error: lastRecurringMsg };
      }
      return { ok: false, error: lastRecurringMsg || '更新失败' };
    }
    dbg('recurring branch', { hasNext: false, fallbackToMarkDone: true });
  }

  const clears = { pending_expense_amount: null, pending_expense_category: null };
  /** 未执行 20250326/20250327 迁移时列不存在，降级写入避免点「完成」整页失败 */
  const markDonePayloads: Record<string, unknown>[] = [
    {
      is_done: true,
      completed_at: completedAtIso,
      completed_by: completedByUserId,
      ...clears,
    },
    { is_done: true, completed_at: completedAtIso, ...clears },
    { is_done: true, ...clears },
  ];
  dbg('mark_done branch');
  let lastMsg = '';
  for (let mi = 0; mi < markDonePayloads.length; mi++) {
    const { error: upErr } = await supabase
      .from('reminders')
      .update(markDonePayloads[mi] as any)
      .eq('id', reminderId);
    if (!upErr) {
      dbg('mark_done ok', { payloadTry: mi, keys: Object.keys(markDonePayloads[mi]) });
      await scheduleAllReminders();
      return { ok: true, mode: 'done' };
    }
    lastMsg = upErr.message || '';
    dbg('mark_done update err', { try: mi, message: lastMsg });
    const retry =
      (mi === 0 && isSchemaCacheMissingColumn(lastMsg, 'completed_by')) ||
      (mi === 1 && isSchemaCacheMissingColumn(lastMsg, 'completed_at'));
    if (!retry) return { ok: false, error: lastMsg };
  }
  dbg('mark_done all tries failed', { lastMsg });
  return { ok: false, error: lastMsg || '更新失败' };
}
