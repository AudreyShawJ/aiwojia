
export interface IntentResult {
  intent: 'chat' | 'query' | 'record';
  query_type: 'time' | 'document' | 'history' | 'status' | null;
  has_record_value: boolean;
  missing_key_info: string;
  related_member: string;
  event_type: 'health' | 'child' | 'finance' | 'vehicle' | 'house' | 
              'relationship' | 'admin' | 'plant_pet' | 'daily';
  needs_reminder: boolean;
  needs_deep_reasoning: boolean;
  unknown_member_detected: string;
  /** 与 app/chat.tsx 内联分类器对齐：金额+财务语义时写 finance_transactions */
  write_finance?: boolean;
  cancel_reminder?: boolean;
  cancel_reminder_keywords?: string;
}

export async function classifyIntent(
  userMessage: string,
  recentHistory: string,
  familyMembers: string
): Promise<IntentResult> {
  const prompt = `你是家庭信息管理助手的意图分类器。

家庭成员：${familyMembers || '暂无'}
近期对话：${recentHistory || '暂无'}

用户说：「${userMessage}」

请严格按以下JSON格式输出，不要输出任何其他内容：
{
  "intent": "chat 或 query 或 record",
  "query_type": "time 或 document 或 history 或 status 或 null",
  "has_record_value": true或false,
  "missing_key_info": "缺少的关键信息，完整则为空字符串",
  "related_member": "相关成员名字，无则为空字符串",
  "event_type": "health或child或finance或vehicle或house或relationship或admin或plant_pet或daily",
  "needs_reminder": true或false,
  "needs_deep_reasoning": true或false,
  "unknown_member_detected": "检测到的未知成员名字，无则为空字符串",
  "cancel_reminder": true或false,
  "cancel_reminder_keywords": "要取消的提醒匹配词，如：水费；无则为空字符串"
}

判断规则：
- cancel_reminder=true：用户明确要求取消/删除某条未完成提醒；「不想取消」等为 false
- cancel_reminder_keywords：从用户话里抽出最短匹配词
- intent=chat：闲聊、情绪倾诉、夫妻关系矛盾、不需要记录的日常对话
- intent=query：用户在问历史信息、查资料、问近期待办
- intent=record：用户在陈述一件值得记录的家庭事件
- has_record_value=false：日常琐事（一日三餐、加油、停车）、夫妻私密对话
- needs_reminder=true：就医复诊、疫苗、保险到期、证件续签、兴趣班缴费、生日纪念日等
- needs_deep_reasoning=true：健康分析、大额财务决策、教育规划、养老规划、育儿问题
- 【亲属称谓处理——最高优先级规则】用户说「我妈」「我爸」「我爷爷」「我奶奶」「我外公」「我外婆」「我兄弟」「我姐姐」等时：第一步在列表中按 role 与称谓精确匹配（例「我妈」→ role 含妈妈/母亲且 linked_user_id 为空；「我外公」→ role 含「妻子父亲」或旧值「外公」）；第二步无匹配则 unknown_member_detected 必须填规范称谓（如「妈妈」），禁止用推断凑成员、禁止反问「你妈妈是指哪位」；第三步当前用户由 linked_user_id 定锚（丈夫/妻子各自「我妈」仅指本人之母），不得跨视角混淆。
- unknown_member_detected：仅填可能是家人且不在家庭成员列表中的名字；明显职场敬称（××总、××局长/科长/处长等职务称呼）必须填空字符串`;

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.EXPO_PUBLIC_DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 300,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {}

  // 默认兜底
  return {
    intent: 'chat',
    query_type: null,
    has_record_value: false,
    missing_key_info: '',
    related_member: '',
    event_type: 'daily',
    needs_reminder: false,
    needs_deep_reasoning: false,
    unknown_member_detected: '',
    cancel_reminder: false,
    cancel_reminder_keywords: '',
  };
}