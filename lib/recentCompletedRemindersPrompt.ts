import { supabase } from '@/lib/supabase';

/**
 * 注入主对话 system：用户点「完成」的待办（有 completed_at），避免模型只看到 family_events 而误判「不知是计划还是已做」。
 */
export async function buildRecentCompletedRemindersPromptBlock(
  familyId: string,
  recorderLabelByUserId: Record<string, string>,
  limit = 18
): Promise<string> {
  try {
    let rows: any[] | null = null;
    let error: { message?: string } | null = null;
    const full = await supabase
      .from('reminders')
      .select(
        'title, related_member, completed_at, completed_by, created_by, is_done, recurring_rule'
      )
      .eq('family_id', familyId)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(limit);
    if (full.error && /completed_by|schema cache/i.test(full.error.message ?? '')) {
      const slim = await supabase
        .from('reminders')
        .select('title, related_member, completed_at, created_by, is_done, recurring_rule')
        .eq('family_id', familyId)
        .not('completed_at', 'is', null)
        .order('completed_at', { ascending: false })
        .limit(limit);
      rows = slim.data;
      error = slim.error;
    } else {
      rows = full.data;
      error = full.error;
    }

    if (error || !rows?.length) return '';

    let out =
      '\n【最近已完成的待办】（含一次性已关闭与周期待办「完成本次」；后者 is_done 可能仍为 false，以 completed_at 为准。**标记完成者**=当时登录账户（completed_by）；**待办创建者**=created_by。向用户回答时：优先说事项与时间；**不要主动强调是谁点的完成**，除非用户明确问「谁勾的」。若问「什么时候做的」，用下列时间即可。）\n';
    rows.forEach((r: any, i: number) => {
      const when = r.completed_at
        ? new Date(r.completed_at).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '';
      const completer =
        r.completed_by && recorderLabelByUserId[r.completed_by]
          ? recorderLabelByUserId[r.completed_by]
          : null;
      const creator =
        r.created_by && recorderLabelByUserId[r.created_by]
          ? recorderLabelByUserId[r.created_by]
          : null;
      const who = r.related_member ? `${r.related_member}：` : '';
      const markLine = completer
        ? `标记完成者（当时登录）：${completer}｜时间：${when}`
        : `标记完成｜时间：${when}（操作账户未记录）`;
      const creatorDiff =
        creator && r.created_by !== r.completed_by ? `｜待办创建者：${creator}` : '';
      const recurringNote =
        r.is_done === false &&
        r.recurring_rule &&
        ['daily', 'weekly', 'monthly', 'yearly'].includes(String(r.recurring_rule))
          ? '｜周期待办（已勾本期，下一期仍有效）'
          : '';
      out += `${i + 1}. ${who}${r.title ?? ''}｜${markLine}${creatorDiff}${recurringNote}\n`;
    });
    return out;
  } catch {
    return '';
  }
}
