import { DIGITAL_SUBSCRIPTION_CONTEXT_RE } from '@/lib/appSubscriptionKeywords';
import {
  addCalendarDaysShanghaiYmd,
  getShanghaiYmd,
  parseDayOfMonthFromChineseText,
} from '@/lib/reminderDates';

export type ExtractShape = {
  events: any[];
  reminders: any[];
  finance_transactions: any[];
  /** 抽取侧槽位缺失标记，如含 date 表示缺具体公历日 */
  missing_key_info?: string;
};

/** 用户话里是否出现可换算成具体日历日的表述（模型才允许填 event_date） */
export function userTextHasExplicitCalendarAnchor(t: string): boolean {
  return /明天|后天|大后天|今日|今天|昨天|前天|下周|下月|明年|后年|\d{1,2}\s*月\s*\d{1,2}|\d{4}\s*[-年]\s*\d{1,2}\s*[-月]\s*\d{1,2}|周[一二三四五六日天]|星期[一二三四五六日天]/.test(
    t
  );
}

function insuranceLikeBlob(title: string, desc: string): boolean {
  const b = `${title || ''}${desc || ''}`;
  return /保险|续保|保费|重疾险|医疗险|寿险|车险|意外险|投保/.test(b);
}

function appSubscriptionCueInExtract(events: any[], reminders: any[]): boolean {
  const blobs = [...(events || []), ...(reminders || [])].map(
    (x: any) => `${x?.title || ''}${x?.description || ''}`
  );
  return blobs.some(b => DIGITAL_SUBSCRIPTION_CONTEXT_RE.test(b));
}

/** 用户是否已给出可写入的续费/扣款日锚点（与 chat 侧追问逻辑一致） */
export function userHasSubscriptionRenewalAnchorInText(t: string): boolean {
  if (userTextHasExplicitCalendarAnchor(t)) return true;
  if (parseDayOfMonthFromChineseText(t) != null) return true;
  return false;
}

/**
 * 产品拍板：禁止臆造日期；报销补一条 3 日后单次跟进提醒。
 */
export function sanitizeExtractForProductRules(userText: string, result: ExtractShape): ExtractShape {
  const hasCal = userTextHasExplicitCalendarAnchor(userText);
  let events = (result.events || []).map((e: any) => {
    if (!e || hasCal) return e;
    if (insuranceLikeBlob(e.title, e.description)) {
      return {
        ...e,
        event_date: null,
        date_type: 'once',
        needs_reminder: true,
      };
    }
    return e;
  });

  let reminders = [...(result.reminders || [])];
  const subCycleNoAnchor =
    /按年|按月|包月|包年|月付|年付|月订阅|年订阅/.test(userText) &&
    !userHasSubscriptionRenewalAnchorInText(userText) &&
    appSubscriptionCueInExtract(events, reminders);
  if (subCycleNoAnchor) {
    reminders = reminders.map((r: any) => {
      if (!r || (r.date_type !== 'monthly' && r.date_type !== 'yearly')) return r;
      return { ...r, event_date: null };
    });
    events = events.map((e: any) => {
      if (!e || e.is_negative || e.is_uncertain) return e;
      if (e.date_type !== 'monthly' && e.date_type !== 'yearly') return e;
      const b = `${e.title || ''}${e.description || ''}`;
      if (!DIGITAL_SUBSCRIPTION_CONTEXT_RE.test(b)) {
        return e;
      }
      return { ...e, event_date: null, needs_reminder: e.needs_reminder !== false };
    });
  }

  if (/报销/.test(userText) && reminders.length === 0) {
    const ev = events.find(
      (e: any) => e && !e.is_negative && !e.is_uncertain && /报销/.test(`${e.title || ''}${e.description || ''}`)
    );
    if (ev?.id) {
      const ymd = addCalendarDaysShanghaiYmd(getShanghaiYmd(), 3);
      reminders = [
        ...reminders,
        {
          event_id: ev.id,
          title: '报销进度跟进',
          date_type: 'once',
          event_date: ymd,
          recurring_days: null,
          remind_before_days: 0,
        },
      ];
    }
  }

  return { ...result, events, reminders, finance_transactions: result.finance_transactions || [] };
}

/**
 * sanitize 之后对数值、日期边界、财务字段做硬性校验与就地修正。
 * @param todayYmd 上海日历今日 YYYY-MM-DD，预留与「相对今天」规则扩展用
 */
export function validateAndClampExtractResult(
  result: ExtractShape,
  familyMemberNames: string[],
  todayYmd: string
): { result: ExtractShape; warnings: string[] } {
  void todayYmd;
  const warnings: string[] = [];
  const now = new Date();
  const upperBoundMs = new Date(now.getFullYear() + 10, 0, 1).getTime();
  const lowerBoundMs = new Date(now.getFullYear() - 5, 0, 1).getTime();

  const parseMs = (s: unknown): number | null => {
    if (s == null || s === '') return null;
    const t = Date.parse(String(s));
    return Number.isFinite(t) ? t : null;
  };

  const events = result.events || [];
  const reminders = result.reminders || [];
  let finance_transactions = [...(result.finance_transactions || [])];

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;

    if (typeof event.amount === 'number' && event.amount < 0) {
      warnings.push(`event.amount 为负数（${event.amount}），已修正为 0`);
      event.amount = 0;
    }

    if (event.event_date) {
      const ms = parseMs(event.event_date);
      if (ms != null && ms >= upperBoundMs) {
        warnings.push(`event_date ${event.event_date} 超出范围，已清空`);
        event.event_date = null;
      } else if (ms != null && ms < lowerBoundMs) {
        warnings.push(`event_date ${event.event_date} 早于5年前，已清空`);
        event.event_date = null;
      }
    }

    if (
      event.is_person &&
      event.related_member &&
      familyMemberNames.length > 0 &&
      !familyMemberNames.some(
        n =>
          n &&
          (String(event.related_member).includes(n) || n.includes(String(event.related_member)))
      )
    ) {
      warnings.push(`related_member「${event.related_member}」不在成员列表，已保留但标记`);
    }

    if (event.height != null && (event.height < 30 || event.height > 250)) {
      warnings.push(`height ${event.height} 超出合理范围，已清空`);
      event.height = null;
    }

    if (event.weight != null && (event.weight < 1 || event.weight > 300)) {
      warnings.push(`weight ${event.weight} 超出合理范围，已清空`);
      event.weight = null;
    }
  }

  for (const reminder of reminders) {
    if (!reminder || typeof reminder !== 'object') continue;

    if (reminder.event_date) {
      const ms = parseMs(reminder.event_date);
      if (ms != null && ms >= upperBoundMs) {
        warnings.push(`reminder.event_date ${reminder.event_date} 超出范围，已清空`);
        reminder.event_date = null;
      }
    }

    const rbd = Number(reminder.remind_before_days);
    if (Number.isFinite(rbd) && rbd > 365) {
      warnings.push(`remind_before_days ${reminder.remind_before_days} 异常，已重置为 0`);
      reminder.remind_before_days = 0;
    }
  }

  const keptFinance: typeof finance_transactions = [];
  for (const tx of finance_transactions) {
    if (!tx || typeof tx !== 'object') continue;
    const amt = Number(tx.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      warnings.push(`finance amount ${tx.amount} 无效，已过滤`);
      continue;
    }
    tx.amount = amt;
    if (tx.direction !== 'income' && tx.direction !== 'expense') {
      warnings.push(`finance direction「${tx.direction}」无效，已改为 expense`);
      tx.direction = 'expense';
    }
    keptFinance.push(tx);
  }
  finance_transactions = keptFinance;

  const out: ExtractShape = {
    ...result,
    events,
    reminders,
    finance_transactions,
  };

  if (warnings.length > 0) {
    console.warn('[ExtractValidate] warnings:', warnings);
  }
  return { result: out, warnings };
}

/** 追加到抽取 Prompt 末尾的固定规则（与 kinship 动态块拼接） */
export const EXTRACT_PROMPT_PRODUCT_APPENDIX = `
【产品规则·必须遵守】
- **禁止臆造日期**：用户未明确说出可换算的日历信息（如「X月X日」「明天」「下周五」等）时，涉及**保险续保/订阅到期/证件截止**等事项的 event_date、reminders.event_date **必须为 null**，不要猜测具体日期；可 needs_reminder=true 表示需要追问。
- **数字平台订阅（任意 App/网站/软件的会员、续订、自动续费等，勿依赖具体平台名）**：用户未说明**按月还是按年**时，不要输出 monthly/yearly 周期提醒；应 needs_reminder=true、date_type=once、日期 null，留待追问后再定周期。
- **用户已说明按月/按年，但未说明续费/扣款的具体规则**（未确认「是否每年/每月的今天」、未说「×月×日」「每月×号」「就今天」等）时：可设 date_type=monthly 或 yearly 并在 title/description 写清周期，但 **reminders.event_date 与对应 event 的 event_date 必须为 null**；needs_reminder=true；**禁止**臆造具体日期（尤其禁止无依据使用某月31日、订阅「到期日」等你未从用户话里读到的日子）。
- **用户已确认与「今天」同一天续费/扣款**（如回复「对」「是」「就今天」「跟今天一样」，且近期对话里助手刚问过续费日）：用**北京时间今天**的 YYYY-MM-DD 写入 event_date 作为基准（按年=每年该月该日；按月=每月该「日」）。
- **用户说出其它明确日期**：按用户表述写入 event_date 或每月几号，与近期订阅语境合并理解。
- **报销跟进**：用户提到报销且需跟进时，应有一条**一次性**提醒，event_date 为「今天起第 3 个自然日」（上海日历），date_type=once，title 含「报销」或「报销跟进」。
- **房贷/月供/按月订阅扣费**：设 date_type=monthly 时，须在 title/description 或 reminders.event_date 中体现**每月几号**（如「每月15号」或 event_date 用**下一次扣款/还款日** YYYY-MM-DD）；用户刚回复「15号」等短句时，须与近期对话中的月供/订阅合并理解并写入正确日份。
- **快递/驿站/取件（含菜鸟、邮政等到站通知）**：
  - **每个独立待取包裹 = 一条 event + 一条 reminders**，列表上要能分别勾选完成；**禁止**把多个取件码收成一条提醒。
  - **不同取件码**、**不同运单/包裹描述**、**用户分条粘贴的不同短信**：一律视为**多件独立事项**，各自 **id 不同**，且 **group_id 必须各不相同**（例如 g_pkg_1、g_pkg_2…），**禁止**因「同一驿站/同一店铺」共用 group_id。
  - 每条 event 的 title/description 写清该件的特征（取件码、快递公司、尾号等），便于区分；每条 reminders.event_id 必须对上对应 event 的 id。
  - needs_reminder=true（待取件）；无明确日历日时 event_date 可为 null，由系统按钟点与「今天=发送时刻、远期默认 07:00」生成 remind_at。
`;
