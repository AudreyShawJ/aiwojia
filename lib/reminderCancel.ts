import { formatReminderDisplayTime } from '@/lib/reminderDates';
import { supabase } from '@/lib/supabase';

/**
 * 匹配前将常见近义词归一到同一字面，避免「清洁」对不上标题里的「清洗」等。
 * 仅用于比对，不改库内原文。
 */
function normalizeCancelMatchText(s: string): string {
  let x = s.toLowerCase();
  const pairs: [RegExp, string][] = [
    [/清洗/g, '清洁'],
    [/擦洗/g, '清洁'],
    [/交费/g, '缴费'],
    [/交款/g, '缴费'],
    [/交纳/g, '缴费'],
  ];
  for (const [re, rep] of pairs) x = x.replace(re, rep);
  return x;
}

function matchesByBigramOverlap(compactQ: string, compactBlob: string, minRatio: number): boolean {
  const n = compactQ.length;
  if (n < 2) return false;
  if (n === 2) return compactBlob.includes(compactQ);
  let hits = 0;
  const total = n - 1;
  for (let i = 0; i < total; i++) {
    if (compactBlob.includes(compactQ.slice(i, i + 2))) hits++;
  }
  return hits / total >= minRatio;
}

/** 从用户原句剥离指令词，得到匹配提醒标题用的关键词（可能为空） */
export function fallbackCancelKeywords(userMessage: string): string {
  const s = userMessage
    .replace(
      /取消|删掉|删除|撤销|去掉|撤掉|作废|关闭|停掉|移除|解除|废掉|删了|关了|停了|不用|不要|别再|不用了|不要了|帮忙|帮|我|一下|的|那条|这个|请|把|去|记得|提醒|事项|待办|相关|关于|麻烦|一下了|哈|呢|吧|啊|哦/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, 32);
}

export function reminderMatchesCancelQuery(
  row: { title: string; description?: string | null },
  query: string
): boolean {
  const qRaw = query.trim();
  if (!qRaw) return false;
  const blobRaw = `${row.title || ''} ${row.description || ''}`;
  const q = normalizeCancelMatchText(qRaw);
  const blob = normalizeCancelMatchText(blobRaw);
  const parts = q.split(/\s+/).filter(p => p.length > 0);
  const useParts = parts.length > 0 ? parts : [q];
  if (useParts.every(p => blob.includes(p))) return true;

  const compactQ = q.replace(/\s/g, '');
  const compactBlob = blob.replace(/\s/g, '');
  if (compactQ.length >= 2) {
    const minRatio = compactQ.length <= 4 ? 0.45 : 0.55;
    if (matchesByBigramOverlap(compactQ, compactBlob, minRatio)) return true;
  }
  return false;
}

/** 与记录页「取消」一致：标记完成 + 清空待记账，不写财务流水 */
export async function cancelReminderAsDeclined(
  reminderId: string
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from('reminders')
    .update({
      is_done: true,
      pending_expense_amount: null,
      pending_expense_category: null,
    } as any)
    .eq('id', reminderId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export function formatReminderChoiceLabel(r: {
  remind_at: string;
  event_date?: string | null;
}): string {
  return formatReminderDisplayTime({
    remind_at: r.remind_at,
    event_date: r.event_date ?? null,
  });
}
