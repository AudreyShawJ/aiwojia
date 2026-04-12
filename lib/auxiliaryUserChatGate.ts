import type { IntentResult } from '@/lib/intentClassifier';

/**
 * 辅助权限：单独管线——仅区分「已收到 / 一句追问 / 继续走落库+短回复」。
 * - 闲聊、查问、与记录/提醒无关的陈述 → ack
 * - 明显要记录或设提醒但缺人物/事件/关键信息 → clarify（用分类器 missing_key_info）
 * - 取消提醒、或信息足够具体 → proceed（交由 chat 既有 extract + 短模型）
 */
export function resolveAuxiliaryEarlyReply(intent: IntentResult):
  | { kind: 'proceed' }
  | { kind: 'ack' }
  | { kind: 'clarify'; question: string } {
  if (intent.cancel_reminder) {
    return { kind: 'proceed' };
  }

  const mk = (intent.missing_key_info || '').trim();

  if (intent.intent === 'query' || intent.intent === 'chat') {
    return { kind: 'ack' };
  }

  const recordish =
    intent.intent === 'record' &&
    (intent.has_record_value ||
      intent.needs_reminder ||
      Boolean(intent.write_finance));

  if (intent.intent === 'record' && !recordish) {
    return { kind: 'ack' };
  }

  if (recordish && mk) {
    return { kind: 'clarify', question: mk };
  }

  return { kind: 'proceed' };
}
