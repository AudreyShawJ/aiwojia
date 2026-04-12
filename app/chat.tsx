import {
  appendRecorderKinshipProvenanceLine,
  normalizeExtractedEventsForClassification,
} from '@/lib/extractEventNormalization';
import {
  ASSISTANT_ASKED_SUBSCRIPTION_CYCLE_RE,
  DIGITAL_SUBSCRIPTION_CONTEXT_RE,
} from '@/lib/appSubscriptionKeywords';
import {
  EXTRACT_PROMPT_PRODUCT_APPENDIX,
  sanitizeExtractForProductRules,
  userHasSubscriptionRenewalAnchorInText,
  validateAndClampExtractResult,
} from '@/lib/extractProductRules';
import {
  buildConversationPerspectiveBlock,
  buildFamilyHistoryProvenanceRules,
  buildKinshipRulesForPrompt,
} from '@/lib/kinshipPrompt';
import {
  buildRecorderLabelByUserId,
  formatFamilyEventHistoryLine,
  getFamilyEventHistoryPerspectiveFields,
} from '@/lib/familyHistoryRecorder';
import { resolveKinshipForRecordedEvent } from '@/lib/kinshipResolver';
import {
  buildHistoryLineCrossPerspectiveNote,
  stripDeicticKinshipForSharedRecord,
} from '@/lib/sharedRecordDeictic';
import {
  parseMinutesOffsetFromNowFromChinese,
  parseRemindLeadMinutesFromChinese,
  resolveOnceEventAndRemindAt,
} from '@/lib/reminderNotifySchedule';
import {
  buildReminderTimeUpdateVoiceHint,
  buildSameEventVoiceInject,
  extractPlaceCueForSameEvent,
  fetchReminderDedupeCandidatesForVoice,
  fetchRecentFamilyEventsForDedupe,
  findDuplicateAiReminder,
  findDuplicateFamilyEventForMerge,
  formatYmdBriefChinese,
  isSameRemindAtShanghaiMinute,
  pickAskUpdateDiffType,
  quickDedupCheck,
  reminderRowToDedupeRow,
  sameEventLocationCueChanged,
  sameEventVoiceRecordedByForInject,
  strictSameRelatedForVoice,
  strictSameRemindMomentForVoice,
  upsertCandidateAfterInsert,
  voiceReminderTimeLabel,
  type FamilyEventDedupeRow,
  type QuickDedupHit,
  type ReminderDedupeRow,
  type SameEventVoiceHint,
} from '@/lib/reminderDuplicate';
import {
  scheduleAllReminders,
} from '@/lib/notifications';
import {
  cancelReminderAsDeclined,
  fallbackCancelKeywords,
  formatReminderChoiceLabel,
  reminderMatchesCancelQuery,
} from '@/lib/reminderCancel';
import { buildRecentCompletedRemindersPromptBlock } from '@/lib/recentCompletedRemindersPrompt';
import {
  addCalendarDaysShanghaiYmd,
  dateFromShanghaiWallClock,
  formatReminderConfirmShanghaiDateTime,
  formatReminderDisplayTime,
  formatReminderWallTimeShanghai,
  getNextMonthlyOccurrenceYmd,
  getNextYearlyOccurrenceYmd,
  getReminderIncompleteStatusLabel,
  getReminderSortKey,
  getReminderStatus,
  getShanghaiYmd,
  getShanghaiYmdFromEventDateField,
  getShanghaiYmdFromIso,
  normalizeExtractEventDateForDb,
  getShanghaiWeekday17FromYmd,
  getUpcomingShanghaiWeekdayOccurrence,
  parseDayOfMonthFromChineseText,
} from '@/lib/reminderDates';
import {
  isWorkplaceHonorific,
  loadDeclinedNewMemberNames,
  normalizeUnknownMemberName,
  recordDeclinedNewMemberName,
} from '@/lib/newMemberPrompt';
import { subscribeChatFamilyContextCacheInvalidate } from '@/lib/chatFamilyContextCache';
import { deriveAccessTierFromLegacyPerms, type AccessTier } from '@/lib/familyAccess';
import { resolveAuxiliaryEarlyReply } from '@/lib/auxiliaryUserChatGate';
import { isMissingAccessTierColumnError } from '@/lib/accessTierDb';
import { QuickStartPanel } from '@/components/chat/QuickStartPanel';
import { Logo13Icon } from '@/components/Logo13Icon';
import { VoiceInputModal } from '@/components/VoiceInputModal';
import { GRANDPARENT_ROLES } from '@/constants/familyMemberRoles';
import { brand, colors } from '@/constants/designTokens';
import { supabase } from '@/lib/supabase';
import { shouldBlockSensitiveChatInput } from '@/lib/sensitiveChatContent';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { readFileAsBase64, decodeBase64ToUint8 } from '@/lib/file-upload';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Mic, Paperclip, Send, Square, UserPlus } from 'lucide-react-native';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  AppStateStatus,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import Markdown from 'react-native-markdown-display';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { requestMicPermission, startRecording, type AsrState } from '@/lib/aliyun-asr';

type AiAbortReason = 'user' | 'timer' | 'superseded';

const SHOW_EXTRACT_DEBUG = false;

function isAbortLikeError(e: unknown): boolean {
  if (e == null || typeof e !== 'object') return false;
  const any = e as Record<string, unknown>;
  if (any.name === 'AbortError') return true;
  if (any.code === 'ABORT_ERR' || any.code === 20) return true;
  const msg = String(any.message ?? '');
  return /aborted|AbortError/i.test(msg);
}

function isRetryableNetworkError(e: unknown): boolean {
  if (e == null || typeof e !== 'object') return false;
  const msg = String((e as Error).message ?? '');
  return /Network request failed|Failed to fetch|ETIMEDOUT|ECONNRESET|timed out/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 从数据库拉消息时若与「发送中」的本地气泡合并，避免整表 setState 冲掉 u-/a- 临时 id 的 pending，
 * 否则模型已返回但 map(loadingId) 对不上，界面仍显示「理解中…」却误以为已提交成功。
 */
function mergeServerChatRowsWithLocal(
  data: any[],
  prev: ChatMessage[],
  mapRow: (m: any) => ChatMessage
): ChatMessage[] {
  const serverList = data.map(mapRow);
  const serverIds = new Set(serverList.map(m => m.id));
  const norm = (t: string) => t.trim();
  const userTexts = new Set(serverList.filter(m => m.role === 'user').map(m => norm(m.text || '')));
  const assistantTexts = new Set(
    serverList.filter(m => m.role === 'assistant').map(m => norm(m.text || ''))
  );
  const extras = prev.filter(m => {
    const isClientId = typeof m.id === 'string' && (m.id.startsWith('u-') || m.id.startsWith('a-'));
    if (m.pending) return true;
    if (!isClientId) return false;
    if (serverIds.has(m.id)) return false;
    if (m.role === 'user' && userTexts.has(norm(m.text || ''))) return false;
    if (m.role === 'assistant' && assistantTexts.has(norm(m.text || ''))) return false;
    return true;
  });
  return [...serverList, ...extras];
}

const PRIMARY = colors.primary;

/** 历史对话里可能出现过的极短占位回复；勿让模型照搬为当前轮默认风格 */
function isAiLimitedCannedReply(text: string): boolean {
  const t = text.trim();
  return t === '已收到。' || t === '已记录。' || t === '已收到' || t === '已记录';
}


type Role = 'user' | 'assistant';
type ReminderCancelChoice = { id: string; title: string; remindAtLabel: string };

type ChatMessage = {
  id: string;
  role: Role;
  text: string;
  pending?: boolean;
  fileType?: 'image' | 'pdf' | 'other';
  fileUri?: string;
  fileName?: string;
  /** 多条提醒待选取消时，展示为可点按钮 */
  reminderCancelChoices?: ReminderCancelChoice[];
};

interface IntentResult {
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
  /** 金额 + 财务语义：应写入 finance_transactions（可与 has_record_value=false 并存） */
  write_finance: boolean;
  /** 用户是否要求取消未完成提醒 */
  cancel_reminder: boolean;
  /** 与提醒标题匹配的关键词，如「水费」 */
  cancel_reminder_keywords: string;
}

const SCENE_KNOWLEDGE: Record<string, string> = {
  health: `健康医疗场景规则（信息已完整，直接记录不要追问）：
- 就诊/复诊：记录就诊情况和结果，建议复诊提醒1-3个月
- 用药：记录药品名称和服药周期，老人用药建议设每日提醒
- 体检：记录检查结果，建议1年后提醒
- 疫苗：记录疫苗名称，根据类型推算下次时间
- 所有健康分析回复必须加：「以上建议仅供参考，请以医生诊断为准」`,

  child: `孩子事务场景规则（信息已完整，直接记录不要追问）：
- 学校作业/通知：记录截止日期，提前1天提醒
- 兴趣班：记录开课时间，设开课提醒和缴费提醒
- 疫苗/体检：根据孩子年龄推算标准接种计划
- 成长里程碑（走路/说话/换牙）：温暖记录，回复「好珍贵的时刻！」
- 身高体重：记录数值，如果JSON里有height或weight字段，系统会自动存入成长曲线
- 情绪行为问题：温暖回应，给出基于儿童心理学的建议`,

  finance: `财务场景规则（信息已完整，直接记录不要追问）：
- 报销：记录提交；系统会设**第3天**一次性跟进提醒
- 房贷/月供：须明确**每月几号还款**才能说已设提醒；用户若已说「本月X号还」可推断为**每月X号**，回复中写出该日供核对
- 数字平台订阅/会员：须先弄清**按月还是按年**再确认**续费/扣款日**，再设周期；回复写明规则与依据日期
- 保险续保：用户未给出具体到期日则**禁止**编造日期，只追问；有明确日期再设提前提醒
- 信用卡等：记录还款日，可提前3天提醒
- 大额决策：记录背景并免责，不构成专业财务建议`,

  vehicle: `车辆场景规则（信息已完整，直接记录不要追问）：
- 日常保养：记录保养内容，建议6个月后提醒
- 年检/保险续保：记录日期，建议11个月后提醒
- 违章：记录违章类型，提醒尽快处理，超期会加分
- 加油/充电/停车：不记录，闲聊回应`,

  house: `房产居住场景规则（信息已完整，直接记录不要追问）：
- 维修报修：记录报修内容，3天后跟进提醒
- 甲醛检测：记录检测结果，3个月后复测提醒
- 空调滤网：记录清洗时间，3个月后提醒
- 装修监工：记录进度节点，设阶段提醒
- 租客合同：记录到期日，到期前1个月提醒`,

  relationship: `社会关系场景规则（信息已完整，直接记录不要追问）：
- 生日：记录日期，每年提前3天提醒
- 结婚纪念日：记录日期，提前1周提醒
- 礼金往来：记录金额和对象，用于往来参考
- 借钱/还钱：记录金额，必要时设还款提醒
- 夫妻矛盾/情绪倾诉：不记录，温暖回应，提供沟通建议`,

  admin: `行政合规场景规则（信息已完整，直接记录不要追问）：
- 居住证：记录办理时间，11个月后续签提醒
- 护照：记录办理时间，9年6个月后续签提醒
- 签证：记录到期日，到期前3个月提醒
- 社保/公积金：记录缴纳状态，关注断缴风险
- 小孩上学材料：记录准备情况，招生季前1个月提醒`,

  plant_pet: `植物宠物场景规则（信息已完整，直接记录不要追问）：
植物浇水参考：蔬菜每1-2天，多肉每2-3周，绿萝每3-5天，兰花每5-7天，月季每2-3天，发财树每7-10天
- 种植记录：记录植物种类，主动说「XX一般需要每X天浇水，要帮你设个提醒吗？」
- 宠物疫苗（猫狗狂犬）：记录接种时间，11个月后提醒
- 宠物驱虫：记录驱虫时间，3个月后提醒
- 宠物生病：先给情绪支持，再记录病情`,

  daily: `日常场景规则（信息已完整，直接记录不要追问）：
- 以轻量回应为主，不强行记录
- 一日三餐、买菜、加油、停车：闲聊回应，不记录
- 聚餐安排：记录时间地点，提前1天提醒`,
};

/** 本周一～日（上海日历），勿用 toLocaleString 再 new Date（部分环境会得到 Invalid Date → NaN月NaN日） */
function weekDatesLineForPromptShanghai(ref: Date): string {
  const todayYmd = getShanghaiYmd(ref);
  const wd = getShanghaiWeekday17FromYmd(todayYmd);
  const mondayYmd = addCalendarDaysShanghaiYmd(todayYmd, -(wd - 1));
  const labels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  return Array.from({ length: 7 }, (_, i) => {
    const ymd = addCalendarDaysShanghaiYmd(mondayYmd, i);
    const mo = parseInt(ymd.slice(5, 7), 10);
    const day = parseInt(ymd.slice(8, 10), 10);
    return `${labels[i]}=${mo}月${day}日`;
  }).join('、');
}

function intentClassifierDefaultResult(): IntentResult {
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
    write_finance: false,
    cancel_reminder: false,
    cancel_reminder_keywords: '',
  };
}

function buildIntentClassifierAuxiliaryBlock(auxiliaryAccount: boolean): string {
  if (!auxiliaryAccount) return '';
  return `

【本轮用户为辅助账号】只能帮家庭记录事实或设置提醒；**不**识别新成员，unknown_member_detected 必须始终为空字符串。
- intent=chat：纯寒暄、与记录/提醒无关的零碎话、情绪闲聊（与具体家务事项无关）。
- intent=query：用户像在问「家里有什么事」「待办有哪些」「某人记录」等需查看家庭数据的提问；此类仍标 query（客户端会统一回复「已收到」）。
- intent=record：用户交代要记下的事，或需要到期/到时提醒（含「明天提醒我…」「记得买…」「宝宝…打针」等）；哪怕很简短也优先 record。
- 明显要记录/设提醒但说不清**是谁**、**什么事**时：intent=record，has_record_value 或 needs_reminder 至少其一为 true，missing_key_info 规则见主文「missing_key_info / 时间」；其中须填小写 **date** 的情形见「模糊时间 → date」；须用**固定中文问句**的（如「每周几？」）见「周期性周几/几号」；不要用废弃英文关键字 time。
- 不把「提醒/记得/别忘了/到期」类明确诉求判成 chat。`;
}

function buildIntentClassifierPreamble(params: {
  userMessage: string;
  recentHistory: string;
  familyMembers: string;
  currentUserMemberName: string;
  todayStr: string;
  weekDates: string;
  auxiliaryBlock: string;
}): string {
  const currentUserMemberName = (params.currentUserMemberName || '').trim() || '暂无';
  return `你是家庭信息管理助手的意图分类器。今天是北京时间${params.todayStr}，本周日期：${params.weekDates}。

家庭成员：${params.familyMembers || '暂无'}
当前发言用户姓名（related_member 默认主语）：${currentUserMemberName}
近期对话：${params.recentHistory || '暂无'}

用户说：「${params.userMessage}」
${params.auxiliaryBlock}`;
}

function buildIntentClassifierFlatJsonSchemaBlock(): string {
  return `严格按以下JSON格式输出，不要输出任何其他内容：
{
  "intent": "chat或query或record",
  "query_type": "time或document或history或status或null",
  "has_record_value": true或false,
  "missing_key_info": "空字符串；模糊时间须追问日锚时填小写 date；「每周/每月」固定问句见下文；**已完成消费要写账但没说金额**时可填「花了多少？」；其它缺失填一句中文追问，不要用 time",
  "related_member": "相关成员姓名；默认主语见「当前发言用户姓名」一行，规则见下",
  "event_type": "health或child或finance或vehicle或house或relationship或admin或plant_pet或daily",
  "needs_reminder": true或false,
  "needs_deep_reasoning": true或false,
  "unknown_member_detected": "检测到的未知成员名字，无则为空字符串",
  "write_finance": true或false,
  "cancel_reminder": true或false,
  "cancel_reminder_keywords": "要取消的提醒匹配词，如：水费、房贷、复诊；无法提取则为空字符串"
}`;
}

function buildIntentClassifierJudgmentRulesBlock(
  currentUserMemberName: string,
  currentUserLinkedRole?: string | null
): string {
  const rel = (currentUserMemberName || '').trim() || '暂无';
  const rLinked = (currentUserLinkedRole || '').trim();
  const currentUserRoleLine =
    rLinked === '丈夫' || rLinked === '老公' || rLinked === '先生'
      ? '**当前发言用户家庭成员 role**：丈夫（与 linked_user_id 绑定的一致）。'
      : rLinked === '妻子' || rLinked === '老婆' || rLinked === '太太'
        ? '**当前发言用户家庭成员 role**：妻子（与 linked_user_id 绑定的一致）。'
        : rLinked
          ? `**当前发言用户家庭成员 role**：${rLinked}（非标准「丈夫/妻子」时，下表「丈夫/妻子」规则取最接近一侧保守处理）。`
          : '**当前发言用户家庭成员 role**：未关联或未知（下表「丈夫/妻子」规则无法唯一定锚时，unknown_member_detected 宁可填称谓追问，勿跨视角硬套成员）。';
  return `判断规则：
- cancel_reminder=true：用户明确要求**关掉/去掉**某条**未完成提醒**；动词可能是：取消、删掉、删除、撤销、去掉、撤掉、关闭、停掉、移除、解除、别提醒、不用提醒、不要再提醒等近义说法；包括只说「取消水费」「去掉油烟机清洁」等**未出现「提醒」二字**的短句；不是取消订单/取消关注/取消订阅
- cancel_reminder=false：用户说「不想取消」「别取消提醒」、或完全未涉及取消提醒
- cancel_reminder_keywords：从用户话里抽出最短匹配词，用于和提醒标题比对；「取消交水费的提醒」→「水费」或「交水费」；「取消油烟机清洁」→「油烟机清洁」
- intent=chat：闲聊、情绪倾诉、夫妻关系矛盾、不需要记录的日常对话
- intent=query：用户在问历史信息、查资料、问近期待办
- intent=record：用户在陈述一件值得记录的家庭事件
- has_record_value=false：日常琐事（一日三餐、买菜、加油、停车、买东西）、夫妻私密对话、情绪表达
- write_finance=true：用户明确表达了**人民币收支事实**（含具体金额或「几百块」等可记账表述），如买菜花了13元、发工资1500、转账、缴费、红包收付、看病自费等；**即使** has_record_value=false（日常买菜）也应为 true
- write_finance=false：纯问句（「买菜一般多少钱」）、无金额且无收支事实、仅身高体重无金额、否定句（没买/没发）
- missing_key_info：只写最关键的一个缺失点；常规中文追问不超过15字（固定问句「每周几？」等除外）；不要问多个问题
- **金额处理规则**（与 **write_finance** 配合；**费用、价格**在其它语境下仍按本条区分「计划消费」与「已消费记账」）：
  - 用户说的是**要花/准备买/打算买/要买/得买**等**未来或计划**消费 → **不追问金额**，missing_key_info 不要仅因缺金额而填写；按待办 / needs_reminder 等原规则处理
  - 用户说的是**刚花了/买了/付了/花了一笔/刚付的**等**已完成消费**口径且 **write_finance=true**，但**未说具体金额或「几百块」类可记账数量** → missing_key_info 填 **「花了多少？」**；**必须追问**，不得用旧规则把金额当成「永不缺失」而留空
  - 用户明确说**不记金额/不用记钱/就记一下不用金额**等 → 可以不追问金额（missing_key_info 追问其它缺失或留空）
- missing_key_info：**身高、体重**在分类层仍不算缺失；**人物缺失**用中文追问
- **【健康记录内容缺失规则】** 用户提到**身体情况/身体状态/最近身体/健康情况/检查结果**等、明显是在记健康相关，但话里**没有任何**具体症状、诊断结论、检查项目名称、化验或影像**数值**、用药/疫苗/手术/就医事实等**可落库的实质内容**时：
  - **has_record_value 必须为 false**（无内容即无记录价值，**禁止**当成「已有一条可记的健康事件」）
  - **missing_key_info** 填 **「哪里不舒服，还是有检查结果？」**
  - **intent** 仍为 **record**；**不得**在后续流程仅凭空泛表述落库「只有标题、无实质描述」的空壳健康记录（与抽取层「健康事件禁止空壳」一致）
- **【missing_key_info 优先级规则——内容缺失优先于时间缺失】**（**健康空壳**已见上条；以下为**情绪/近况**等）用户明显在描述要记的**状态或情况**，但未说清**具体内容**时，missing_key_info **只追问内容**，**不要**因没有具体日期或时间笼统而把 missing_key_info 填成小写 **date**：
  - 话里涉及**心情/情绪/状态**（指心境、情绪，非业务里的「提醒状态」），但**没有**具体情绪或事件描述 → missing_key_info 填 **「怎么了？」**
  - **最近怎么样/最近如何/近况如何/最近情况**等笼统说法，但**没有**可记录的具体事实（无事件、无数值、无明确动态） → missing_key_info 填 **「能说说具体情况吗？」**
  - 以上情形**优先于**后文「模糊时间 → date」：凡命中本条且仍缺具体可记内容时，**即使**同时出现「下周」「过几天」「最近」「近期」等笼统时间词，也**不得**将 missing_key_info 设为 **date**，除非用户已说清楚要记何事、仅缺公历日锚点。
- **时间信息处理规则**（与抽取层默认「无钟点」策略配合，JSON **无 remind_at 字段**，由后续流程落库）：
  1）用户说了**具体时刻**（几时、几点、上午/下午/晚上+钟点、今晚八点等）→ needs_reminder 视语境为 true 时保持 true；**missing_key_info 必须为空**（不要因「缺别的」而填 time）。
  2）用户说了**具体日历日**但**没说几点**：若锚定日是**今天**→ 系统在落库时用**本条消息发送时刻**作为默认提醒时刻，**禁止**对「今天」自动补 07:00；若锚定日是**明天或更远的未来**→ 系统落库时默认该公历日 **07:00（北京时间）**。**missing_key_info 必须为空**，不在此追问钟点。
  3）**【模糊时间 → missing_key_info 必须填 date 的完整触发列表】** 以下情况**无法唯一确定具体公历日**，missing_key_info **必须填小写 date**，不得留空，不得自动补全日期：
  **月内模糊**：「月初」「月头」「这个月初」；「月中」「月中旬」「中旬」「月中左右」；「月底」「月末」「这个月底」「下个月底」「月尾」。
  **年内模糊**：「年初」「年头」「开年」；「年中」「上半年末」「下半年初」「年中左右」；「年底」「年末」「岁末」「年终」「今年底」「明年底」；「X月中旬」「X月上旬」「X月下旬」（有月份但无具体日）；「X月初」「X月底」「X月末」。
  **其他模糊表达**：「周末」「这个周末」「下个周末」「本周末」「周末两天」等——指双休日但**未说周六还是周日哪一天**，**无法唯一确定公历日**（两天择一不可由系统代定），missing_key_info **必须填小写 date**；「下周」「下下周」「下个星期」（**无**具体周几）；「过几天」「几天后」「不久」「最近」「近期」；「假期」「节假日」「放假期间」「五一」「国庆」「春节」等节日笼统说法（无具体日）；「某天」「哪天」「找个时间」「有空的时候」。（**例外**：整句或主句为「最近怎么样」「最近情况」等且缺可记内容时，以**上文「内容缺失优先」**为准，**不填 date**。）
  （**注意**：「每周」但未说周几、「每两周/隔周/双周」未说周几、「每月」但未说几号 → **不要填 date**，见下条 5）的固定中文问句。）
  4）**【不触发追问的明确时间】** 以下已能确定公历日，**missing_key_info 必须留空**：今天、明天、后天、大后天；周一到周日（本周明确某天）；下周一/下周三等（有具体周几）；X月X日/X号、YYYY年X月X日；「每周X」（有具体周几）；「每月X号」（有具体几号）。
  5）**【周期性缺周几 / 缺几号 → 固定中文问句，不得填 date】**（追问的是**重复规则**不是公历某一天）  
  - 「每周」「每周都要」等但未说周几（「每周一」「每周三」算明确）→ missing_key_info 填 **「每周几？」**  
  - 「每两周」「隔周」「双周」但未说周几 → missing_key_info 填 **「每周几？」**  
  - 「每月」「每个月」但未说几号（「每月15号」算明确）→ missing_key_info 填 **「每月几号？」**
- 用户提到**月供/房贷/按揭**但未说**每月几号还款**（如「15号还」「每月10号」）→ missing_key_info 填「每月几号还款？」；intent=record
- **数字平台付费**：用户明显在谈**任一软件/网站/App/小程序**的**会员、订阅、续订、会员费、自动续费、连续包月/包年**等（**不必**出现具体平台名，如「听歌的会员」「剪辑软件要续费」也算）→ event_type 倾向 finance，needs_reminder=true；未说**按月还是按年** → missing_key_info 填「按月还是按年订阅？」；intent=record
- 用户已说**按年/按月**（本条或近期对话）且语境为**上述数字订阅/会员续费**，但**尚未确认或说出续费/扣款的具体日期**（未说几月几日、每月几号、「就今天」等）→ missing_key_info 填一句追问续费/扣款日期（系统可能已生成带「今天」日期的问法）；intent=record；**禁止**在此时编造具体续费日
- **【转发通知/公告的处理】** 用户转发**群通知、学校通知、物业通知**等整段文本时，无论是**自愿**还是**强制**口径：
  - **intent=record**，**needs_reminder=true**
  - **missing_key_info 必须为空**，**禁止**追问是否参加、是否去、是否报名
  - 由下游**抽取**自动识别时间节点并生成提醒；分类层不因通知文体额外追问
- related_member 判断规则：1）用户明确说了人名或关系词（老刘、我老公、孩子他爸等）→ related_member 填被指代的人，在家庭成员列表中则用与列表一致的**姓名**。2）用户说「我」或句子里没有出现任何人名或可归因他人的指代 → related_member **必须**填：**${rel}**（该行若为「暂无」则 related_member 为空字符串）。3）**禁止**在用户未提及任何人名或指代时，自动填写**其他**家庭成员
- event_type：health优先于finance，就医/体检/用药/疫苗/手术统一归health，即使涉及费用；child优先于health，孩子的身高体重/成长记录统一归child；plant_pet仅限于明确是宠物或植物的事件，如果related_member是家庭成员列表里的人，绝对不能归plant_pet
- needs_reminder=true：就医复诊、疫苗、保险到期、证件续签、兴趣班缴费、生日纪念日等；**另含**「今天/明天/后天/这周 + 可确定日期锚 + 活动」且无已完成口径时，与上条时间规则 1）2）配合（无钟点不追问，missing_key 留空）
- needs_reminder=true且用户说「每周/每天/每月」等周期性关键词时，has_record_value=true，intent=record
- needs_deep_reasoning=true：仅当用户**明确要求**深度分析、建议、权衡或规划时，如「帮我分析」「给我建议」「怎么办」「该怎么选」「有什么影响」「多角度想想」等
- needs_deep_reasoning=false：陈述事实、闲聊、情绪倾诉、随口提问、**仅补充槽位**（如单独回复「按月」「按年」「每月15号」）、确认语「好的」「嗯嗯」等；**即使**话题涉及健康或育儿，只要没有上述深度诉求，一律 false
- **【亲属称谓处理——最高优先级规则】** ${currentUserRoleLine}
- **【亲属称谓 → 成员列表 role 对应关系（新体系）】** 成员串中括号内为视角说明，**判定仍以 role 字段（及旧库爷爷/奶奶/外公/外婆）为准**，勿仅靠名字猜测。
  - **当前用户是丈夫时**：
    - 「我爸」「我父亲」「我爷爷」→ 对应 role=「丈夫父亲」（旧值可能是「爷爷」）
    - 「我妈」「我母亲」「我奶奶」→ 对应 role=「丈夫母亲」（旧值可能是「奶奶」）
    - 「我外公」「我姥爷」→ **列表中无对应**（外公属妻子之父，role=「妻子父亲」，**不是**丈夫口语里的「我外公」）→ **unknown_member_detected** 填「外公」或「姥爷」等，**禁止**把丈夫说的外公匹配到某位「妻子父亲」成员
    - 「我外婆」「我姥姥」→ **同上**，unknown_member_detected，**禁止**匹配「妻子母亲」
  - **当前用户是妻子时**：
    - 「我爸」「我父亲」「我外公」「我姥爷」→ 对应 role=「妻子父亲」（旧「外公」）
    - 「我妈」「我母亲」「我外婆」「我姥姥」→ 对应 role=「妻子母亲」（旧「外婆」）
    - 「我爷爷」→ **无对应**（爷爷属丈夫之父系，role=「丈夫父亲」）→ unknown_member_detected，**禁止**匹配「丈夫父亲」成员
    - 「我奶奶」→ **无对应** → unknown_member_detected，**禁止**匹配「丈夫母亲」
  - **绝对禁止**：丈夫说「我外公」却匹配到某位 role=「妻子父亲」的成员；妻子说「我爷爷」却匹配到「丈夫父亲」；任何人说「我妈」却**未按当前用户是丈夫/妻子**区分而误把「丈夫母亲」与「妻子母亲」混用——必须按上表与当前用户 role 判定，不得仅因列表里有一个「妈妈」角色就挂靠。
  - 当用户说「我妈」「我爸」等但**无法**从上下文与家庭成员串确定应采用丈夫侧还是妻子侧母亲/父亲时：宁可 **unknown_member_detected** 填规范称谓或使用 missing_key_info **一句**澄清，**禁止**直接 related_member 指向错误一方的成员。
  - 「我兄弟」「我姐姐」等：按列表姓名与 role 匹配；无表项时再走 unknown_member_detected。
- unknown_member_detected：仅当用户提到**可能是家人**且该名字不在家庭成员列表中时填写；**明显职场/公务敬称**（如「王总」「李局长」「张科长」「赵处长」「厅长」「部长」「主任」「经理」「总监」等以职务结尾的称呼）一律填空字符串，不要当作家庭成员；同一用户若只是在说工作往来对象，也不要填
- 用户用「宝宝」「宝贝」「小宝」等指代自家幼儿，而家庭成员列表中**无任何条目的姓名**与之相同或为之昵称时：**必须**把该指代填入 unknown_member_detected（勿仅写在 related_member 而漏掉本字段，否则客户端无法询问是否添加成员）`;
}

function mergeParsedIntentPayload(parsed: Record<string, unknown>): IntentResult {
  const defaultResult = intentClassifierDefaultResult();
  if (parsed.query_type === 'null') parsed.query_type = null;
  const merged = { ...defaultResult, ...parsed } as IntentResult;
  merged.cancel_reminder = merged.cancel_reminder === true;
  merged.cancel_reminder_keywords =
    typeof merged.cancel_reminder_keywords === 'string' ? merged.cancel_reminder_keywords : '';
  if (typeof merged.missing_key_info === 'string') {
    merged.missing_key_info = sanitizeClassifierMissingKeyInfoToChinese(merged.missing_key_info);
  }
  return merged;
}

/** 合并调用：从顶层 { intent, extract } 或兼容的扁平分类 JSON 中取出意图字段对象 */
function tryParseIntentObjectFromCombinedResponse(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const inn = parsed.intent;
  if (inn && typeof inn === 'object' && !Array.isArray(inn)) {
    return inn as Record<string, unknown>;
  }
  if (typeof inn === 'string' && ['chat', 'query', 'record'].includes(inn)) {
    const flat = { ...parsed } as Record<string, unknown>;
    delete flat.extract;
    return flat;
  }
  return null;
}

function buildClassifyAndExtractMergedJsonSchemaBlock(shouldExtract: boolean): string {
  const intentFields = `"intent": "chat或query或record",
    "query_type": "time或document或history或status或null",
    "has_record_value": true或false,
    "missing_key_info": "与分类器说明一致",
    "related_member": "相关成员姓名",
    "event_type": "health或child或finance或vehicle或house或relationship或admin或plant_pet或daily",
    "needs_reminder": true或false,
    "needs_deep_reasoning": true或false,
    "unknown_member_detected": "检测到的未知成员名字，无则为空字符串",
    "write_finance": true或false,
    "cancel_reminder": true或false,
    "cancel_reminder_keywords": "要取消的提醒匹配词"`;
  const extractRule = shouldExtract
    ? `顶层必须同时包含 "intent" 与 "extract"。当 intent.intent 不是 "record"，或 intent.has_record_value 与 intent.needs_reminder 均为 false 时，"extract" 必须为 null。仅当 intent.intent 为 "record" 且（has_record_value===true 或 needs_reminder===true）时，"extract" 为对象：结构与抽取器一致（events / reminders / finance_transactions）；否则 "extract" 为 null。`
    : `【系统约定】本轮由调用方关闭结构化抽取：顶层 "extract" 必须为 null。`;
  return `严格按以下JSON格式输出，不要输出任何其他内容：
{
  "intent": {
    ${intentFields}
  },
  "extract": null
}
${extractRule}`;
}

function buildExtractStructuredPromptBody(params: {
  userMessage: string;
  familyMembers: string;
  currentUserMember: string;
  recentHistory: string;
  todayStr: string;
  weekDates: string;
  contextAppendix: string;
}): string {
  const {
    userMessage,
    familyMembers,
    currentUserMember,
    recentHistory,
    todayStr,
    weekDates,
    contextAppendix,
  } = params;
  return `你是家庭信息提取器，专门从用户输入里提取结构化信息。

今天是北京时间 ${todayStr}，本周日期：${weekDates}
家庭成员：${familyMembers || '暂无'}
当前发言用户的家庭成员身份：${currentUserMember?.trim() || '暂无'}
近期对话：${recentHistory || '暂无'}

用户说：「${userMessage}」

请提取所有信息点，严格按以下JSON格式输出，不要输出任何其他内容：
{
  "events": [
    {
      "id": "e1",
      "title": "简短事件标题",
      "description": "详细描述，包含所有相关信息",
      "event_type": "health或child或finance或vehicle或house或relationship或admin或plant_pet或daily",
      "related_member": "人名或宠物名；人物事项时按规则默认填当前发言用户姓名，禁止未提及时填列表中他人",
      "is_person": true或false（是否是家庭成员列表里的人）,
      "date_type": "once或weekly或daily或monthly或yearly",
      "event_date": "once：YYYY-MM-DD 或上海时区 ISO（含钟点）。无钟点时：锚定日为**今天**则只须 YYYY-MM-DD（或 ISO 日期部分），勿自拟 07:00；锚定日为**明天及更远未来**则须该日 07:00:00+08:00；weekly/daily/monthly/yearly 为 null",
      "recurring_days": [1,2,3]或null（weekly时填周几数组，1=周一...7=周日）,
      "height": 数字或null（单位cm，斤自动转kg，1米1转110）,
      "weight": 数字或null（单位kg，斤÷2）,
      "amount": 数字或0,
      "is_milestone": true或false,
      "needs_reminder": true或false,
      "is_negative": true或false（否定句如「没去」「推迟了」）,
      "is_uncertain": true或false（条件句如「如果...就」「可能」）,
      "group_id": "同一件事的多条记录用相同group_id，如接送安排的多条用g1"
    }
  ],
  "reminders": [
    {
      "event_id": "e1",
      "title": "提醒标题",
      "date_type": "once或weekly或daily或monthly或yearly",
      "event_date": "YYYY-MM-DD 或 ISO。**今天**且用户未说几点：YYYY-MM-DD 即可，勿写 07:00；**明天及更远**且未说几点：该日 07:00:00+08:00；或 null",
      "recurring_days": [1,2,3]或null,
      "remind_before_days": 0,
      "remind_before_minutes": 数字或null（仅当用户明确「提前X分钟/小时」填写；否则null=默认15分钟）
    }
  ],
  "finance_transactions": [
    {
      "title": "简短主题，如买菜、工资到账",
      "description": "补充说明，可空字符串",
      "amount": 数字且大于0,
      "direction": "income或expense",
      "category": "health或child或finance或vehicle或house或relationship或admin或plant_pet或daily",
      "occurred_date": "YYYY-MM-DD或null（null则用今天）"
    }
  ],
  "missing_key_info": "字符串；与意图一致：缺具体公历日且无法从用户话落定日期时填小写 date，否则空字符串；勿再使用 time"
}

提取规则：
- 每个独立的时间点/事件单独一条event，如「去年102cm现在110cm」提取2条
- 同一件事（如接送安排）的多条event共享同一个group_id；**快递/驿站多个取件码、多条到货短信**属于多件独立事，**不得**共用 group_id（见文末产品规则）
- is_person：只要叙述的是「人」或其健康/财务/行为（含亲属称谓如嫂子、我爸，即使用户未在列表中写全名、related_member 可依下条默认），一律为 true；**仅当明确是宠物、植物、物品**时为 false
- related_member 判断优先级：1）用户明确说了家庭成员姓名、具体称谓或「我老公」「老刘」等可指向某一人的表述 → related_member 填该人在**家庭成员列表**中的**姓名**（与列表「名字」字段一致）。2）用户说「我」或整句未出现任何他人姓名/可分辨指代 → related_member **必须**填**当前发言用户的家庭成员身份**一行中的**姓名部分**（即提示中的 currentUserMember，如「肖珺（妻子）」则填肖珺）；人物相关的日程/健康事项不得将 related_member 留空。3）**禁止**在用户未提及任何人名或指代时，将 related_member 擅自填成家庭成员列表里的**其他**人
- event_type：**禁止**把人的健康、还款、理发等标成 plant_pet。is_person=false 且明确猫狗/盆栽等时用 plant_pet；人物健康用 health；还款月供订阅用 finance；剪发等用 daily；亲属家事无医疗可用 relationship。分类优先级：child > finance > health > 其余
- **【健康事件·禁止空壳】** event_type 为 health 时：description **不得**为空或仅重复 title（与 title 无信息增量的同义复述视为违规）。若用户原文**没有**任何症状、诊断、数值、检查项目、用药/就医/疫苗等可写入事实，则 **events 必须返回空数组 []**，**不生成**空壳健康记录；**禁止**为凑 JSON 编造症状或充数标题。
- 否定句（没去、推迟、取消）：is_negative=true，needs_reminder=false
- 条件句（如果、可能、也许）：is_uncertain=true，needs_reminder=false
- 模糊时间换算：仅在**用户话已能确定公历日**时换算（如「上周四」「前天」→ 具体 YYYY-MM-DD）。若用户只说「下周」「月底」等仍无法唯一确定日期的，**不得**为凑 JSON 而编造日期；此时须令 JSON 顶层 **missing_key_info 为小写 date**（与意图层一致），events/reminders 对相关待办勿填虚假 event_date
- 单位换算：斤÷2=kg（保留两位小数，例如24.5斤=12.25kg，绝对不要随意四舍五入成0.5的倍数），1米1=110cm，3岁半不是身高体重忽略
- 纯闲聊情绪无需提取，events返回空数组
- **全家可见**：每条 event 的 title、description 会写入家庭记录，**所有家庭成员**都会看到。**禁止**在 title/description 里用「我、我的、我妈、我爸、我妈妈」等第一人称指代家人；须改写为家庭成员列表中的**具体姓名**（与列表「名字」字段一致），例如用户说「我妈妈高血压」→ title 写「张丽华体检血压偏高」类（张丽华为列表中该母亲条目的姓名）。related_member 填该**同一姓名**；若默认主语为当前用户本人，则用**当前发言用户的家庭成员身份**中的姓名替换「我」
- 【remind_at 默认值·必须与代码落库一致】用户原话**无具体钟点/相对分钟**（反面见下条「用户已说时刻」）时：① 锚定公历日为**今天** → reminders 侧用**对话发送时刻**（模型勿臆造钟点，event 可只给 YYYY-MM-DD）；② 锚定日为**明天或更远** → **当日 07:00:00（Asia/Shanghai）**。**绝对禁止**对「今天」自动补 07:00；**禁止**自拟 08:00/09:00 等凑数钟点；**remind_before_minutes** 仍仅在实际提前量时出现（见下）
- 【用户已说时刻】用户**明确**钟点或相对分钟（几点、上午/下午/晚上+钟点、今晚八点、「N分钟后」等）时，event_date / 事项时刻按用户时间输出（可含 +08:00）
- 【钟点默认·事项日】无用户时刻时：锚定**今天** → event 与 reminder 的**日期**对齐今天，**勿**把时刻写成 07:00（由系统落库写「现在」）；锚定**明天及更远** → 该日 **07:00:00 +08:00**
- needs_reminder=true的场景：复诊、疫苗、缴费、证件、生日、周期性安排等；**另含**「今天/明天/后天/这周 + 可确定日期 + 活动」类待办（无钟点则按上条「今天=发送时刻 / 远期=07:00」，missing_key_info 留空）
- **【通知/公告类·总述】** 转发类群/校/物业通知若**同时**含**截止**与**活动**两段时间信息，须按文末 **「强制双提醒示例」** 输出（与该条冲突时以文末为准；**禁止**只出一条 reminder）
- 只有两种情况可以标记为周期性date_type（weekly/daily/monthly/yearly）：
  1）用户明确说了「每月/每个月/按月/每周/每天/每年/每一年」等周期词
  2）即使用户没说周期，但属于高确定性的常识场景：
     - 房贷/房屋按揭/房贷月供、车贷/车贷月供 => date_type=monthly
     - 信用卡账单日/还款日 => date_type=monthly
     - 保险保费/保险缴费/保险年费/续保/续费（明确是每年缴一次的）=> date_type=yearly
- 车位费、物业费、水电燃气等如果用户没说「每月/每年」，一律按once处理，不要自动标记为周期性提醒
- 【将来/待办缴费】用户用「要交」「准备去交」「还没交」「得交」「该交了」「记得交」「我要交」等表达**尚未完成**的缴费、付款、买东西：必须输出 events（amount 填数字）+ reminders，**finance_transactions 必须为空数组 []**（系统会在用户点「完成」后再记支出）
- 【已完成消费】用「交了」「付了」「买了」「刚交」「已经交」等完成体，或明确过去已发生：输出 finance_transactions；无需提醒时 reminders 可空
- finance_transactions：**已发生**的人民币收支（元/块/钱与数字）须输出；**收入** direction=income：工资、奖金、到账、收款、红包收到、退款入账等；**支出** direction=expense：买、花、付、缴费、转账给他人、看病自费等（待办缴费见上条，不要输出）
- 就医若提到自费金额：category=health，direction=expense
- 买菜/日用品/加油等日常消费：category=daily 或 vehicle（加油）
- 仅记录身高体重且无金额：finance_transactions 为空数组 []
- 用户只说日常琐事但明确金额且为**已完成**消费（今天买菜13元）：events 可为空，finance_transactions 仍要输出
- 若 events 中 event.amount>0 且**同一件事**已在 reminders 里（待办缴费），不要输出 finance_transactions；若仅有已完成的 event 记录而无待办提醒，则必须输出 finance_transactions，金额与 event.amount 一致
- 提醒 remind_before_days：**到点闹钟/「X点叫我」类**（如「9点提醒我浇花」）填 **0**，表示在事项日当天该时刻提醒，不要减日期
- remind_before_minutes：仅当用户**明确**说了「提前10分钟」「前半小时叫我」等才填；**未提及则必须 null**。**禁止**在未说提前量时虚构提前分钟；无用户时刻时 remind_at 规则见上条（今天=发送时刻；远期=07:00），勿再靠提前量「倒推」成其它钟点
- **提前若干自然日提醒**（如「提前一天提醒我去复诊」）填 **1、2、3** 等；有明确 event_date 时，系统会在事项日前第 N 天的同一钟点生成 remind_at（与「提前 X 分钟」可同时存在时使用自然日优先于分钟提前量）
- **【截止类提醒】**（报名截止、缴费截止、材料提交截止、打卡截止等）：**remind_before_days** 一般为 **1**（截止日前一日提醒）。结合「今天是 ${todayStr}」：若截止日为**今天或明天**，**remind_before_days 填 0**（当天提醒）。**截止类**的 **event_date / 解析钟点**必须以**截止时刻**为准，**禁止**用主活动/会议日的默认 07:00 或其它主事件时间**替代**报名/缴费截止这一刻
- **【活动类提醒】**（参加聚会、赴约、参会、亲子活动等需**到场**的情形）：**remind_before_days 填 1**（相对**主活动日所在公历日**提前一个自然日提醒）。**宜**在对应 **reminder 的 title 或 description**（或与主 event 合并解析的文案）中写明 **20点/晚上8点/晚8点** 等，便于系统解析为**前一日 20:00** 触达（比默认早间触达更符合「前一晚想起来」的习惯）；主活动 **event** 的 **event_date** 仍遵守上文无钟点规则；**勿**与截止类提醒混用同一时刻逻辑
- 用户只说「明天/后天/大后天 X点」要换算出对应 event_date（YYYY-MM-DD），remind_before_days 一般为 0
- 无具体日期仅有「X点」且为今天已过钟点则语义上指明天同一钟点，请在 event_date 或上下文里体现「次日」日期
- 「X点Y分」或「X点Y」（省略「分」，如12点20）必须保留分钟；对应提醒 date_type=once、remind_before_days=0，不要写成每天
- 「N分钟后」「再过N分钟」「半小时后」等相对此刻的短时提醒：needs_reminder 必须为 true，须输出对应 reminders（date_type=once，remind_before_minutes=null）；**event.title 或 event.description 中须保留用户原文里的相对时间短语**（例如「5分钟后泡脚」），禁止改为臆造的具体钟点；系统据此计算 remind_at
- 用户**未出现**「每天/每日/天天」时，禁止把单次闹钟标成 date_type=daily（吃饭、浇花等一次性提醒一律 once）
- **【通知/公告类——强制双提醒示例】** 先看输入输出形态，再套其它转发通知（公历**年份**按「今天是 ${todayStr}」并入**当年**；下例演示写 **2026**）
  **输入**：「4月6日9:00科普活动，4月2日16:00前报名截止」
  **必须输出**：**恰好 1 条 event**（主活动）+ **恰好 2 条 reminders**。**禁止**只输出 1 条 reminder。**两条 reminders 的 event_id 必须相同**，且**都**指向这条主 **event** 的 id。
  **标题格式（两条 reminders 的 title 均遵守；触发当日用户看标题时不应出现歧义）**：
  - **截止提醒 title**：**「{活动名称}报名截止提醒」**（活动名称为通知里主活动简称，勿冗长）。示例：**「幼儿园歌舞剧表演报名截止提醒」**
  - **活动提醒 title**：**「{活动名称}」**（与主 **event.title** 一致即可）。示例：**「幼儿园歌舞剧表演」**
  - **禁止**在任一 **reminders.title** 中使用 **「今天」「明天」「后天」「今早」「明早」「明晚」「今夜」** 等**相对时间词**（到点时往往已是那一天，写「今天」会误导用户）
  **对应填写（与落库节拍一致；JSON 无 remind_at 字段时，用 reminders.event_date 写带钟点的 ISO）**：
  - **reminders[0]**（截止前）：**event_date** = \`2026-04-02T14:00:00+08:00\` → 等价触达 **remind_at** ≈ **2026-04-02T14:00:00+08:00**（**截止当天**；用户截止 **16:00** → **提前 2 小时** → **14:00**）；**remind_before_days=0**；**title** 如「幼儿园科技馆科普活动报名截止提醒」（须符合上款格式，**勿**写「今天截止」）
  - **reminders[1]**（活动前一晚）：主活动日为 **4月6日** → **event** 的 **event_date** 须为 **2026-04-06**（含 **09:00** 则写 **2026-04-06T09:00:00+08:00**）；本条 **reminder** 的 **event_date** 以**主活动日**为锚、**remind_before_days=1**；**title** 仅写活动名如「幼儿园科技馆科普活动」；须在 **description** 中写 **「20点」「晚上8点」** 等供解析，使落库等价 **remind_at** ≈ **2026-04-05T20:00:00+08:00**（**勿**在 title 里写「明天」）
  - **event**：title/description 写清活动全称；通知中的**班级**（中班/大班等）、**地点**（幼儿园/科技馆等）**必须**进 **description**
  **规则（通知类·强制）**：
  - 凡通知里**同时**出现**截止时间**与**活动时间**，**必须** **2 条 reminders**
  - **截止提醒**：用**截止日当天**；若截止有具体时刻（如 16:00），则提醒时刻为 **该时刻减 2 小时**（如 14:00）；无具体钟点则 event_date 可只给 **YYYY-MM-DD**
  - **活动提醒**：**活动日前一晚 20:00**；**remind_before_days=1**；**20点/晚上8点**写在 **description**，**title** 仅用**活动名称**句式
  - **禁止**只输出一条 reminder
${EXTRACT_PROMPT_PRODUCT_APPENDIX}
${contextAppendix}`;
}

/** 校验合并响应中 extract 对象是否具备与 extractEvents 一致的最小结构 */
function isValidCombinedExtractShape(ex: unknown): ex is ExtractResult {
  if (!ex || typeof ex !== 'object' || Array.isArray(ex)) return false;
  const o = ex as Record<string, unknown>;
  return (
    Array.isArray(o.events) &&
    Array.isArray(o.reminders) &&
    Array.isArray(o.finance_transactions)
  );
}

type ClassifyAndExtractResult = {
  intent: IntentResult;
  extract: ExtractResult | null;
};

const classifyAndExtract = async (
  userMessage: string,
  recentHistory: string,
  familyMembers: string,
  currentUserMemberName: string,
  todayStr: string,
  weekDates: string,
  shouldExtract: boolean,
  apiKey: string,
  options?: {
    auxiliaryAccount?: boolean;
    extractAppendix?: string;
    /** 与 extractEvents 的「当前发言用户的家庭成员身份」一行一致，通常由 formatCurrentUserMemberForExtract 生成 */
    currentUserMemberForExtract?: string;
    /** linked_user_id 对应行的 family_members.role，供分类器亲属规则定锚 */
    currentUserLinkedRoleForClassifier?: string | null;
  }
): Promise<ClassifyAndExtractResult | null> => {
  const auxiliaryBlock = buildIntentClassifierAuxiliaryBlock(options?.auxiliaryAccount === true);
  const preamble = buildIntentClassifierPreamble({
    userMessage,
    recentHistory,
    familyMembers,
    currentUserMemberName,
    todayStr,
    weekDates,
    auxiliaryBlock,
  });
  const mergedSchema = buildClassifyAndExtractMergedJsonSchemaBlock(shouldExtract);
  const judgment = buildIntentClassifierJudgmentRulesBlock(
    currentUserMemberName,
    options?.currentUserLinkedRoleForClassifier
  );
  const extractAppendix = options?.extractAppendix ?? '';
  const currentUserMemberLine =
    (options?.currentUserMemberForExtract || '').trim() ||
    (currentUserMemberName || '').trim() ||
    '暂无';
  const secondStep =
    shouldExtract ?
      `

【第二步·仅当 intent.intent 为 "record" 且 (has_record_value===true 或 needs_reminder===true) 时执行】
在同一 JSON 响应里填写 "extract" 字段（不要重复输出 intent）。以下整段为抽取器说明与规则；若条件不满足，"extract" 必须为 null。

${buildExtractStructuredPromptBody({
  userMessage,
  familyMembers,
  currentUserMember: currentUserMemberLine,
  recentHistory,
  todayStr,
  weekDates,
  contextAppendix: extractAppendix,
})}`
    : '';

  const prompt = `${preamble}

${mergedSchema}

${judgment}${secondStep}`;

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 1200,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error('classifyAndExtract HTTP:', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const intentObj = tryParseIntentObjectFromCombinedResponse(parsed);
    if (!intentObj) return null;
    const intent = mergeParsedIntentPayload(intentObj);
    let extract: ExtractResult | null = null;
    if (shouldExtract) {
      const rawEx = parsed.extract;
      if (rawEx === null || rawEx === undefined) {
        extract = null;
      } else if (isValidCombinedExtractShape(rawEx)) {
        const raw: ExtractResult = {
          events: rawEx.events || [],
          reminders: rawEx.reminders || [],
          finance_transactions: Array.isArray(rawEx.finance_transactions) ? rawEx.finance_transactions : [],
          ...(typeof rawEx.missing_key_info === 'string' ? { missing_key_info: rawEx.missing_key_info } : {}),
        };
        extract = sanitizeExtractForProductRules(userMessage, raw);
      } else {
        extract = null;
      }
    }
    return { intent, extract };
  } catch (e) {
    console.error('classifyAndExtract 失败:', e);
    return null;
  }
};

const classifyIntent = async (
  userMessage: string,
  recentHistory: string,
  familyMembers: string = '',
  apiKey: string,
  options?: {
    auxiliaryAccount?: boolean;
    currentUserMemberName?: string;
    currentUserLinkedRole?: string | null;
  }
): Promise<IntentResult> => {
  const defaultResult = intentClassifierDefaultResult();

  try {
    const nowForClassify = new Date();
    const todayForClassify = nowForClassify.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const weekDatesForClassify = weekDatesLineForPromptShanghai(nowForClassify);

    const auxiliaryBlock = buildIntentClassifierAuxiliaryBlock(options?.auxiliaryAccount === true);
    const currentUserMemberName = (options?.currentUserMemberName || '').trim() || '暂无';

    const prompt = `${buildIntentClassifierPreamble({
      userMessage,
      recentHistory,
      familyMembers,
      currentUserMemberName,
      todayStr: todayForClassify,
      weekDates: weekDatesForClassify,
      auxiliaryBlock,
    })}

${buildIntentClassifierFlatJsonSchemaBlock()}

${buildIntentClassifierJudgmentRulesBlock(currentUserMemberName, options?.currentUserLinkedRole)}`;

    /** 意图分类固定轻量模型，不使用 reasoner */
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat', max_tokens: 320, temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      return mergeParsedIntentPayload(parsed);
    }
  } catch (e) {
    console.error('意图分类失败:', e);
  }
  return defaultResult;
};

/** 从 DB 读出的 content 转成用于分类/上下文的纯文本（与列表里 JSON 消息一致） */
function flatMessageContentForClassifier(raw: string): string {
  if (raw == null || raw === '') return '';
  try {
    const p = JSON.parse(raw);
    if (p && p.__type === 'file' && typeof p.fileName === 'string') return p.fileName;
    if (p && p.__type === 'reminder_cancel_pick' && typeof p.intro === 'string') return p.intro;
  } catch {
    /* 普通文本 */
  }
  return String(raw).trim();
}

/**
 * 用户只回「按年/按月」等：只要助手上一轮问过周期（或上下文有订阅关键词），**强制**追问续费日。
 * 不依赖 messagesRef（setState 与 ref 同步间隙会丢上一轮 AI 话，导致误抽取）。
 */
function applySubscriptionCycleShortAnswerHardLock(
  intent: IntentResult,
  userText: string,
  recentMsgs: string
): IntentResult {
  if (intent.cancel_reminder) return intent;
  const t = userText.trim();
  if (!/^(按年|按月|包月|包年|月付|年付|月订阅|年订阅)(?:吧|的|啊|哦|呀)?$/i.test(t)) return intent;
  if (userHasSubscriptionRenewalAnchorInText(t)) return intent;
  const ctx = `${recentMsgs}\n用户：${userText}`;
  const assistantAsked = ASSISTANT_ASKED_SUBSCRIPTION_CYCLE_RE.test(recentMsgs);
  if (!assistantAsked && !DIGITAL_SUBSCRIPTION_CONTEXT_RE.test(ctx)) return intent;
  const today = getShanghaiYmd();
  const [, mo, d] = today.split('-').map(Number);
  const cnDate = `${mo}月${d}日`;
  const isYearly = /按年|包年|年付|年订阅/i.test(t);
  const q = isYearly
    ? `续费日是每年「${cnDate}」这天吗？若不是请说几月几日。`
    : `扣款日是每月「${d}号」吗？若不是请说每月几号。`;
  return {
    ...intent,
    intent: 'record',
    has_record_value: true,
    needs_reminder: true,
    missing_key_info: q,
    event_type: intent.event_type === 'daily' || intent.event_type === 'plant_pet' ? 'finance' : intent.event_type,
  };
}

/**
 * 分类器把重复叙述收成 chat 时，若文本仍像「日程/做客吃饭/提醒」，仍应用抽取结果做去重与口播。
 */
function heuristicProcessExtractedEventsForDedupe(intent: IntentResult, userText: string): boolean {
  if (intent.intent !== 'chat') return false;
  if (intent.cancel_reminder) return false;
  const t = userText.trim();
  if (t.length < 4) return false;
  if (/提醒|别忘了|记得叫|到点叫|设.{0,4}提醒|帮我订|闹钟/.test(t)) return true;
  if (/\d{1,2}\s*[点:：]\s*\d{0,2}|半点|今晚|今天中午|今天晚上|明早|后天|今个/.test(t)) return true;
  if (/去.+家|到.+家|做客|拜访|(吃|聚)(饭|餐)|聚餐|晚饭|午饭|请客|吃饭/.test(t)) return true;
  if (/(又|还|再|重复|刚才|之前说|说过|同一件|跟上次).{0,14}(吃|饭|提醒|去|约)/.test(t)) return true;
  if (/记一下|帮我记|记下来|记上|别忘了记/.test(t)) return true;
  return false;
}

/** 月供还款日、订阅周期等产品必填槽位（拍板） */
function applyIntentProductHeuristics(intent: IntentResult, userText: string): IntentResult {
  const t = userText.trim();
  const out = { ...intent };
  if (/(取消|删掉|删除|去掉|撤销).{0,16}提醒|提醒.{0,10}(取消|删掉|删除)|不要.{0,8}提醒|不用.{0,8}提醒/.test(t)) {
    return out;
  }
  const hasRepaymentDay =
    /\d{1,2}\s*[日号](?![点时分秒])|每月\s*\d{1,2}|每个月\s*\d{1,2}|还款\s*(?:日|是)?\s*\d{1,2}|\d{1,2}\s*号还|还贷.{0,8}\d|还(?:款)?\s*在\s*\d{1,2}|这天还|今天还|明天还|后天还/.test(
      t
    );
  if (/月供|房贷|按揭|房屋贷款|车贷月供|每月还贷/.test(t) && !hasRepaymentDay) {
    out.missing_key_info = '每月几号还款？';
    out.has_record_value = true;
    out.intent = 'record';
    out.event_type = 'finance';
  }
  const subCycle = /按月|包月|月付|每月扣|每月付|按年|包年|年付|每年扣|每年付|年订阅|月订阅/.test(t);
  if (DIGITAL_SUBSCRIPTION_CONTEXT_RE.test(t) && !subCycle) {
    if (!out.missing_key_info) {
      out.missing_key_info = '按月还是按年订阅？';
    }
    out.has_record_value = true;
    out.intent = 'record';
  }
  return out;
}

/**
 * 数字订阅：用户仅回「按年/按月」时常不带「订阅」等词；靠助手是否刚问过「按月/按年」或上下文关键词兜底，追问续费日。
 */
function applySubscriptionRenewalDayFollowUpHeuristic(
  intent: IntentResult,
  userText: string,
  recentMsgs: string
): IntentResult {
  if (intent.cancel_reminder) return intent;
  const t = userText.trim();
  const ctx = `${recentMsgs}\n用户：${userText}`;
  const assistantAskedCycle = ASSISTANT_ASKED_SUBSCRIPTION_CYCLE_RE.test(recentMsgs);
  const platformCue = DIGITAL_SUBSCRIPTION_CONTEXT_RE.test(ctx);
  if (!assistantAskedCycle && !platformCue) return intent;
  if (!/按年|按月|包月|包年|月付|年付|月订阅|年订阅/.test(t)) return intent;
  if (userHasSubscriptionRenewalAnchorInText(t)) return intent;
  if (t.length > 48 && !assistantAskedCycle) return intent;
  const today = getShanghaiYmd();
  const [, mo, d] = today.split('-').map(Number);
  const cnDate = `${mo}月${d}日`;
  const isYearly = /按年|包年|年付|每年扣|年订阅/.test(t);
  const q = isYearly
    ? `续费日是每年「${cnDate}」这天吗？若不是请说几月几日。`
    : `扣款日是每月「${d}号」吗？若不是请说每月几号。`;
  return {
    ...intent,
    intent: 'record',
    has_record_value: true,
    needs_reminder: true,
    missing_key_info: q,
    event_type: intent.event_type === 'daily' || intent.event_type === 'plant_pet' ? 'finance' : intent.event_type,
  };
}

/** 助手刚问过续费日，用户短句确认「就今天」等同义时放行抽取 */
function applySubscriptionRenewalConfirmHeuristic(
  intent: IntentResult,
  userText: string,
  recentMsgs: string
): IntentResult {
  const t = userText.trim();
  if (t.length > 28) return intent;
  if (!/^(对|是的|嗯嗯?|好(的)?|可以|没错|就这样|是这?天|就今天|跟今天一样|今天(就)?行|同上|ok)$/i.test(t)) {
    return intent;
  }
  const ctx = recentMsgs;
  if (!/续费日|扣款日|每年|每月|几月几日|每月几号|号吗|这天吗/.test(ctx)) return intent;
  if (!DIGITAL_SUBSCRIPTION_CONTEXT_RE.test(ctx) && !/按年|按月|包年|包月/.test(ctx)) return intent;
  return {
    ...intent,
    intent: 'record',
    has_record_value: true,
    missing_key_info: '',
    needs_reminder: true,
    event_type: intent.event_type === 'daily' || intent.event_type === 'plant_pet' ? 'finance' : intent.event_type,
  };
}

/**
 * 仅回复「15号」等还款日时：近期对话里已有月供/订阅语境则强制走记录+抽取，否则会话模型在瞎答而 DB 不更新。
 */
function applyRepaymentDayFollowUpHeuristic(
  intent: IntentResult,
  userText: string,
  recentMsgs: string
): IntentResult {
  if (intent.cancel_reminder) return intent;
  const t = userText.trim();
  if (/取消|删掉|删除|去掉|别提醒|不要提醒|不用提醒/.test(t)) return intent;
  if (t.length > 36) return intent;
  const dom = parseDayOfMonthFromChineseText(t);
  if (dom == null) return intent;
  const ctx = `${recentMsgs}\n用户：${userText}`.replace(/\s/g, '');
  if (
    !/月供|房贷|按揭|每月还|还款|扣费|月付|包月|年付|deepseek/i.test(ctx) &&
    !DIGITAL_SUBSCRIPTION_CONTEXT_RE.test(ctx)
  ) {
    return intent;
  }
  return {
    ...intent,
    intent: 'record',
    has_record_value: true,
    missing_key_info: '',
    needs_reminder: true,
    event_type:
      intent.event_type === 'daily' || intent.event_type === 'plant_pet' ? 'finance' : intent.event_type,
  };
}

/**
 * 多轮：上轮已追问消费品类/金额，本轮用户只补了品类（如「电风扇」）仍无金额时，兜底 write_finance + 追问金额。
 */
function applyFinanceAmountFollowUpHeuristic(
  intent: IntentResult,
  userText: string,
  recentMsgs: string
): IntentResult {
  if (intent.cancel_reminder) return intent;
  if ((intent.missing_key_info || '').trim()) return intent;

  const assistantAskedCategory =
    /花在什么上|什么项目|哪方面的支出|什么开销|买了什么|买的啥|买啥了/.test(recentMsgs);
  const assistantAskedAmount = /花了多少|多少钱/.test(recentMsgs);
  if (!assistantAskedCategory && !assistantAskedAmount) return intent;

  const hasAmount =
    /\d+\s*[元块钱]|[￥¥]\s*\d+|\d+\s*元|\d+\.\d{1,2}\s*[元块]/.test(userText);
  if (hasAmount) return intent;

  if (userText.trim().length > 20) return intent;

  return {
    ...intent,
    intent: 'record',
    write_finance: true,
    has_record_value: true,
    missing_key_info: '花了多少钱？',
  };
}

/** 用户想取消待办时可能用的多种说法（不仅限于「取消」） */
const CANCEL_REMINDER_VERB_RE =
  /取消|删掉|删除|撤销|去掉|撤掉|作废|关闭|停掉|移除|解除|废掉|删了|关了|停了|不用了|不要了|别再提醒|不用提醒|不要提醒|不用再提醒|不要再提醒|别提醒|撤消|销掉|抹掉|干掉|砍掉|推掉|辞掉|算了|作罢/;

/** 短句补充、无明确「要深度分析」诉求时不走 R1，降低延迟与费用 */
function applyDeepReasoningHeuristic(intent: IntentResult, userText: string): IntentResult {
  if (!intent.needs_deep_reasoning) return intent;
  const t = userText.trim();
  const deepCue =
    /帮我分析|给我建议|怎么办|该怎么|如何选|有什么影响|利弊|权衡|深度|仔细想|帮我想想|规划一下|理性分析|多角度/.test(t);
  if (/^(按月|按年|包月|包年|月付|年付|月订阅|年订阅)$/.test(t)) {
    return { ...intent, needs_deep_reasoning: false };
  }
  if (/^(每月|每个月)\s*\d{1,2}\s*(号|日)?$/.test(t)) {
    return { ...intent, needs_deep_reasoning: false };
  }
  if (t.length <= 40 && !deepCue) {
    return { ...intent, needs_deep_reasoning: false };
  }
  return intent;
}

/** 用户句是否出现家庭成员 name 或非空 nickname（nickname 避免 includes('') 恒真） */
function memberMentionedInUserText(
  userText: string,
  members: { name: string; nickname?: string | null }[]
): boolean {
  return members.some(m => {
    const name = (m.name || '').trim();
    if (name.length > 0 && userText.includes(name)) return true;
    const nick = String(m.nickname ?? '').trim();
    return nick.length > 0 && userText.includes(nick);
  });
}

/** 纯亲属/泛化指代：不应触发「添加家庭成员」询问 */
const RELATED_MEMBER_GENERIC_KINSHIP =
  /^(我|俺|咱|老公|老婆|妻子|丈夫|爱人|对象|孩他爸|孩子他爸|孩她爸|孩子她爸|老爸|老妈|爸爸|妈妈|爸|妈|公公|婆婆|岳父|岳母|孩子|小朋友|小孩|侄儿|侄女|外甥|孙子|孙女|闺女儿|儿子)$/;

/** 展示给分类/抽取模型的成员串：祖辈 role 附带视角说明（匹配仍以 DB role 为准） */
const ROLE_PERSPECTIVE_NOTE: Record<string, string> = {
  丈夫父亲: '丈夫的爸爸',
  丈夫母亲: '丈夫的妈妈',
  妻子父亲: '妻子的爸爸',
  妻子母亲: '妻子的妈妈',
};

function formatFamilyMembersStrForClassifier(
  members: { name: string; role: string; notes?: string | null }[] | null | undefined
): string {
  if (!members?.length) return '';
  return members
    .map(m => {
      const role = (m.role || '').trim();
      const note = ROLE_PERSPECTIVE_NOTE[role];
      const roleLabel = note ? `${m.name}（${note}）` : `${m.name}（${role}）`;
      const notesStr = (m.notes || '').trim();
      return notesStr ? `${roleLabel}，个人信息：${notesStr}` : roleLabel;
    })
    .join('\n');
}

/** 第一人称口语 → isKinshipAlreadyLinkedToCurrentUser 用到的规范称谓键（与 KINSHIP_TO_ROLES 一致） */
const FIRST_PERSON_PHRASE_TO_KINSHIP_LABEL: Record<string, string> = {
  我母亲: '母亲',
  我父亲: '父亲',
  我爷爷: '爷爷',
  我奶奶: '奶奶',
  我外公: '外公',
  我外婆: '外婆',
  我姥姥: '姥姥',
  我姥爷: '姥爷',
  我妈: '妈妈',
  我爸: '爸爸',
};

/** 第一人称亲属口语 → unknown_member_detected 用的规范称谓；键按长度降序匹配避免「我」前缀误配 */
const FIRST_PERSON_KINSHIP_TO_LABEL: Record<string, string> = {
  我母亲: '妈妈',
  我父亲: '爸爸',
  我爷爷: GRANDPARENT_ROLES.husbandFather,
  我奶奶: GRANDPARENT_ROLES.husbandMother,
  我外公: GRANDPARENT_ROLES.wifeFather,
  我外婆: GRANDPARENT_ROLES.wifeMother,
  我姥姥: GRANDPARENT_ROLES.wifeMother,
  我姥爷: GRANDPARENT_ROLES.wifeFather,
  我姐妹: '姐妹',
  我兄弟: '兄弟',
  我妈: '妈妈',
  我爸: '爸爸',
  我哥: '哥哥',
  我姐: '姐姐',
  我弟: '弟弟',
  我妹: '妹妹',
};

const FIRST_PERSON_KINSHIP_RE = new RegExp(
  Object.keys(FIRST_PERSON_KINSHIP_TO_LABEL)
    .sort((a, b) => b.length - a.length)
    .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
);

function memberRoleMatchesKinshipLabel(
  role: string,
  normalized: string
): boolean {
  const r = (role || '').trim();
  if (!r) return false;
  if (normalized === '妈妈') return /妈妈|母亲/.test(r);
  if (normalized === '爸爸') return /爸爸|父亲/.test(r);
  if (normalized === GRANDPARENT_ROLES.husbandFather) return /丈夫父亲|爷爷/.test(r);
  if (normalized === GRANDPARENT_ROLES.husbandMother) return /丈夫母亲|奶奶/.test(r);
  if (normalized === GRANDPARENT_ROLES.wifeFather) return /妻子父亲|外公|姥爷/.test(r);
  if (normalized === GRANDPARENT_ROLES.wifeMother) return /妻子母亲|外婆|姥姥/.test(r);
  if (normalized === '兄弟') return /兄弟|哥|弟|兄/.test(r);
  if (normalized === '姐妹') return /姐妹|姐|妹/.test(r);
  if (normalized === '哥哥') return /哥哥|哥|兄/.test(r);
  if (normalized === '姐姐') return /姐姐|姐/.test(r);
  if (normalized === '弟弟') return /弟弟|弟/.test(r);
  if (normalized === '妹妹') return /妹妹|妹/.test(r);
  return r.includes(normalized);
}

function isPrimaryHusbandFamilyRole(role: string | null | undefined): boolean {
  const r = (role || '').trim();
  return r === '丈夫' || r === '老公' || r === '先生';
}

function isPrimaryWifeFamilyRole(role: string | null | undefined): boolean {
  const r = (role || '').trim();
  return r === '妻子' || r === '老婆' || r === '太太';
}

/** 弹窗/unknown_member_detected 用语：跨视角误称时用口语（外公）而非对方 role 名（妻子父亲） */
function firstPersonUnknownDetectedLabel(
  matchedPhrase: string,
  currentUserFamilyRole: string | null
): string {
  if (isPrimaryHusbandFamilyRole(currentUserFamilyRole)) {
    if (matchedPhrase === '我外公' || matchedPhrase === '我姥爷') return '外公';
    if (matchedPhrase === '我外婆' || matchedPhrase === '我姥姥') return '外婆';
  }
  if (isPrimaryWifeFamilyRole(currentUserFamilyRole)) {
    if (matchedPhrase === '我爷爷') return '爷爷';
    if (matchedPhrase === '我奶奶') return '奶奶';
  }
  return FIRST_PERSON_KINSHIP_TO_LABEL[matchedPhrase];
}

/**
 * 判断用户说的亲属称谓是否已在成员列表里
 * 基于新的明确 role 体系（丈夫父亲/丈夫母亲/妻子父亲/妻子母亲）
 * 同时兼容旧数据（爷爷/奶奶/外公/外婆）
 */
function isKinshipAlreadyLinkedToCurrentUser(
  kinshipLabel: string,
  members: { name: string; role: string; linked_user_id?: string | null }[],
  _currentUserId: string,
  currentUserRole: string | null
): boolean {
  const isHusband = isPrimaryHusbandFamilyRole(currentUserRole);
  const isWife = isPrimaryWifeFamilyRole(currentUserRole);

  const KINSHIP_TO_ROLES: Record<string, { husband: string[]; wife: string[] }> = {
    爸爸: { husband: ['丈夫父亲'], wife: ['妻子父亲'] },
    父亲: { husband: ['丈夫父亲'], wife: ['妻子父亲'] },
    妈妈: { husband: ['丈夫母亲'], wife: ['妻子母亲'] },
    母亲: { husband: ['丈夫母亲'], wife: ['妻子母亲'] },
    爷爷: { husband: ['丈夫父亲', '爷爷'], wife: [] },
    奶奶: { husband: ['丈夫母亲', '奶奶'], wife: [] },
    外公: { husband: [], wife: ['妻子父亲', '外公'] },
    外婆: { husband: [], wife: ['妻子母亲', '外婆'] },
    姥爷: { husband: [], wife: ['妻子父亲', '外公'] },
    姥姥: { husband: [], wife: ['妻子母亲', '外婆'] },
  };

  const mapping = KINSHIP_TO_ROLES[kinshipLabel];
  if (!mapping) return false;

  const matchableRoles = isHusband
    ? mapping.husband
    : isWife
      ? mapping.wife
      : [...mapping.husband, ...mapping.wife];

  if (matchableRoles.length === 0) return false;

  return members.some(m => matchableRoles.includes((m.role || '').trim()));
}

function isListedFamilyMemberNameOrNickname(
  label: string,
  members: { name: string; nickname?: string | null }[]
): boolean {
  const t = (label || '').trim();
  if (!t) return false;
  return members.some(m => {
    const n = (m.name || '').trim();
    const nk = String(m.nickname ?? '').trim();
    if (n && (t === n || (n.length >= 2 && t.includes(n)) || (t.length >= 2 && n.includes(t)))) return true;
    if (nk && (t === nk || (nk.length >= 2 && t.includes(nk)) || (t.length >= 2 && nk.includes(t)))) return true;
    return false;
  });
}

/**
 * 覆盖默认事主前分类器可能把「宝宝」等写在 related_member，却未写 unknown_member_detected；
 * 此处补上，恢复「是否添加家庭成员」弹窗（与 isWorkplaceHonorific / 已拒绝列表仍由下游处理）。
 */
function supplementUnknownMemberDetectedFromRelatedMember(
  intent: IntentResult,
  relatedMemberBeforeListDefault: string,
  userText: string,
  members: { name: string; nickname?: string | null; role?: string | null; linked_user_id?: string | null }[],
  currentUserMemberName: string,
  currentUserId: string | null,
  currentUserFamilyRole: string | null
): IntentResult {
  if ((intent.unknown_member_detected || '').trim()) return intent;

  if (FIRST_PERSON_KINSHIP_RE.test(userText)) {
    const matchedKinship = Object.keys(FIRST_PERSON_KINSHIP_TO_LABEL)
      .sort((a, b) => b.length - a.length)
      .find(k => userText.includes(k));
    if (matchedKinship) {
      const normalized = FIRST_PERSON_KINSHIP_TO_LABEL[matchedKinship];
      const kinshipLabel = FIRST_PERSON_PHRASE_TO_KINSHIP_LABEL[matchedKinship];
      let alreadyInList = false;
      if (kinshipLabel) {
        alreadyInList = isKinshipAlreadyLinkedToCurrentUser(
          kinshipLabel,
          members.map(m => ({
            name: m.name,
            role: (m.role || '').trim(),
            linked_user_id: m.linked_user_id,
          })),
          currentUserId || '',
          currentUserFamilyRole
        );
      } else {
        alreadyInList =
          isListedFamilyMemberNameOrNickname(normalized, members) ||
          members.some(m => memberRoleMatchesKinshipLabel(m.role ?? '', normalized));
      }
      if (!alreadyInList) {
        return {
          ...intent,
          unknown_member_detected: normalizeUnknownMemberName(
            firstPersonUnknownDetectedLabel(matchedKinship, currentUserFamilyRole)
          ),
        };
      }
    }
  }

  const cand = (relatedMemberBeforeListDefault || '').trim();
  const cur = (currentUserMemberName || '').trim();
  if (!cand || !cur || cand === cur) return intent;
  if (isWorkplaceHonorific(cand)) return intent;
  if (RELATED_MEMBER_GENERIC_KINSHIP.test(cand)) return intent;
  if (isListedFamilyMemberNameOrNickname(cand, members)) return intent;
  const candNorm = cand.replace(/\s/g, '');
  if (candNorm.length < 2) return intent;
  const textCompact = userText.replace(/\s/g, '');
  if (!textCompact.includes(candNorm) && !userText.includes(cand)) return intent;
  return { ...intent, unknown_member_detected: normalizeUnknownMemberName(cand) };
}

/** 分类器返回的 missing_key_info：保留小写 date；去掉废弃的 time 子串 */
function sanitizeClassifierMissingKeyInfoToChinese(mk: string): string {
  const raw = (mk || '').trim();
  if (!raw) return '';
  if (/^date$/i.test(raw)) return 'date';
  let s = raw.replace(/\btime\b/gi, '').replace(/\s{2,}/g, ' ').trim();
  if (!s || /^[？?！!。.,，、…]*$/.test(s)) return '';
  return s;
}

function missingKeyTargetsTimeOrSchedule(mk: string): boolean {
  const s = (mk || '').trim();
  if (!s) return false;
  return /\btime\b/i.test(s) || /几点|几时|钟点|时刻|什么时候|何时/.test(s);
}

/** 用户是否在短句里补充了可写入的钟点/日期时刻（用于关闭 time 类 missing_key） */
function looksLikeUserSuppliedScheduleTime(userText: string): boolean {
  const s = userText.trim();
  if (!s || s.length > 48) return false;
  if ((/几点|几时|什么时候/.test(s) || /哪天空|哪天/.test(s)) && !/\d/.test(s) && !/[一二三四五六七八九十两]/.test(s)) {
    return false;
  }
  return (
    /(今晚|今夜|今天晚上|昨晚|今早|明早|明天早上|今天中午|明天|今天|后天|大后天)\d{1,2}\s*点/.test(s) ||
    /\d{1,2}\s*[点：:]\s*\d{1,2}/.test(s) ||
    /\d{1,2}\s*点(?:半|\d{1,2}分)?/.test(s) ||
    /(上午|下午|晚上|凌晨|中午).{0,10}\d{1,2}\s*点/.test(s) ||
    /^[一二三四五六七八九十两零〇]+\s*点/.test(s) ||
    /^\d{1,2}\s*:\s*\d{1,2}/.test(s)
  );
}

/**
 * 用户原文是否含可落库的「具体钟点」「N 分钟后」或「提前 X 分/小时」；
 * 用于写库前：否则一次性「无钟点」规则为——**通知日/事项日为今天**用发送时刻，**明天及更远**用该日 07:00（上海）。
 * 全句扫描（不限 48 字），与短句追问用的 looksLikeUserSuppliedScheduleTime 区分。
 */
function userSpecifiedConcreteReminderTimeInText(userText: string): boolean {
  const s = (userText || '').trim();
  if (!s) return false;
  if (parseMinutesOffsetFromNowFromChinese(s) != null) return true;
  if (parseRemindLeadMinutesFromChinese(s) != null) return true;
  if ((/几点|几时|什么时候/.test(s) || /哪天空|哪天/.test(s)) && !/\d/.test(s) && !/[一二三四五六七八九十两]/.test(s)) {
    return false;
  }
  return (
    /(今晚|今夜|今天晚上|昨晚|今早|明早|明天早上|今天中午|明天|今天|后天|大后天)\d{1,2}\s*点/.test(s) ||
    /\d{1,2}\s*[点：:]\s*\d{1,2}/.test(s) ||
    /\d{1,2}\s*点(?:半|\d{1,2}分)?/.test(s) ||
    /(上午|下午|晚上|凌晨|中午).{0,10}\d{1,2}\s*点/.test(s) ||
    /[一二三四五六七八九十两零〇]{1,3}\s*点/.test(s) ||
    /\d{1,2}\s*:\s*\d{1,2}/.test(s)
  );
}

function applyMissingKeyTimeAnswerHeuristic(intent: IntentResult, userText: string): IntentResult {
  if (intent.intent !== 'record' || intent.cancel_reminder) return intent;
  const mk = (intent.missing_key_info || '').trim();
  if (!mk || !missingKeyTargetsTimeOrSchedule(mk)) return intent;
  if (!looksLikeUserSuppliedScheduleTime(userText)) return intent;
  return { ...intent, missing_key_info: '' };
}

function looksLikeUserSuppliedConcreteCalendarDay(userText: string): boolean {
  const s = userText.trim();
  if (!s || s.length > 96) return false;
  /** 「周末」类未明确周六或周日具体公历日时，不算已补答锚点日（与分类器「模糊→date」一致） */
  if (
    /周末/.test(s) &&
    !/周六|周天|周日|礼拜六|礼拜日|礼拜天|星期[六日]|周[六日](?![一二三四五])/.test(s)
  ) {
    return false;
  }
  return (
    /\d{1,2}\s*月\s*\d{1,2}\s*[日号]/.test(s) ||
    /\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}/.test(s) ||
    /明早|今晚|今天中午|今天晚上/.test(s) ||
    /今(?:天|日)|明(?:天|日)|后(?:天|日)|大后(?:天|日)/.test(s) ||
    /周[一二三四五六日天]|星期[一二三四五六日]/.test(s) ||
    /下(?:周|礼拜)[一二三四五六日天]|下星期[一二三四五六日]/.test(s) ||
    /每周[一二三四五六日天]|每个?星期[一二三四五六日]/.test(s) ||
    /\d{1,2}\s*[日号](?![点时分秒])/.test(s)
  );
}

function applyMissingKeyDateAnswerHeuristic(intent: IntentResult, userText: string): IntentResult {
  if (intent.intent !== 'record' || intent.cancel_reminder) return intent;
  const mkRaw = (intent.missing_key_info || '').trim();
  const mk = mkRaw.toLowerCase();
  const slotIsDateLike =
    mk === 'date' ||
    (/每周几/.test(mkRaw) && !/几点|几时|钟点|时刻/.test(mkRaw)) ||
    (/每月几号/.test(mkRaw) && !/几点|几时|钟点|时刻/.test(mkRaw));
  if (!slotIsDateLike) return intent;
  if (!looksLikeUserSuppliedConcreteCalendarDay(userText)) return intent;
  return { ...intent, missing_key_info: '' };
}

function applyMissingKeyConfirmAnswerHeuristic(
  intent: IntentResult,
  userText: string,
  recentMsgs: string
): IntentResult {
  if (intent.intent !== 'record' || intent.cancel_reminder) return intent;
  const mk = (intent.missing_key_info || '').trim();
  if (!mk) return intent;

  const assistantAskedParticipation = /要参加吗|去吗|参加吗|报名吗/.test(recentMsgs);
  if (!assistantAskedParticipation) return intent;

  const userConfirmed = /^(参加|要|去|好|行|可以|报名|嗯|对|是的|要去|要参加|我们去|我去)/.test(
    userText.trim()
  );
  if (!userConfirmed) return intent;

  return { ...intent, missing_key_info: '' };
}

/** 从用户原句去掉家庭成员姓名，用作追问前缀「事件」摘要（不出现他人名） */
function buildActivitySnippetStripMemberNames(
  userText: string,
  members: { name: string; nickname?: string | null }[]
): string {
  let activity = userText.trim();
  const nameParts = [
    ...new Set(
      members.flatMap(m => {
        const n = (m.name || '').trim();
        const nk = String(m.nickname ?? '').trim();
        return [n, nk].filter(s => s.length > 0);
      })
    ),
  ].sort((a, b) => b.length - a.length);

  for (const part of nameParts) {
    activity = activity.split(part).join('');
  }
  activity = activity.replace(/\s+/g, '').replace(/^[，,。．、]+|[，,。．、]+$/g, '');
  if (activity.length < 2) activity = '这件事';
  return activity;
}

function classifyDeterministicMissingKeyKind(mkRaw: string): 'time' | 'member' | 'date' | 'amount' | 'other' {
  const mk = (mkRaw || '').trim();
  if (/^date$/i.test(mk)) return 'date';
  if (/多少钱|花了多少|金额|多少元|多少块/.test(mk)) return 'amount';
  if (/谁|哪位|是谁|哪个家人|主体是谁|哪位的/.test(mk)) return 'member';
  if (
    /几号|每月|哪天|哪日|几月|何日|星期|周几/.test(mk) &&
    !/几点|几时|钟点|时刻/.test(mk)
  ) {
    return 'date';
  }
  if (/按月|按年|包月|包年|月付|年付/.test(mk)) return 'other';
  return 'time';
}

/** 缺槽位时不走主模型：由代码生成整句追问（与 DeepSeek 无关） */
function buildDeterministicMissingKeyReply(
  userText: string,
  missingKeyInfo: string,
  members: { name: string; nickname?: string | null }[]
): string {
  const mk = sanitizeClassifierMissingKeyInfoToChinese(missingKeyInfo).trim();

  if (mk.length >= 4 && mk.length <= 30 && /[？?]$/.test(mk) && /^[^\x00-\x7F]/.test(mk)) {
    const activity = buildActivitySnippetStripMemberNames(userText, members);
    return `${activity}～${mk}`;
  }

  const activity = buildActivitySnippetStripMemberNames(userText, members);
  const kind = classifyDeterministicMissingKeyKind(mk);
  if (kind === 'member') return `${activity}～这是谁的事？`;
  if (kind === 'amount') return `${activity}～花了多少？`;
  if (kind === 'date') {
    const mkClean = mk;
    const tail =
      mkClean && mkClean.length <= 20 && /[？?]$/.test(mkClean) ? mkClean : '具体哪天？';
    return `${activity}～${tail}`;
  }
  if (kind === 'time') return `${activity}～几点去？`;
  const q = mk;
  const tail = q && q.length <= 40 ? (/[？?]$/.test(q) ? q : `${q}？`) : '能再说具体一点吗？';
  return `${activity}～${tail}`;
}

/** 从 prepare 的 debugTrace 中解析 [DEBUG][extract] output 里 reminders 条数 */
function parseRemindersCountFromExtractDebugTrace(trace: string[] | null | undefined): {
  remindersCount: number | null;
  foundExtractOutputLine: boolean;
} {
  if (!trace?.length) return { remindersCount: null, foundExtractOutputLine: false };
  const marker = '[DEBUG][extract] output:';
  for (const line of trace) {
    const i = line.indexOf(marker);
    if (i === -1) continue;
    const jsonStr = line.slice(i + marker.length).trim();
    if (!jsonStr.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(jsonStr) as { reminders?: unknown[] };
      const n = Array.isArray(parsed.reminders) ? parsed.reminders.length : 0;
      return { remindersCount: n, foundExtractOutputLine: true };
    } catch {
      return { remindersCount: null, foundExtractOutputLine: true };
    }
  }
  return { remindersCount: null, foundExtractOutputLine: false };
}

function extractDebugTraceHasPastRemindAtSkip(trace: string[] | null | undefined): boolean {
  return Boolean(trace?.some(l => l.includes('reminder_skip:pastRemindAt')));
}

/** 与 buildDeterministicMissingKeyReply 写入 DB 的追问句一致，用于识别「用户刚补答了缺槽位」 */
function isAssistantDeterministicMissingKeyReplyContent(raw: string): boolean {
  const c = flatMessageContentForClassifier(String(raw ?? '')).trim();
  if (!c.includes('～') || !/[？?]$/.test(c)) return false;
  if (
    /～几点去？[？?]?$/.test(c) ||
    /～这是谁的事？[？?]?$/.test(c) ||
    /～具体哪天？[？?]?$/.test(c) ||
    /～每周几？[？?]?$/.test(c) ||
    /～每月几号[^～]*[？?]$/.test(c) ||
    /～花了多少？[？?]?$/.test(c) ||
    /～能再说具体一点吗？[？?]?$/.test(c)
  ) {
    return true;
  }
  /** 「简述～≤30 字中文问句」类（如 你们要参加吗？） */
  const m = c.match(/^([^～]+)～([^～]+)$/);
  if (m && m[2].length >= 4 && m[2].length <= 30 && /^[^\x00-\x7F]/.test(m[2])) return true;
  return false;
}

/** 识别 AI 上一轮回复属于「已经记过了/已有提醒」类口播，用于「用户确认→重新提取」场景 */
function isAssistantAlreadyRecordedReply(raw: string): boolean {
  const c = String(raw ?? '').trim();
  if (!c) return false;
  return /之前已经记过|已经记好了|已经有.*提醒|之前设过|已经设好|已经记录|已有.*提醒|已经帮.{0,4}记|有记录|记好了/.test(c);
}

/** 抽取结果与意图层对齐：未点名则 related_member 与 title/description 去掉误写的他人姓名 */
function applyCodeLayerRelatedMemberToExtractEvents(
  events: Array<{
    related_member?: string;
    is_person?: boolean;
    title?: string;
    description?: string;
  }>,
  userText: string,
  members: { name: string; nickname?: string | null }[],
  codeRelatedMember: string | null | undefined
): void {
  const forced = (codeRelatedMember || '').trim();
  if (!forced || memberMentionedInUserText(userText, members)) return;
  const parts = [
    ...new Set(
      members.flatMap(m => {
        const n = (m.name || '').trim();
        const nk = String(m.nickname ?? '').trim();
        return [n, nk].filter(s => s.length > 0);
      })
    ),
  ].sort((a, b) => b.length - a.length);

  for (const e of events) {
    if (!e || e.is_person === false) continue;
    e.related_member = forced;
    let t = String(e.title || '');
    let d = String(e.description || '');
    for (const p of parts) {
      if (!p || p === forced) continue;
      if (userText.includes(p)) continue;
      if (t.includes(p)) {
        t = t.split(p).join('').replace(/\s+/g, ' ').replace(/^[：:，,\s]+|[：:，,\s]+$/g, '').trim();
      }
      if (d.includes(p)) {
        d = d.split(p).join('').replace(/\s+/g, ' ').replace(/^[：:，,\s]+|[：:，,\s]+$/g, '').trim();
      }
    }
    if (t) e.title = t;
    if (d) e.description = d;
  }
}

/**
 * 场景：上一轮 AI 回复「已经记过了」，用户这轮说「提醒我」/「帮我提醒」等短句。
 * 此时 intent 分类器只看到 3～5 个字，无法判断需要创建提醒。
 * 强制设置 intent=record + needs_reminder=true，让后续 extract 流程用 extractTextForExtract（已被设为上上轮原话）正确提取。
 */
function applySetReminderAfterAlreadyRecordedHeuristic(
  intent: IntentResult,
  userText: string,
  recentRows: Array<{ role: string; content: unknown }> | null | undefined,
  lastDedupBlockedText: string | null,
): IntentResult {
  const t = userText.trim();
  if (t.length > 15) return intent;
  if (!/提醒我|帮我提醒|帮我设|设置提醒|要提醒|需要提醒|设个提醒|设一下|提醒一下|帮设/.test(t)) return intent;
  // 路径1：ref 里有上一轮 dedup 命中记录（最可靠）
  if (lastDedupBlockedText) {
    return { ...intent, intent: 'record' as const, has_record_value: true, needs_reminder: true, missing_key_info: '' };
  }
  // 路径2：DB 里有 user-assistant-user 结构，上上轮用户说了含时间的实质事件内容
  if (recentRows && recentRows.length >= 3) {
    const r0 = recentRows[0];
    const r1 = recentRows[1];
    const r2 = recentRows[2];
    if (r0?.role === 'user' && r1?.role === 'assistant' && r2?.role === 'user') {
      const prevU = flatMessageContentForClassifier(String(r2.content ?? '')).trim();
      // 上上轮必须包含时间/日期/周期词，才视为有实质提醒内容
      const hasTimeContent = /[点时分]|\d{1,2}[:：]\d{2}|每周|每天|每月|周[一二三四五六日天]|星期|下午|上午|晚上|明天|后天/.test(prevU);
      if (prevU && prevU.length > t.length && hasTimeContent) {
        return { ...intent, intent: 'record' as const, has_record_value: true, needs_reminder: true, missing_key_info: '' };
      }
    }
  }
  return intent;
}

function applyCancelReminderHeuristic(intent: IntentResult, userText: string): IntentResult {
  const t = userText.trim();
  if (intent.cancel_reminder) return intent;
  if (/不想取消|别取消|不要取消|甭取消|不用取消|别删掉|不要删掉/.test(t)) return intent;

  if (!CANCEL_REMINDER_VERB_RE.test(t)) return intent;

  // 易误判为「取消订单/订阅」等非家庭提醒场景
  if (/订单|订阅|自动续费|关注|会员|退款申请|外卖|打车|核酸|挂号|预约单/.test(t)) return intent;

  // 明确提到提醒/待办/闹钟，或「动词+主题」的较短整句（不强制句子里出现「提醒」二字）
  const explicitReminderPhrase =
    /(?:取消|删掉|删除|撤销|去掉|撤掉|作废|关闭|停掉|移除|解除|删了|关了|停了|废掉|别再提醒|不用提醒|不要提醒|不用再提醒|不要再提醒|别提醒).{0,28}(?:提醒|待办|闹钟|日程)/.test(
      t
    ) ||
    /(?:提醒|待办|闹钟).{0,14}(?:取消|删掉|删除|撤销|去掉|撤掉|作废|关闭|停掉|移除|删了|关了|停了|解除)/.test(t) ||
    /别提醒|不用提醒|不要提醒|不用再提醒|不要再提醒/.test(t);

  const moderateLen = t.length <= 88;
  const hasScheduleNoun = /提醒|待办|闹钟|日程/.test(t);
  if (!explicitReminderPhrase && !(moderateLen || hasScheduleNoun)) return intent;

  const kw = intent.cancel_reminder_keywords?.trim() || fallbackCancelKeywords(t);
  return {
    ...intent,
    cancel_reminder: true,
    cancel_reminder_keywords: kw,
  };
}

type CancelReminderFlowResult =
  | { kind: 'noop' }
  | { kind: 'multi'; intro: string; choices: ReminderCancelChoice[] }
  | { kind: 'single'; title: string }
  | { kind: 'none'; keywords: string }
  | { kind: 'vague' }
  | { kind: 'failed' };

async function runCancelReminderFlow(
  familyId: string | null | undefined,
  intent: IntentResult,
  userText: string
): Promise<CancelReminderFlowResult> {
  if (!familyId || !intent.cancel_reminder) return { kind: 'noop' };
  let kw = (intent.cancel_reminder_keywords || '').trim();
  if (!kw) kw = fallbackCancelKeywords(userText);
  if (!kw) return { kind: 'vague' };

  const { data, error } = await supabase
    .from('reminders')
    .select('id, title, description, remind_at, event_date')
    .eq('family_id', familyId)
    .eq('is_done', false)
    .order('remind_at', { ascending: true })
    .limit(80);

  if (error) {
    console.error('[CancelReminder] query:', error);
    return { kind: 'noop' };
  }

  const matches = (data || []).filter(r => reminderMatchesCancelQuery(r, kw));

  if (matches.length >= 2) {
    const choices: ReminderCancelChoice[] = matches.map(r => ({
      id: r.id,
      title: (r.title || '提醒').slice(0, 120),
      remindAtLabel: formatReminderChoiceLabel(r),
    }));
    const intro =
      `找到 ${matches.length} 条与「${kw}」相关的未完成提醒，点选下方按钮取消其中一条。\n\n` +
      '取消提醒不会记入支出（与记录页「取消」相同）。';
    return { kind: 'multi', intro, choices };
  }
  if (matches.length === 1) {
    const upd = await cancelReminderAsDeclined(matches[0].id);
    if (!upd.ok) {
      console.error('[CancelReminder] update failed:', upd.error);
      return { kind: 'failed' };
    }
    await scheduleAllReminders();
    return { kind: 'single', title: (matches[0].title || '提醒').slice(0, 120) };
  }
  return { kind: 'none', keywords: kw };
}

interface ExtractedEvent {
  id: string;
  title: string;
  description: string;
  event_type: string;
  related_member: string;
  is_person: boolean;
  date_type: 'once' | 'weekly' | 'daily' | 'monthly' | 'yearly';
  event_date: string | null;
  recurring_days: number[] | null;
  height: number | null;
  weight: number | null;
  amount: number;
  is_milestone: boolean;
  needs_reminder: boolean;
  is_negative: boolean;
  is_uncertain: boolean;
  group_id: string;
}

interface ExtractedReminder {
  event_id: string;
  title: string;
  date_type: 'once' | 'weekly' | 'daily' | 'monthly' | 'yearly';
  event_date: string | null;
  recurring_days: number[] | null;
  /** 0=事项日（到点）当天；N=提前 N 个自然日；未填按 0 */
  remind_before_days?: number | null;
  /** 事项前 X 分钟响铃；用户明确「提前X分钟」时填写；否则 null（系统默认 15，并解析原话） */
  remind_before_minutes?: number | null;
}

interface ExtractedFinanceTx {
  title: string;
  description: string;
  amount: number;
  direction: 'income' | 'expense';
  category: string;
  occurred_date: string | null;
}

interface ExtractResult {
  events: ExtractedEvent[];
  reminders: ExtractedReminder[];
  finance_transactions: ExtractedFinanceTx[];
  /** 抽取侧：缺槽位时含关键字，如 time 表示缺时刻 */
  missing_key_info?: string;
}

const EVENT_TYPE_LIST = [
  'health', 'child', 'finance', 'vehicle', 'house',
  'relationship', 'admin', 'plant_pet', 'daily',
] as const;

function normalizeFinanceCategory(raw: string): string {
  const c = (raw || '').toLowerCase().trim();
  return (EVENT_TYPE_LIST as readonly string[]).includes(c) ? c : 'daily';
}

/** 待办提醒上的金额与流水标题粗匹配，用于去掉误输出的 finance_transactions */
function titlesLooselyMatch(a: string, b: string): boolean {
  const na = (a || '').replace(/\s/g, '').toLowerCase();
  const nb = (b || '').replace(/\s/g, '').toLowerCase();
  if (!na || !nb) return true;
  return na.includes(nb) || nb.includes(na);
}

function filterOutDeferredExpenseRows<
  T extends { amount: number; direction: string; title: string },
>(rows: T[], deferred: { amount: number; title: string }[]): T[] {
  if (!deferred.length) return rows;
  const consumed = new Set<number>();
  return rows.filter(row => {
    if (row.direction !== 'expense') return true;
    for (let i = 0; i < deferred.length; i++) {
      if (consumed.has(i)) continue;
      const d = deferred[i];
      if (Math.abs(Number(row.amount) - Number(d.amount)) > 0.009) continue;
      if (!titlesLooselyMatch(row.title, d.title)) continue;
      consumed.add(i);
      return false;
    }
    return true;
  });
}

function occurredAtISO(dateStr: string | null | undefined): string {
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(`${dateStr}T12:00:00+08:00`).toISOString();
  }
  return new Date().toISOString();
}

const parseWeightKgFromDescription = (desc: string): number | null => {
  if (!desc) return null;
  const m = desc.match(/(\d+(?:\.\d+)?)\s*斤/);
  if (!m) return null;
  const jin = parseFloat(m[1]);
  if (!Number.isFinite(jin)) return null;
  // 斤 -> kg，保留两位小数
  return Math.round((jin / 2) * 100) / 100;
};

/**
 * 从「周五19点」「11点58分」「12点20」「下午3点」等解析上海墙上钟点；识别不到返回 null。
 * 「分」可省略（12点20提醒 = 12:20）；旧版要求「分」字会导致分钟恒为 0。
 */
function extractClockFromChineseScheduleText(blob: string): { hour: number; minute: number } | null {
  if (!blob?.trim()) return null;
  const m = blob.match(/(\d{1,2})\s*点(?:\s*(\d{1,2})(?:\s*分)?)?/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const minRaw = m[2];
  let minute = minRaw != null && minRaw !== '' ? parseInt(minRaw, 10) : 0;
  if (Number.isNaN(h) || h < 0 || h > 23) return null;
  if (Number.isNaN(minute) || minute < 0 || minute > 59) return null;
  if (h < 13) {
    if (/下午/.test(blob)) h = h === 12 ? 12 : h + 12;
    else if (/晚上|夜里|晚间|今夜|今晚/.test(blob)) {
      /**
       * 「今晚/今夜12点五十五」口语几乎总是当天 23:55，而非正午 12:55；真正午夜多会说凌晨12点/0点。
       * 「晚上/夜里12点」仍按 0 点（次日清晨档）。
       */
      if (h === 12 && /今晚|今夜/.test(blob)) h = 23;
      else if (h === 12) h = 0;
      else h += 12;
    }
  }
  return { hour: h, minute };
}

/** 用户是否明确说了日历日（有则用模型的 event_date；否则钟点提醒勿信模型乱填的日期） */
function hasExplicitCalendarInUserText(t: string): boolean {
  if (!t?.trim()) return false;
  if (parseDayOfMonthFromChineseText(t) != null) return true;
  return /(明天|后天|大后天|今日|今天|今晚|昨夜|明晚|今夜|昨天晚上|今天晚上|昨天|前天|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,2}\s*月\s*\d{1,2}(?!\d)|本周|这周|上周|下周|周[一二三四五六日天]|星期[一二三四五六日天日])/.test(
    t
  );
}

/** 抽取 prompt：当前发言用户在本家的身份一行，供 related_member 默认主语 */
function formatCurrentUserMemberForExtract(
  linked: { name: string; role: string } | null,
  appDisplayName: string
): string {
  if (linked?.name?.trim()) {
    const role = (linked.role || '').trim();
    return role ? `${linked.name.trim()}（${role}）` : linked.name.trim();
  }
  const n = (appDisplayName || '').trim();
  return n ? `${n}（未关联家庭档案成员）` : '暂无';
}

const extractEvents = async (
  userMessage: string,
  familyMembers: string,
  currentUserMember: string,
  recentHistory: string,
  todayStr: string,
  weekDates: string,
  apiKey: string,
  contextAppendix = ''
): Promise<ExtractResult> => {
  const defaultResult: ExtractResult = { events: [], reminders: [], finance_transactions: [] };
  console.log('[DEBUG][extract] input:', userMessage);

  try {
    const prompt = buildExtractStructuredPromptBody({
      userMessage,
      familyMembers,
      currentUserMember,
      recentHistory,
      todayStr,
      weekDates,
      contextAppendix,
    });

    /** 结构化抽取固定 deepseek-chat，不使用 reasoner */
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 1000,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const raw: ExtractResult = {
        events: parsed.events || [],
        reminders: parsed.reminders || [],
        finance_transactions: Array.isArray(parsed.finance_transactions) ? parsed.finance_transactions : [],
        ...(typeof parsed.missing_key_info === 'string' ? { missing_key_info: parsed.missing_key_info } : {}),
      };
      const result = sanitizeExtractForProductRules(userMessage, raw);
      console.log('[DEBUG][extract] output:', JSON.stringify(result));
      return result;
    }
  } catch (e: unknown) {
    const err = e as { message?: string };
    const isNet =
      err?.message === 'Network request failed' ||
      /network|fetch failed|Failed to fetch/i.test(String(err?.message));
    console.error(
      isNet
        ? '信息提取失败：无法连接 DeepSeek（请检查网络、VPN/代理、是否可访问 api.deepseek.com）'
        : '信息提取失败:',
      e
    );
  }
  console.log('[DEBUG][extract] output:', JSON.stringify(defaultResult));
  return defaultResult;
};

type ExtractPersistSnapshot = {
  /** 抽取用文本（可与上轮合并） */
  text: string;
  /** 本轮用户输入框提交的原文；与 text 不同表示发生了合并 */
  thisRoundUserText: string;
  familyMembersStr: string;
  /** 抽取 prompt 用，如「肖珺（妻子）」 */
  currentUserMember: string;
  /** 与意图层一致：用户句未点名时强制写入的 related_member（姓名） */
  codeRelatedMember?: string;
  /** 用于入库前把「我妈」等换成成员姓名，供全家列表阅读 */
  membersBrief: { name: string; role: string; linked_user_id?: string | null }[];
  /** 账户 id → 展示标签；口播家人名优先用 linked 成员的 name */
  recorderLabelByUserId: Record<string, string>;
  recorderLinkedRole: string | null;
  recentMsgs: string;
  todayStr: string;
  weekDates: string;
  familyId: string;
  userId: string;
  conversationId: string;
  shouldWriteEvents: boolean;
  /** chat 误判时仍处理抽取结果，跑家庭/提醒去重与口播 */
  processExtractedEventsForDedupe: boolean;
  writeFinance: boolean;
  extractAppendix: string;
  /** 用户原文含具体钟点 / N分钟后 / 提前量；false 时一次性无钟点提醒按「今天=发送时刻、远期=07:00」兜底 */
  userSpecifiedConcreteTime: boolean;
  /** true 时即使事件已入库/去重，提醒仍强制写入（「提醒我」确认场景） */
  forceCreateReminder?: boolean;
};

type ExtractPrepareStats = {
  reminderInserted: number;
  reminderMerged: number;
  familyEventInserted: number;
  familyEventMerged: number;
};

type ExtractDebugDiag = {
  quickDedupHit: QuickDedupHit | null;
  extractOutput: string;
  candidateCountFe: number;
  candidateCountRem: number;
  dupFeId: string | null;
  dupRemId: string | null;
  writeBlocked: string;
  /** 与 skipReminder 联动：命中家庭记录去重等跳过写库时使用 */
  skipWrite?: boolean;
  skipReminder?: boolean;
  /** prepare 收尾：待写入/已编排的提醒插入操作条数 */
  reminderOpsCount?: number;
  reminderOpsDetail?: Array<{ title: string; remind_at: string; event_date: string | null }>;
  /** 模型抽取原始 reminders（校验/落库前） */
  extractRemindersRaw?: Array<{
    event_id: string;
    title: string;
    event_date: string | null;
    remind_before_days: number | null;
  }>;
};

function attachReminderDebugToDiag(
  diag: ExtractDebugDiag,
  extractResult: ExtractResult,
  reminderPersistOps: Array<{ kind: 'insert'; row: Record<string, unknown> }>
): void {
  diag.reminderOpsCount = reminderPersistOps.length;
  diag.reminderOpsDetail = reminderPersistOps.map(op => ({
    title: typeof op.row.title === 'string' ? op.row.title : String(op.row.title ?? ''),
    remind_at: typeof op.row.remind_at === 'string' ? op.row.remind_at : String(op.row.remind_at ?? ''),
    event_date:
      op.row.event_date == null
        ? null
        : typeof op.row.event_date === 'string'
          ? op.row.event_date
          : String(op.row.event_date),
  }));
  diag.extractRemindersRaw = (extractResult.reminders ?? []).map(r => ({
    event_id: r?.event_id != null ? String(r.event_id) : '',
    title: String(r?.title ?? ''),
    event_date: r?.event_date != null ? String(r.event_date) : null,
    remind_before_days:
      r?.remind_before_days == null || Number.isNaN(Number(r.remind_before_days))
        ? null
        : Number(r.remind_before_days),
  }));
}

type ExtractPersistOutcome = {
  /** 本轮回写库成功插入的 reminders.remind_at（ISO），顺序与插入一致 */
  insertedReminderRemindAt: string[];
  /** 延后 persist 阶段的诊断行（在模型回复之后执行），供【诊断】面板追加 */
  persistDiagnosisLines?: string[];
  /** 写库失败的条目描述（提醒 / 财务流水等） */
  failedItems: string[];
};

type ExtractPrepareResult = {
  injectText: string;
  /** 写入提醒/流水；返回实际插入成功的 remind_at，供回复末尾拼接确认句 */
  persist: () => Promise<ExtractPersistOutcome>;
  stats: ExtractPrepareStats;
  sameEventVoiceHint: SameEventVoiceHint | null;
  /** 供界面展示；不依赖 Metro 控制台 */
  debugTrace: string[];
  debugDiag: ExtractDebugDiag;
  /**
   * 本轮抽取结果（仅在 dupFe 阻断提醒写入时有值）。
   * 供下一轮「提醒我」作为 extractResultOverride 直接复用，避免重新 extract 返回空。
   */
  extractResultForReuse?: ExtractResult;
};

const WEEKDAY_LABELS_INJECT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function formatRecurringRuleForInject(
  rule: string | null | undefined,
  recurringDays: number[] | null | undefined,
  eventDate: string | null | undefined
): string {
  if (!rule || rule === 'once') return '一次性';
  if (rule === 'monthly') {
    if (eventDate && eventDate.length >= 10) {
      const d = parseInt(eventDate.slice(8, 10), 10);
      if (Number.isFinite(d)) return `每月${d}日`;
    }
    return '每月';
  }
  if (rule === 'weekly' && recurringDays?.length) {
    return `每周${recurringDays.map(d => WEEKDAY_LABELS_INJECT[d] || '').filter(Boolean).join('、')}`;
  }
  if (rule === 'daily') return '每天';
  if (rule === 'yearly') return '每年';
  return String(rule);
}

function formatInjectLineForReminder(row: {
  title: string;
  remind_at: string;
  event_date: string | null;
  recurring_rule: string | null;
  recurring_days?: number[] | null;
}): string {
  const dayPart = formatReminderDisplayTime({
    remind_at: row.remind_at,
    event_date: row.event_date,
  });
  const clock = formatReminderWallTimeShanghai(row.remind_at);
  const when =
    clock && !dayPart.includes(':') ? `${dayPart}（提醒时刻 ${clock}）` : dayPart;
  const cycle = formatRecurringRuleForInject(row.recurring_rule, row.recurring_days, row.event_date);
  return `「${(row.title || '提醒').slice(0, 80)}」｜${when}｜周期：${cycle}`;
}

/** 候选 created_by → 口播用：优先家庭成员姓名，其次标签括号前一段 */
function resolveRecorderVoiceMeta(
  createdBy: string | null | undefined,
  currentUserId: string,
  labels: Record<string, string>,
  membersBrief: { name: string; linked_user_id?: string | null }[]
): { recorderIsSelf: boolean; recorderDisplayName: string | null } {
  const cb = createdBy != null && String(createdBy).trim() ? String(createdBy) : null;
  if (!cb) return { recorderIsSelf: false, recorderDisplayName: null };
  if (cb === currentUserId) return { recorderIsSelf: true, recorderDisplayName: null };
  const member = membersBrief.find(m => m.linked_user_id != null && String(m.linked_user_id) === cb);
  if (member?.name?.trim()) return { recorderIsSelf: false, recorderDisplayName: member.name.trim() };
  const lab = labels[cb]?.trim();
  if (lab) {
    const plain = lab.split('（')[0]?.trim();
    if (plain) return { recorderIsSelf: false, recorderDisplayName: plain };
  }
  return { recorderIsSelf: false, recorderDisplayName: null };
}

/** 仅 DeepSeek 请求 messages 用：不展示给用户、不写入 messages 表；引导模型接续已开头的思路 */
function sameEventAssistantPrefillForApi(hint: SameEventVoiceHint): string {
  if (hint.kind === 'already_recorded') {
    if (hint.recorderIsSelf) {
      return '（系统提示：这件事用户自己之前已经提过了，已记好；不能说又新建了一条或「✓ 已记录」暗示本轮写入。）';
    }
    if (hint.recorderDisplayName) {
      return `（系统提示：这件事之前家人「${hint.recorderDisplayName}」已经记过了；可问要不要再看看或有什么要改，不要说成用户本人之前记的。）`;
    }
    return '（系统提示：这件事家里已经记过了（未指明记录人）；如实告知，不能说又新建了一条。）';
  }
  const whoNote =
    !hint.recorderIsSelf && hint.recorderDisplayName
      ? `库里这条可能是家人「${hint.recorderDisplayName}」记的；`
      : !hint.recorderIsSelf
        ? '库里这条可能是其他家人记的；'
        : '';
  switch (hint.diffType) {
    case 'time':
      return `（系统提示：${whoNote}和用户本轮说法相比时间不一致，我只用一句口语问要不要按新的为准；不能声称已改库。）`;
    case 'member':
      return `（系统提示：${whoNote}和本轮相比涉及的人不一致，我只用一句问是换人还是口误；不能声称已改库。）`;
    case 'location':
      return `（系统提示：${whoNote}和本轮相比去的地方/地点说法不一致，我只用一句问是换地方还是记错；不能声称已改库。）`;
    default:
      return `（系统提示：${whoNote}与已有记录有差异，我只问一句请用户确认；不能声称已改库或已记录。）`;
  }
}

/** 同家庭仅保留一条最新的 AI 月供/财务类「每月」提醒，去掉误写入的 +7 天旧条 */
async function dedupeAiMonthlyFinanceReminders(familyId: string): Promise<void> {
  const { data: rows, error } = await supabase
    .from('reminders')
    .select('id, created_at')
    .eq('family_id', familyId)
    .eq('is_done', false)
    .eq('source_type', 'ai_extract')
    .eq('recurring_rule', 'monthly')
    .eq('event_type', 'finance')
    .order('created_at', { ascending: false });
  if (error || !rows || rows.length <= 1) return;
  const [, ...rest] = rows;
  for (const r of rest) {
    await supabase.from('reminders').delete().eq('id', r.id);
  }
}

/** 清理合并文本用于展示：去掉末尾单独一行的短日期/时间补充句 */
function cleanMergedTextForDisplay(mergedText: string): string {
  const lines = mergedText.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length <= 1) return mergedText;
  const lastLine = lines[lines.length - 1]!;
  if (
    lastLine.length <= 6 &&
    /周|月|日|号|点|今|明|后|下周/.test(lastLine)
  ) {
    return lines.slice(0, -1).join('，');
  }
  return lines.join('，');
}

/**
 * 提醒列表：`userText` 为本轮原文，`mergedText` 为与上轮合并后的抽取用全文（有则传）。
 */
function reminderDisplayFromUserUtterance(
  userText: string,
  modelTitle: string,
  mergedText?: string
): { title: string; description: string | null } {
  const singleText = userText.trim();
  const modelT = (modelTitle || '').trim();
  const displayText = mergedText ? cleanMergedTextForDisplay(mergedText) : userText;

  if (!singleText && !mergedText) {
    return { title: modelT.slice(0, 500) || '提醒', description: null };
  }

  if (mergedText) {
    const dt = displayText.trim();
    const desc = dt.slice(0, 100) + (dt.length > 100 ? '...' : '');
    return {
      title: modelT || singleText,
      description: desc || null,
    };
  }

  // modelTitle 有值时始终作为 title，用户原话作为 description（哪怕原话很短）
  if (modelT) {
    return {
      title: modelT,
      description: singleText || null,
    };
  }

  // modelTitle 为空：短句直接做 title，长句截取做 title + 原话做 description
  if (singleText.length <= 30) {
    return { title: singleText, description: null };
  }

  if (singleText.length <= 80) {
    return {
      title: singleText.slice(0, 30),
      description: singleText,
    };
  }

  return {
    title: singleText.slice(0, 30),
    description: singleText.slice(0, 100) + (singleText.length > 100 ? '...' : ''),
  };
}

/**
 * 抽取 + 必要的事件写入；提醒/流水插入推迟到 persist()，注入文案与将写入的数据一致。
 */
const emptyExtractStats = (): ExtractPrepareStats => ({
  reminderInserted: 0,
  reminderMerged: 0,
  familyEventInserted: 0,
  familyEventMerged: 0,
});

/** 合并抽取文本中的「周几」→ 模型 weekday 1–7（周一=1…周日=7）；长词优先避免「周一」误匹配「星期一」 */
function extractWeekdayFromMergedExtractText(text: string): number | null {
  const map: Record<string, number> = {
    星期一: 1,
    星期二: 2,
    星期三: 3,
    星期四: 4,
    星期五: 5,
    星期六: 6,
    星期日: 7,
    星期天: 7,
    周一: 1,
    周二: 2,
    周三: 3,
    周四: 4,
    周五: 5,
    周六: 6,
    周日: 7,
    周天: 7,
  };
  for (const key of Object.keys(map).sort((a, b) => b.length - a.length)) {
    if (text.includes(key)) return map[key]!;
  }
  return null;
}

/** 文本含明确周几时，用上海日历重新算日序并覆盖模型给出的 event_date（仅存 utc 偏移 +08:00 串） */
function overrideExtractDatesFromExplicitWeekday(
  extractResult: ExtractResult,
  mergedExtractText: string,
  log: (msg: string) => void
): void {
  const isNextWeek = /下周|下个周|下个星期/.test(mergedExtractText);
  const weekday = extractWeekdayFromMergedExtractText(mergedExtractText);
  if (weekday == null) return;

  let correctDate: Date | null;
  if (isNextWeek) {
    // 「下周X」= 本周同一周几的日期 + 7天
    // 先找本周（含今天）该周几，再加7天
    const todayYmd = getShanghaiYmd();
    const todayWd = getShanghaiWeekday17FromYmd(todayYmd);
    // 本周目标周几距今天的偏移（可能为负表示本周已过，可能为0表示今天）
    const delta = weekday - todayWd;
    const thisWeekTargetYmd = addCalendarDaysShanghaiYmd(todayYmd, delta);
    const nextWeekTargetYmd = addCalendarDaysShanghaiYmd(thisWeekTargetYmd, 7);
    correctDate = dateFromShanghaiWallClock(nextWeekTargetYmd, 7, 0);
  } else {
    correctDate = getUpcomingShanghaiWeekdayOccurrence(weekday, 7, 0, 0, Date.now());
  }
  if (!correctDate) return;
  const correctYmd = getShanghaiYmd(correctDate);
  const iso = `${correctYmd}T07:00:00+08:00`;
  let nEv = 0;
  let nRem = 0;
  for (const ev of extractResult.events) {
    if (ev.event_date) {
      ev.event_date = iso;
      nEv += 1;
    }
  }
  for (const rem of extractResult.reminders || []) {
    if (rem.event_date) {
      rem.event_date = iso;
      nRem += 1;
    }
  }
  if (nEv + nRem > 0) {
    log(
      `[ExtractWeekdayOverride] weekday=${weekday} nextWeek=${isNextWeek} ymd=${correctYmd} events=${nEv} reminders=${nRem}`
    );
  }
}

async function prepareExtractInjectAndPersist(
  apiKey: string,
  snapshot: ExtractPersistSnapshot,
  prepareOpts?: { extractResultOverride?: ExtractResult }
): Promise<ExtractPrepareResult> {
  const debugTrace: string[] = [];
  const dt = (msg: string) => {
    debugTrace.push(`${new Date().toISOString().slice(11, 23)} ${msg}`);
  };
  dt('[DEBUG][prepare] called');
  console.log('[DEBUG][prepare] called');
  if (snapshot.forceCreateReminder) {
    dt('[DEBUG][prepare] forceCreateReminder=true (提醒我确认场景)');
  }
  const noop = async (): Promise<ExtractPersistOutcome> => ({
    insertedReminderRemindAt: [],
    persistDiagnosisLines: [],
    failedItems: [],
  });
  const stats = emptyExtractStats();
  let sameEventVoiceHint: SameEventVoiceHint | null = null;
  const reminderLines: string[] = [];
  const familyEventLines: string[] = [];
  const financeLines: string[] = [];
  const reminderPersistOps: Array<{ kind: 'insert'; row: Record<string, unknown> }> = [];
  let didInsertReminder = false;
  let shouldDedupeMonthlyFinance = false;

  const voiceRec = (createdBy: string | null | undefined) =>
    resolveRecorderVoiceMeta(
      createdBy,
      snapshot.userId,
      snapshot.recorderLabelByUserId,
      snapshot.membersBrief
    );

  try {
    const t0 = Date.now();
    let extractResult: ExtractResult;
    if (prepareOpts?.extractResultOverride) {
      extractResult = prepareOpts.extractResultOverride;
      dt('[DEBUG][extract] using merge classify+extract override');
    } else {
      extractResult = await extractEvents(
        snapshot.text,
        snapshot.familyMembersStr,
        snapshot.currentUserMember,
        snapshot.recentMsgs,
        snapshot.todayStr,
        snapshot.weekDates,
        apiKey,
        snapshot.extractAppendix
      );
    }
    extractResult.events = normalizeExtractedEventsForClassification(snapshot.text, extractResult.events);
    applyCodeLayerRelatedMemberToExtractEvents(
      extractResult.events,
      snapshot.text,
      snapshot.membersBrief,
      snapshot.codeRelatedMember
    );
    extractResult = sanitizeExtractForProductRules(snapshot.text, extractResult) as ExtractResult;
    const { result: validatedResult, warnings: validateWarnings } = validateAndClampExtractResult(
      extractResult,
      snapshot.membersBrief.map(m => String(m.name || '').trim()).filter(Boolean),
      getShanghaiYmd()
    );
    extractResult = validatedResult as ExtractResult;
    if (validateWarnings.length > 0) {
      dt(`[ExtractValidate] ${validateWarnings.join('; ')}`);
    }
    overrideExtractDatesFromExplicitWeekday(extractResult, snapshot.text, dt);
    dt(`[DEBUG][extract] output: ${JSON.stringify(extractResult)}`);
    const fCount = extractResult.finance_transactions?.length ?? 0;
    console.log(
      '[ExtractPrepare] extract ms:',
      Date.now() - t0,
      'events:',
      extractResult.events.length,
      'reminders:',
      extractResult.reminders.length,
      'finance:',
      fCount
    );
    const processEventReminderPath = snapshot.shouldWriteEvents || snapshot.processExtractedEventsForDedupe;
    const ev0 = extractResult.events?.[0];
    const debugDiag: ExtractDebugDiag = {
      quickDedupHit: null,
      extractOutput: ev0
        ? `type=${ev0.event_type} member=${ev0.related_member || ''} date=${ev0.event_date || ''} title=${(ev0.title || '').slice(0, 48)}`
        : '(no events)',
      candidateCountFe: 0,
      candidateCountRem: 0,
      dupFeId: null,
      dupRemId: null,
      writeBlocked: 'prepare',
      skipWrite: false,
      skipReminder: false,
    };
    dt(
      `extracted events=${extractResult.events.length} reminders=${extractResult.reminders?.length ?? 0} finance=${fCount} shouldWriteEvents=${snapshot.shouldWriteEvents} processDedupe=${snapshot.processExtractedEventsForDedupe} processPath=${processEventReminderPath}`
    );

    const hasEvents = extractResult.events && extractResult.events.length > 0;
    const hasFinanceTx = fCount > 0;
    if (
      !hasEvents &&
      !hasFinanceTx &&
      !snapshot.shouldWriteEvents &&
      !snapshot.writeFinance &&
      !snapshot.processExtractedEventsForDedupe
    ) {
      dt('earlyExit:noPayload');
      debugDiag.writeBlocked = 'early_exit_no_payload';
      attachReminderDebugToDiag(debugDiag, extractResult, reminderPersistOps);
      return { injectText: '', persist: noop, stats, sameEventVoiceHint: null, debugTrace, debugDiag };
    }
    if (processEventReminderPath && !hasEvents && !hasFinanceTx) {
      dt('earlyExit:expectedEventsButNoExtracted');
      debugDiag.writeBlocked = 'early_exit_no_extract';
      attachReminderDebugToDiag(debugDiag, extractResult, reminderPersistOps);
      return { injectText: '', persist: noop, stats, sameEventVoiceHint: null, debugTrace, debugDiag };
    }
    if (snapshot.writeFinance && !hasFinanceTx && !hasEvents) {
      dt('earlyExit:financeOnlyButNoRows');
      debugDiag.writeBlocked = 'early_exit_finance_empty';
      attachReminderDebugToDiag(debugDiag, extractResult, reminderPersistOps);
      return { injectText: '', persist: noop, stats, sameEventVoiceHint: null, debugTrace, debugDiag };
    }

    const financeFallbackFromEvents: Array<{
      title: string;
      description: string;
      amount: number;
      direction: 'income' | 'expense';
      category: string;
      occurred_date: string | null;
      linked_event_id: string | null;
    }> = [];

    const processedGroups = new Set<string>();
    /** 家庭事件命中 dupFe 未插入时，同 groupKey 的提醒也不得落库（与 dupFeId / skipWrite 联动） */
    const groupKeysSkipReminderDueToDupFe = new Set<string>();
    const groupKeyToInsertedEventId = new Map<string, string>();
    const groupKeyToCanonEvent = new Map<
      string,
      { title: string; description: string; subjectName: string }
    >();
    const deferredPendingFinance: { amount: number; title: string }[] = [];
    const deferredLinkedEventIds = new Set<string>();

    let familyEventDedupeCandidates: FamilyEventDedupeRow[] = [];
    const shanghaiTodayYmd = getShanghaiYmd();

    if (processEventReminderPath && hasEvents) {
      familyEventDedupeCandidates = await fetchRecentFamilyEventsForDedupe(snapshot.familyId);
      debugDiag.candidateCountFe = familyEventDedupeCandidates.length;
      const persistReferenceNow = new Date();
      for (const event of extractResult.events) {
        if (event.is_negative || event.is_uncertain) continue;

        const groupKey = event.group_id || event.id;
        const isFirstInGroup = !processedGroups.has(groupKey);
        processedGroups.add(groupKey);

        if (isFirstInGroup) {
          const groupEvents = extractResult.events.filter(e => (e.group_id || e.id) === groupKey);
          const fullDescription = groupEvents.map(e => e.description).join('；');
          const kr = resolveKinshipForRecordedEvent({
            members: snapshot.membersBrief || [],
            recorderLinkedRole: snapshot.recorderLinkedRole,
            modelRelatedMember: event.related_member || '',
            title: event.title,
            description: fullDescription,
            utteranceText: snapshot.text,
            isPerson: event.is_person !== false,
          });
          const subjectName = kr.subjectNameForStrip;
          const baseTitle = kr.canonTitleFromUtterance || event.title;
          const baseDesc = fullDescription;
          const canon = subjectName
            ? stripDeicticKinshipForSharedRecord(baseTitle, baseDesc, subjectName)
            : { title: baseTitle, description: baseDesc };
          const canonDescription = appendRecorderKinshipProvenanceLine(
            canon.title,
            canon.description,
            snapshot.recorderLinkedRole
          );
          const storedRelatedMember = kr.storedRelatedMember;
          groupKeyToCanonEvent.set(groupKey, {
            title: canon.title,
            description: canonDescription,
            subjectName,
          });

          const eventDayYmd =
            event.event_date && /^\d{4}-\d{2}-\d{2}/.test(event.event_date)
              ? event.event_date.slice(0, 10)
              : shanghaiTodayYmd;

          const dupFe = findDuplicateFamilyEventForMerge({
            title: canon.title,
            event_type: event.is_person === false ? 'plant_pet' : event.event_type,
            related_member: storedRelatedMember || '',
            eventDayYmd,
            candidates: familyEventDedupeCandidates,
          });

          const feEventDateRaw = event.event_date != null ? String(event.event_date).trim() : null;
          const feEventDateForDb = feEventDateRaw
            ? normalizeExtractEventDateForDb(feEventDateRaw, persistReferenceNow) ?? feEventDateRaw
            : null;

          let insertedEv: { id: string } | null = null;
          if (dupFe) {
            debugDiag.dupFeId = dupFe.id;
            debugDiag.skipWrite = true;
            debugDiag.skipReminder = true;
            groupKeysSkipReminderDueToDupFe.add(groupKey);
            console.warn('[SameEventVoice] family_dupFe', {
              id: dupFe.id,
              titleIn: (canon.title || '').slice(0, 60),
              titleDb: (dupFe.title || '').slice(0, 60),
              eventDayYmd,
              candCount: familyEventDedupeCandidates.length,
            });
            const candYmd =
              dupFe.event_date && /^\d{4}-\d{2}-\d{2}/.test(dupFe.event_date)
                ? dupFe.event_date.slice(0, 10)
                : getShanghaiYmdFromIso(dupFe.created_at);
            const personChanged = !strictSameRelatedForVoice(dupFe.related_member, storedRelatedMember);
            const timeChanged = candYmd !== eventDayYmd;
            const locationChanged =
              !personChanged && !timeChanged && sameEventLocationCueChanged(dupFe.title, canon.title);
            if (!personChanged && !timeChanged && !locationChanged) {
              if (!sameEventVoiceHint) {
                const vr = voiceRec(dupFe.created_by);
                sameEventVoiceHint = {
                  kind: 'already_recorded',
                  summary: dupFe.title,
                  scope: 'family_event',
                  diffType: 'exact',
                  recorderIsSelf: vr.recorderIsSelf,
                  recorderDisplayName: vr.recorderDisplayName,
                };
              }
              familyEventLines.push(
                `（口播：同一件事，家庭记录已在库中；本轮不写入）「${(dupFe.title || '记录').slice(0, 80)}」`,
              );
            } else {
              const oldPerson = (dupFe.related_member && String(dupFe.related_member).trim()) || '（未填写）';
              const newPerson = (storedRelatedMember && String(storedRelatedMember).trim()) || '（未填写）';
              const diffType = pickAskUpdateDiffType({ timeChanged, personChanged, locationChanged });
              const oldPl = extractPlaceCueForSameEvent(dupFe.title) || dupFe.title.slice(0, 20).trim();
              const newPl = extractPlaceCueForSameEvent(canon.title) || canon.title.slice(0, 20).trim();
              const vr = voiceRec(dupFe.created_by);
              sameEventVoiceHint = {
                kind: 'ask_update',
                scope: 'family_event',
                diffType,
                previousSummary: dupFe.title,
                oldPersonLabel: oldPerson,
                newPersonLabel: newPerson,
                oldTimeLabel: formatYmdBriefChinese(candYmd),
                newTimeLabel: formatYmdBriefChinese(eventDayYmd),
                oldPlaceLabel: oldPl,
                newPlaceLabel: newPl,
                personChanged,
                timeChanged,
                locationChanged,
                recorderIsSelf: vr.recorderIsSelf,
                recorderDisplayName: vr.recorderDisplayName,
              };
              familyEventLines.push(
                `（口播：同一件事与库中有差异·${diffType}；本轮不写入，请用户一句确认）`,
              );
            }
          }
          if (!insertedEv && !dupFe) {
            console.warn('[SameEventVoice] family_insert:attempt', { title: (canon.title || '').slice(0, 60) });
            const { data: ins, error: insErr } = await supabase.from('family_events').insert({
              family_id: snapshot.familyId,
              created_by: snapshot.userId,
              conversation_id: snapshot.conversationId,
              source: 'ai_extract',
              title: canon.title,
              description: canonDescription,
              event_type: event.is_person === false ? 'plant_pet' : event.event_type,
              event_date: feEventDateForDb,
              related_member: storedRelatedMember,
              amount: event.amount || 0,
              is_milestone: event.is_milestone === true,
            } as any).select('id').single();
            if (!insErr && ins?.id) {
              insertedEv = { id: String(ins.id) };
              stats.familyEventInserted += 1;
              familyEventDedupeCandidates.unshift({
                id: String(ins.id),
                title: canon.title,
                event_date: feEventDateForDb,
                event_type: event.is_person === false ? 'plant_pet' : event.event_type,
                related_member: storedRelatedMember || null,
                created_at: new Date().toISOString(),
                created_by: snapshot.userId,
              });
            }
          } else if (dupFe) {
            console.warn('[SameEventVoice] family_insert:skipped(dupFe)', { dupId: dupFe.id });
          }

          if (insertedEv?.id) {
            groupKeyToInsertedEventId.set(groupKey, String(insertedEv.id));
          }

          const amt = Number(event.amount) || 0;
          if (amt > 0 && insertedEv?.id) {
            financeFallbackFromEvents.push({
              title: canon.title,
              description: canonDescription,
              amount: amt,
              direction: 'expense',
              category: normalizeFinanceCategory(event.is_person === false ? 'plant_pet' : event.event_type),
              occurred_date: event.event_date,
              linked_event_id: String(insertedEv.id),
            });
          }
        }

        if ((event.height || event.weight) && event.related_member) {
          const krGrowth = resolveKinshipForRecordedEvent({
            members: snapshot.membersBrief || [],
            recorderLinkedRole: snapshot.recorderLinkedRole,
            modelRelatedMember: event.related_member || '',
            title: event.title,
            description: event.description,
            utteranceText: snapshot.text,
            isPerson: event.is_person !== false,
          });
          const relResolved = krGrowth.storedRelatedMember || event.related_member;
          const weightFromDesc = parseWeightKgFromDescription(event.description);
          const normalizedWeight = weightFromDesc ?? event.weight;
          const { data: childMember } = await supabase
            .from('family_members')
            .select('id')
            .eq('family_id', snapshot.familyId)
            .eq('name', relResolved)
            .single();
          const recordedDate = event.event_date || new Date().toISOString().split('T')[0];
          const { data: existingRecord } = await supabase
            .from('child_growth')
            .select('id')
            .eq('family_id', snapshot.familyId)
            .eq('child_name', relResolved)
            .eq('recorded_date', recordedDate)
            .single();
          if (existingRecord) {
            await supabase
              .from('child_growth')
              .update({
                height: event.height,
                weight: normalizedWeight,
              } as any)
              .eq('id', existingRecord.id);
          } else {
            await supabase.from('child_growth').insert({
              family_id: snapshot.familyId,
              child_member_id: childMember?.id || null,
              child_name: relResolved,
              recorded_date: recordedDate,
              height: event.height,
              weight: normalizedWeight,
              source: 'ai_extract',
              conversation_id: snapshot.conversationId,
            } as any);
          }
        }
      }
    }

    if (processEventReminderPath && hasEvents) {
      let dedupeCandidates: ReminderDedupeRow[] = [];
      if ((extractResult.reminders || []).length > 0) {
        dedupeCandidates = await fetchReminderDedupeCandidatesForVoice(snapshot.familyId);
        debugDiag.candidateCountRem = dedupeCandidates.length;
      }
      let localDedupeKey = 0;
      const processedReminderGroups = new Set<string>();
      for (const reminder of extractResult.reminders || []) {
        const relatedEvent = extractResult.events.find(e => e.id === reminder.event_id);
        if (!relatedEvent || relatedEvent.is_negative || relatedEvent.is_uncertain) continue;

        const groupKey = relatedEvent.group_id || relatedEvent.id;
        const reminderKey = `${groupKey}-${reminder.date_type}-${(reminder.recurring_days || []).join(',')}`;
        if (processedReminderGroups.has(reminderKey)) continue;
        processedReminderGroups.add(reminderKey);
        if (groupKeysSkipReminderDueToDupFe.has(groupKey) && !snapshot.forceCreateReminder) {
          dt(`[reminder] skip(dupFe): groupKey=${groupKey}`);
          continue;
        }
        if (groupKeysSkipReminderDueToDupFe.has(groupKey) && snapshot.forceCreateReminder) {
          dt(`[reminder] forceCreate despite dupFe: groupKey=${groupKey}`);
        }

        const scheduleText = [relatedEvent.title, relatedEvent.description, reminder.title, snapshot.text]
          .filter(Boolean)
          .join(' ');
        // 只从本轮用户文本+模型抽取结果里解析钟点，避免 recentMsgs 历史消息污染本次时间
        const parsedClock = snapshot.userSpecifiedConcreteTime
          ? extractClockFromChineseScheduleText(scheduleText)
          : null;
        const fallbackHour = 9;
        const hour = parsedClock?.hour ?? fallbackHour;
        const minute = parsedClock?.minute ?? 0;
        const rawBefore = reminder.remind_before_days;
        const beforeDays =
          rawBefore == null || Number.isNaN(Number(rawBefore))
            ? 0
            : Math.max(0, Math.floor(Number(rawBefore)));

        const userText = snapshot.text || '';
        const explicitEveryDay = /每天|每日|天天/.test(userText);
        const recurringType: ExtractedReminder['date_type'] =
          reminder.date_type === 'daily' && !explicitEveryDay ? 'once' : reminder.date_type;

        const explicitCal = hasExplicitCalendarInUserText(userText);
        let storedEventDate: string | null = reminder.event_date;

        const recentBlob = [scheduleText, snapshot.recentMsgs || ''].join('\n');
        const minutesOffsetFromNow =
          recurringType === 'once'
            ? parseMinutesOffsetFromNowFromChinese(userText) ??
              parseMinutesOffsetFromNowFromChinese(scheduleText)
            : null;
        let domFromModel: number | null = null;
        const ymdRem = getShanghaiYmdFromEventDateField(reminder.event_date);
        if (ymdRem) {
          const dom = parseInt(ymdRem.slice(8, 10), 10);
          if (Number.isFinite(dom) && dom >= 1 && dom <= 31) domFromModel = dom;
        }
        if (domFromModel == null) {
          const ymdRel = getShanghaiYmdFromEventDateField(relatedEvent.event_date);
          if (ymdRel) {
            const dom = parseInt(ymdRel.slice(8, 10), 10);
            if (Number.isFinite(dom) && dom >= 1 && dom <= 31) domFromModel = dom;
          }
        }
        const domParsed = parseDayOfMonthFromChineseText(recentBlob);
        /** 中文「15号」优先于模型里错误的 event_date 日份 */
        const dayOfMonth =
          domParsed != null && domParsed >= 1 && domParsed <= 31
            ? domParsed
            : domFromModel;

        let remindAt: Date;
        let usedMinutesOffsetFromNow = false;
        if (minutesOffsetFromNow != null && recurringType === 'once') {
          remindAt = new Date(Date.now() + minutesOffsetFromNow * 60 * 1000);
          storedEventDate = remindAt.toISOString();
          usedMinutesOffsetFromNow = true;
        } else if (recurringType === 'weekly' && reminder.recurring_days?.length) {
          const wd = Number(reminder.recurring_days[0]);
          const wn = Number.isFinite(wd) ? wd : 1;
          remindAt =
            getUpcomingShanghaiWeekdayOccurrence(wn, hour, minute, 0, Date.now()) ??
            dateFromShanghaiWallClock(addCalendarDaysShanghaiYmd(getShanghaiYmd(), 7), hour, minute);
        } else if (recurringType === 'monthly' && dayOfMonth != null) {
          const nextDueYmd = getNextMonthlyOccurrenceYmd(dayOfMonth, hour, minute, Date.now());
          storedEventDate = nextDueYmd;
          let targetYmd = nextDueYmd;
          if (beforeDays > 0) targetYmd = addCalendarDaysShanghaiYmd(nextDueYmd, -beforeDays);
          remindAt = dateFromShanghaiWallClock(targetYmd, hour, minute);
        } else if (parsedClock !== null && !explicitCal) {
          const todayYmd = getShanghaiYmd();
          remindAt = dateFromShanghaiWallClock(todayYmd, hour, minute);
          if (remindAt.getTime() <= Date.now()) {
            const tomorrowYmd = addCalendarDaysShanghaiYmd(todayYmd, 1);
            remindAt = dateFromShanghaiWallClock(tomorrowYmd, hour, minute);
          }
          storedEventDate = null;
        } else if (reminder.event_date) {
          const ymd =
            getShanghaiYmdFromEventDateField(reminder.event_date) ?? reminder.event_date.slice(0, 10);
          let targetYmd = ymd;
          if (beforeDays > 0) targetYmd = addCalendarDaysShanghaiYmd(ymd, -beforeDays);
          remindAt = dateFromShanghaiWallClock(targetYmd, hour, minute);
          if (recurringType === 'monthly' && (!storedEventDate || storedEventDate.length < 10)) {
            storedEventDate = ymd;
          }
        } else if (parsedClock !== null) {
          const todayYmd = getShanghaiYmd();
          remindAt = dateFromShanghaiWallClock(todayYmd, hour, minute);
          if (remindAt.getTime() <= Date.now()) {
            const tomorrowYmd = addCalendarDaysShanghaiYmd(todayYmd, 1);
            remindAt = dateFromShanghaiWallClock(tomorrowYmd, hour, minute);
          }
        } else {
          if (recurringType === 'monthly') {
            console.warn('[ExtractPersist] monthly without day-of-month in model/recent text, using +7d fallback');
          }
          remindAt = dateFromShanghaiWallClock(addCalendarDaysShanghaiYmd(getShanghaiYmd(), 7), 7, 0);
        }

        /** 按年续费：模型常给「今年已过」的锚点日，须滚到下一期否则会整段 skip 不落库 */
        if (remindAt.getTime() <= Date.now() && recurringType === 'yearly') {
          const anchor =
            getShanghaiYmdFromEventDateField(storedEventDate) ??
            getShanghaiYmdFromEventDateField(reminder.event_date) ??
            null;
          if (anchor) {
            const nextY = getNextYearlyOccurrenceYmd(anchor, hour, minute, Date.now());
            storedEventDate = nextY;
            let targetY = nextY;
            if (beforeDays > 0) targetY = addCalendarDaysShanghaiYmd(nextY, -beforeDays);
            remindAt = dateFromShanghaiWallClock(targetY, hour, minute);
          }
        }

        const rowCreatedAt = new Date();

        if (recurringType === 'once' && !usedMinutesOffsetFromNow) {
          const resolved = resolveOnceEventAndRemindAt({
            recurringType,
            reminder,
            relatedEvent,
            beforeDays,
            userText,
            recentBlob: scheduleText,  // 不含历史消息，避免 recentMsgs 中旧「提前X分」污染本轮
            parsedClock,
            storedEventDateAfterChain: storedEventDate,
            remindAtFromChain: remindAt,
            createdAt: rowCreatedAt,
          });
          if (resolved) {
            remindAt = resolved.remindAt;
            storedEventDate = resolved.eventDateIso;
          }
        }

        /**
         * 未说具体钟点时（不依赖模型，与 classify/extract prompt 一致）：
         * - 事项日「今天」→ event_date / remind_at 用发送时刻 rowCreatedAt
         * - 事项日明天及更远 → 事项 instant 为该日 07:00（上海）；remind_at 在通知日为「今天」时同样用发送时刻，否则该日 07:00
         */
        if (
          recurringType === 'once' &&
          !usedMinutesOffsetFromNow &&
          !snapshot.userSpecifiedConcreteTime
        ) {
          let ymdEvent: string | null = null;
          // 优先用模型原始 event_date（不受 resolveOnceEventAndRemindAt 污染），storedEventDate 放最后兜底
          for (const cand of [reminder.event_date, relatedEvent.event_date, storedEventDate]) {
            const y = getShanghaiYmdFromEventDateField(cand != null ? String(cand) : null);
            if (y) {
              ymdEvent = y;
              break;
            }
          }
          if (!ymdEvent) ymdEvent = getShanghaiYmdFromIso(remindAt.toISOString());
          const todayYmd = getShanghaiYmd(rowCreatedAt);
          // 用户明确说「明天/后天/大后天」但 event_date 被模型或链式逻辑写成今天或更早，强制修正
          const tomorrowKeyword = /明天|后天|大后天/.test(userText);
          if (tomorrowKeyword && ymdEvent <= todayYmd) {
            const daysAhead = /大后天/.test(userText) ? 3 : /后天/.test(userText) ? 2 : 1;
            ymdEvent = addCalendarDaysShanghaiYmd(todayYmd, daysAhead);
          }
          const notifyYmd =
            beforeDays > 0 ? addCalendarDaysShanghaiYmd(ymdEvent, -beforeDays) : ymdEvent;
          if (ymdEvent === todayYmd) {
            storedEventDate = rowCreatedAt.toISOString();
          } else {
            storedEventDate = dateFromShanghaiWallClock(ymdEvent, 7, 0).toISOString();
          }
          if (notifyYmd === todayYmd) {
            remindAt = rowCreatedAt;
          } else {
            remindAt = dateFromShanghaiWallClock(notifyYmd, 7, 0);
          }
          if (beforeDays > 0 && remindAt.getTime() < rowCreatedAt.getTime()) {
            remindAt = rowCreatedAt;
          }
        }

        const canonEv = groupKeyToCanonEvent.get(groupKey);
        const modelTitleRaw = String(reminder.title || relatedEvent.title || '').trim();
        // forceCreateReminder 时 snapshot.text 是上轮用户句（用于抽取），但本轮用户只说了确认短语，
        // 不应把上轮句子塞进 description，故强制不传 mergedText。
        const mergedTextForDisplay =
          !snapshot.forceCreateReminder &&
          snapshot.text.trim() !== snapshot.thisRoundUserText.trim()
            ? snapshot.text.trim()
            : undefined;
        // forceCreateReminder：用户本轮只说了「提醒我」等确认词，用 modelTitle 作为 userText 展示文本
        const displayUserText = snapshot.forceCreateReminder
          ? (modelTitleRaw || snapshot.thisRoundUserText)
          : snapshot.thisRoundUserText;
        const { title: reminderTitleCanon, description: reminderDescCanon } =
          reminderDisplayFromUserUtterance(
            displayUserText,
            modelTitleRaw,
            mergedTextForDisplay
          );
        const reminderRelated =
          (canonEv?.subjectName || relatedEvent.related_member || '').trim() || '';

        const insertedFamilyEventId = groupKeyToInsertedEventId.get(groupKey) ?? null;
        const evAmt = Number(relatedEvent.amount) || 0;
        const pendingFinance = evAmt > 0 && insertedFamilyEventId != null;

        const reminderRowForDedupe: Record<string, unknown> = {
          family_id: snapshot.familyId,
          created_by: snapshot.userId,
          title: reminderTitleCanon,
          description: reminderDescCanon,
          remind_at: remindAt.toISOString(),
          source_type: 'ai_extract',
          event_type: relatedEvent.event_type,
          related_member: reminderRelated,
          is_done: false,
          recurring_rule: recurringType === 'once' ? null : recurringType,
          recurring_days: reminder.recurring_days || null,
          event_date: storedEventDate,
        };
        if (pendingFinance) {
          reminderRowForDedupe.pending_expense_amount = evAmt;
          reminderRowForDedupe.pending_expense_category = normalizeFinanceCategory(
            relatedEvent.is_person === false ? 'plant_pet' : relatedEvent.event_type
          );
          reminderRowForDedupe.linked_event_id = insertedFamilyEventId;
        }

        const dedupeIncoming = {
          title: String(reminderRowForDedupe.title || ''),
          description: reminderRowForDedupe.description != null ? String(reminderRowForDedupe.description) : null,
          remind_at: String(reminderRowForDedupe.remind_at),
          event_date: reminderRowForDedupe.event_date != null ? String(reminderRowForDedupe.event_date) : null,
          recurring_rule: (reminderRowForDedupe.recurring_rule as string | null) ?? null,
          recurring_days: (reminderRowForDedupe.recurring_days as number[] | null) ?? null,
          event_type: String(reminderRowForDedupe.event_type || 'daily'),
          related_member: String(reminderRowForDedupe.related_member || ''),
          pending_expense_amount:
            reminderRowForDedupe.pending_expense_amount != null
              ? Number(reminderRowForDedupe.pending_expense_amount)
              : undefined,
          pending_expense_category:
            reminderRowForDedupe.pending_expense_category != null
              ? String(reminderRowForDedupe.pending_expense_category)
              : undefined,
          linked_event_id:
            reminderRowForDedupe.linked_event_id != null ? String(reminderRowForDedupe.linked_event_id) : undefined,
        };
        /** 须先于 pastRemindAt：否则「今天的提醒时刻已过现在」会先 continue，永远走不到去重口播 */
        const dup = findDuplicateAiReminder(dedupeIncoming, dedupeCandidates);
        if (dup && !debugDiag.dupRemId) debugDiag.dupRemId = dup.id;
        console.warn('[SameEventVoice] reminder_dedupe', {
          dupId: dup?.id ?? null,
          title: (dedupeIncoming.title || '').slice(0, 80),
          candN: dedupeCandidates.length,
          remind_at: dedupeIncoming.remind_at,
        });
        if (dup) {
          const sameRel = strictSameRelatedForVoice(dup.related_member, reminderRelated);
          const sameMom = strictSameRemindMomentForVoice(dup, dedupeIncoming);
          const timeMatchMinute = isSameRemindAtShanghaiMinute(dup.remind_at, dedupeIncoming.remind_at);
          console.warn('[SameEventVoice] reminder_dupBranch', {
            sameRel,
            sameMom,
            timeMatchMinute,
            branch:
              sameRel && !timeMatchMinute
                ? 'ask_update_time_minute'
                : sameRel && sameMom
                  ? 'already_recorded'
                  : 'ask_update',
            dbRelated: dup.related_member,
            newRelated: reminderRelated,
          });
          /** 人物一致但库中 remind_at 与本轮抽取到分钟不一致：禁止「已记过」，改问是否改时间（与 strictSameRemindMoment 互补兜底） */
          if (sameRel && !timeMatchMinute) {
            if (!sameEventVoiceHint) {
              const vr = voiceRec(dup.created_by);
              sameEventVoiceHint = buildReminderTimeUpdateVoiceHint(dup, dedupeIncoming, vr);
            }
            reminderLines.push(
              `（口播：同一件事提醒时刻与库中不一致；本轮不写入，请用户确认是否按新时间更新）「${(dup.title || '提醒').slice(0, 80)}」`,
            );
            continue;
          }
          if (sameRel && sameMom) {
            const locationChanged = sameEventLocationCueChanged(dup.title, reminderTitleCanon);
            if (!locationChanged) {
              if (!sameEventVoiceHint) {
                const vr = voiceRec(dup.created_by);
                sameEventVoiceHint = {
                  kind: 'already_recorded',
                  summary: dup.title,
                  scope: 'reminder',
                  diffType: 'exact',
                  recorderIsSelf: vr.recorderIsSelf,
                  recorderDisplayName: vr.recorderDisplayName,
                };
              }
              reminderLines.push(
                `（口播：同一件事，提醒已在库中；本轮不写入）「${(dup.title || '提醒').slice(0, 80)}」`,
              );
            } else {
              const oldPerson = (dup.related_member && String(dup.related_member).trim()) || '（未填写）';
              const newPerson = (reminderRelated && String(reminderRelated).trim()) || '（未填写）';
              const oldT = voiceReminderTimeLabel({
                remind_at: dup.remind_at,
                event_date: dup.event_date,
              });
              const newT = voiceReminderTimeLabel({
                remind_at: String(reminderRowForDedupe.remind_at),
                event_date: reminderRowForDedupe.event_date != null ? String(reminderRowForDedupe.event_date) : null,
              });
              const oldPl = extractPlaceCueForSameEvent(dup.title) || dup.title.slice(0, 20).trim();
              const newPl = extractPlaceCueForSameEvent(reminderTitleCanon) || reminderTitleCanon.slice(0, 20).trim();
              const vr = voiceRec(dup.created_by);
              sameEventVoiceHint = {
                kind: 'ask_update',
                scope: 'reminder',
                diffType: 'location',
                previousSummary: dup.title,
                oldPersonLabel: oldPerson,
                newPersonLabel: newPerson,
                oldTimeLabel: oldT,
                newTimeLabel: newT,
                oldPlaceLabel: oldPl,
                newPlaceLabel: newPl,
                personChanged: false,
                timeChanged: false,
                locationChanged: true,
                recorderIsSelf: vr.recorderIsSelf,
                recorderDisplayName: vr.recorderDisplayName,
              };
              reminderLines.push('（口播：同一件事去处表述不同；本轮不写入，请用户一句确认）');
            }
          } else {
            const personChanged = !sameRel;
            const timeChanged = !sameMom;
            const locationChanged = false;
            const diffType = pickAskUpdateDiffType({ timeChanged, personChanged, locationChanged });
            const oldPerson = (dup.related_member && String(dup.related_member).trim()) || '（未填写）';
            const newPerson = (reminderRelated && String(reminderRelated).trim()) || '（未填写）';
            const oldT = voiceReminderTimeLabel({
              remind_at: dup.remind_at,
              event_date: dup.event_date,
            });
            const newT = voiceReminderTimeLabel({
              remind_at: String(reminderRowForDedupe.remind_at),
              event_date: reminderRowForDedupe.event_date != null ? String(reminderRowForDedupe.event_date) : null,
            });
            const oldPl = extractPlaceCueForSameEvent(dup.title) || dup.title.slice(0, 20).trim();
            const newPl = extractPlaceCueForSameEvent(reminderTitleCanon) || reminderTitleCanon.slice(0, 20).trim();
            const vr = voiceRec(dup.created_by);
            sameEventVoiceHint = {
              kind: 'ask_update',
              scope: 'reminder',
              diffType,
              previousSummary: dup.title,
              oldPersonLabel: oldPerson,
              newPersonLabel: newPerson,
              oldTimeLabel: oldT,
              newTimeLabel: newT,
              oldPlaceLabel: oldPl,
              newPlaceLabel: newPl,
              personChanged,
              timeChanged,
              locationChanged,
              recorderIsSelf: vr.recorderIsSelf,
              recorderDisplayName: vr.recorderDisplayName,
            };
            reminderLines.push(`（口播：同一件事与库中有差异·${diffType}；本轮不写入，请用户一句确认）`);
          }
          continue;
        }

        if (remindAt.getTime() <= Date.now()) {
          /** 与 createdAt 相差仅数十秒内易被算成「已过期」；顺延 1 分钟仍落库，避免误杀 */
          const bumped = new Date(Date.now() + 60_000);
          if (bumped.getTime() - remindAt.getTime() < 180_000) {
            remindAt = bumped;
          } else {
            const skipPast = {
              title: String(reminder.title || '').slice(0, 80),
              remindAt: remindAt.toISOString(),
            };
            console.warn('[SameEventVoice] reminder_skip:pastRemindAt', skipPast);
            dt(`reminder_skip:pastRemindAt ${JSON.stringify(skipPast)}`);
            console.log('[ExtractPersist] skip past remindAt:', remindAt.toISOString());
            continue;
          }
        }

        const reminderRow: Record<string, unknown> = {
          family_id: snapshot.familyId,
          created_by: snapshot.userId,
          created_at: rowCreatedAt.toISOString(),
          updated_at: rowCreatedAt.toISOString(),
          title: reminderTitleCanon,
          description: reminderDescCanon,
          remind_at: remindAt.toISOString(),
          source_type: 'ai_extract',
          event_type: relatedEvent.event_type,
          related_member: reminderRelated,
          is_done: false,
          recurring_rule: recurringType === 'once' ? null : recurringType,
          recurring_days: reminder.recurring_days || null,
          event_date: storedEventDate,
        };
        if (pendingFinance) {
          reminderRow.pending_expense_amount = evAmt;
          reminderRow.pending_expense_category = normalizeFinanceCategory(
            relatedEvent.is_person === false ? 'plant_pet' : relatedEvent.event_type
          );
          reminderRow.linked_event_id = insertedFamilyEventId;
        }

        stats.reminderInserted += 1;
        reminderPersistOps.push({ kind: 'insert', row: reminderRow });
        upsertCandidateAfterInsert(
          dedupeCandidates,
          reminderRowToDedupeRow(`local-${++localDedupeKey}`, reminderRow),
        );
        reminderLines.push(
          formatInjectLineForReminder({
            title: reminderTitleCanon,
            remind_at: remindAt.toISOString(),
            event_date: storedEventDate,
            recurring_rule: recurringType === 'once' ? null : recurringType,
            recurring_days: reminder.recurring_days || null,
          }),
        );
        didInsertReminder = true;
        if (recurringType === 'monthly' && relatedEvent.event_type === 'finance') {
          shouldDedupeMonthlyFinance = true;
        }

        if (pendingFinance) {
          deferredPendingFinance.push({
            amount: evAmt,
            title: (canonEv?.title || relatedEvent.title || reminder.title || '').trim(),
          });
          deferredLinkedEventIds.add(insertedFamilyEventId!);
        }
      }
    }

    const modelTx = (extractResult.finance_transactions || []).filter(
      t => t && Number(t.amount) > 0 && t.title
    );
    const financeRows =
      modelTx.length > 0
        ? filterOutDeferredExpenseRows(
            modelTx.map(t => ({
              title: String(t.title).trim(),
              description: (t.description && String(t.description).trim()) || '',
              amount: Number(t.amount),
              direction: (t.direction === 'income' ? 'income' : 'expense') as 'income' | 'expense',
              category: normalizeFinanceCategory(t.category),
              occurred_date: t.occurred_date,
              linked_event_id: null as string | null,
            })),
            deferredPendingFinance
          )
        : financeFallbackFromEvents.filter(
            row => !row.linked_event_id || !deferredLinkedEventIds.has(row.linked_event_id)
          );

    for (const row of financeRows) {
      financeLines.push(`${row.title} ¥${row.amount}（${row.direction === 'income' ? '收入' : '支出'}）`);
    }

    const hasDbPayload =
      reminderLines.length > 0 || financeLines.length > 0 || familyEventLines.length > 0;

    // 「提醒我」强制创建提醒场景：事件去重命中（scope=family_event）但提醒已成功入库，
    // 不能再用「没有任何数据库写入」的口播；改为仅报告已写入的内容
    if (
      snapshot.forceCreateReminder &&
      didInsertReminder &&
      sameEventVoiceHint?.kind === 'already_recorded' &&
      sameEventVoiceHint.scope === 'family_event'
    ) {
      dt('[prepare] forceCreateReminder: 清除 already_recorded 口播（提醒已写入）');
      sameEventVoiceHint = null;
    }

    if (!hasDbPayload && !sameEventVoiceHint) {
      dt(`earlyExit:emptyInject stats=${JSON.stringify(stats)}`);
      debugDiag.writeBlocked = 'early_exit_empty_inject';
      attachReminderDebugToDiag(debugDiag, extractResult, reminderPersistOps);
      return { injectText: '', persist: noop, stats, sameEventVoiceHint: null, debugTrace, debugDiag };
    }

    let injectText = '';
    if (sameEventVoiceHint) {
      injectText = buildSameEventVoiceInject(
        sameEventVoiceHint,
        sameEventVoiceRecordedByForInject(sameEventVoiceHint)
      );
    }
    if (hasDbPayload) {
      injectText += sameEventVoiceHint
        ? '\n\n【本条其它将写入数据库的内容】\n'
        : '\n\n【本轮将写入数据库的事实（与 App「记录/提醒」页一致；后台写入完成后即生效）】\n' +
          '你必须严格按下述内容向用户确认时间与周期；**禁止**另行编造、凑整或与下列不符的日期。若下列未列出某项，**不要**声称已写入该项。\n';
      if (familyEventLines.length > 0) {
        injectText +=
          '家庭记录：\n' + familyEventLines.map((line, i) => `${i + 1}. ${line}`).join('\n') + '\n';
      }
      if (reminderLines.length > 0) {
        injectText +=
          '提醒：\n' + reminderLines.map((line, i) => `${i + 1}. ${line}`).join('\n') + '\n';
      }
      if (financeLines.length > 0) {
        injectText += '财务流水：\n' + financeLines.map((line, i) => `${i + 1}. ${line}`).join('\n') + '\n';
      }
    }

    dt(
      `done hint=${sameEventVoiceHint?.kind ?? 'null'} scope=${sameEventVoiceHint && 'scope' in sameEventVoiceHint ? sameEventVoiceHint.scope : '-'} injectChars=${injectText.length} db=${hasDbPayload} rLines=${reminderLines.length} feLines=${familyEventLines.length}`
    );

    const willWrite =
      reminderPersistOps.length > 0 ||
      financeRows.length > 0 ||
      stats.familyEventInserted > 0;
    if (sameEventVoiceHint && !willWrite) {
      debugDiag.writeBlocked = 'blocked_extract_dup_voice_only';
    } else if (sameEventVoiceHint && willWrite) {
      debugDiag.writeBlocked = 'voice_hint_plus_other_writes';
    } else if (willWrite) {
      debugDiag.writeBlocked = 'normal_persist';
    } else {
      debugDiag.writeBlocked = 'no_persist_ops';
    }

    attachReminderDebugToDiag(debugDiag, extractResult, reminderPersistOps);

    const persist = async (): Promise<ExtractPersistOutcome> => {
      const insertedReminderRemindAt: string[] = [];
      const persistDiagnosisLines: string[] = [];
      const failedItems: string[] = [];
      try {
        for (const op of reminderPersistOps) {
          if (op.kind === 'insert') {
            const reminderPayload = op.row;
            const insertLine = `[DEBUG][reminder] about to insert: ${JSON.stringify(reminderPayload)}`;
            console.log(insertLine);
            persistDiagnosisLines.push(insertLine);
            const { error } = await supabase.from('reminders').insert(op.row as any);
            if (error) {
              console.error('[ExtractPersist] reminder insert failed:', error.message, error);
              persistDiagnosisLines.push(`[DEBUG][reminder] insert error: ${error.message}`);
              const tRaw = reminderPayload.title;
              const tStr = typeof tRaw === 'string' ? tRaw : String(tRaw ?? '');
              failedItems.push(`提醒「${tStr.slice(0, 80)}」保存失败`);
              continue;
            }
            const iso = op.row.remind_at;
            if (typeof iso === 'string' && iso.length > 0) insertedReminderRemindAt.push(iso);
          }
        }
        if (shouldDedupeMonthlyFinance) {
          await dedupeAiMonthlyFinanceReminders(snapshot.familyId);
        }
        for (const row of financeRows) {
          const { error: finErr } = await supabase.from('finance_transactions').insert({
            family_id: snapshot.familyId,
            created_by: snapshot.userId,
            conversation_id: snapshot.conversationId,
            linked_event_id: row.linked_event_id,
            title: row.title.slice(0, 200),
            description: row.description ? row.description.slice(0, 2000) : null,
            amount: row.amount,
            direction: row.direction,
            category: row.category,
            occurred_at: occurredAtISO(row.occurred_date),
            source: 'ai_extract',
          } as any);
          if (finErr) {
            console.error('[ExtractPersist] finance_transactions insert failed:', finErr.message, finErr);
            persistDiagnosisLines.push(`[DEBUG][finance] insert error: ${finErr.message}`);
            failedItems.push(`财务记录「${(row.title || '').slice(0, 80)}」保存失败`);
          }
        }
        if (didInsertReminder) {
          await scheduleAllReminders();
        }
      } catch (e) {
        console.error('[ExtractPersist] 延后写入失败:', e);
        const msg = e instanceof Error ? e.message : String(e);
        persistDiagnosisLines.push(`[persist] catch: ${msg}`);
        failedItems.push(`写入过程异常：${msg.slice(0, 120)}`);
      }
      if (reminderPersistOps.length === 0) {
        persistDiagnosisLines.push('[persist] reminderPersistOps 为空，未执行 reminder insert');
      } else if (!persistDiagnosisLines.some(l => l.includes('[DEBUG][reminder]'))) {
        persistDiagnosisLines.push(
          '[persist] 无 about to insert 行（可能已在 prepare 阶段被去重/跳过）'
        );
      }
      return { insertedReminderRemindAt, persistDiagnosisLines, failedItems };
    };

    return {
      injectText,
      persist,
      stats,
      sameEventVoiceHint,
      debugTrace,
      debugDiag,
      // dupFe 阻断了提醒（事件已在库中但提醒未写入），保存 extractResult 供下一轮「提醒我」复用
      extractResultForReuse:
        groupKeysSkipReminderDueToDupFe.size > 0 && reminderPersistOps.length === 0
          ? extractResult
          : undefined,
    };
  } catch (e) {
    console.error('[ExtractPrepare] 失败:', e);
    dt(`catch ${e instanceof Error ? e.message : String(e)}`);
    return {
      injectText: '',
      persist: noop,
      stats,
      sameEventVoiceHint: null,
      debugTrace,
      debugDiag: {
        quickDedupHit: null,
        extractOutput: '(error)',
        candidateCountFe: 0,
        candidateCountRem: 0,
        dupFeId: null,
        dupRemId: null,
        writeBlocked: `prepare_catch:${e instanceof Error ? e.message : String(e)}`,
        skipWrite: false,
        skipReminder: false,
        reminderOpsCount: 0,
        reminderOpsDetail: [],
        extractRemindersRaw: [],
      },
    };
  }
}

const markdownStyles = {
  hr: { backgroundColor: colors.hairline, height: 1, marginVertical: 8 },
  body: { fontSize: 15, lineHeight: 22, color: colors.foreground },
  heading1: { fontSize: 17, fontWeight: '700' as const, color: colors.foreground, marginVertical: 6 },
  heading2: { fontSize: 16, fontWeight: '700' as const, color: colors.foreground, marginVertical: 4 },
  strong: { fontWeight: '700' as const, color: colors.foreground },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { marginVertical: 2 },
  paragraph: { marginVertical: 2 },
};

/** 底部输入框固定高度（不随字数增高，多行在框内滚动；与 style.input paddingVertical 10×2 + 一行字高相当） */
const INPUT_LINE_HEIGHT = 22;
const INPUT_PADDING_V = 10; // paddingVertical in input style
const INPUT_MIN_H = INPUT_LINE_HEIGHT + INPUT_PADDING_V * 2; // 1 行
const INPUT_MAX_H = INPUT_LINE_HEIGHT * 6 + INPUT_PADDING_V * 2; // 6 行

/**
 * iOS：KAV 内 keyboardVerticalOffset 越大，避让越「过头」，输入条与键盘之间空白越大。
 * 顶栏已在 KAV 外，此处保持 0；若个别机型输入条被键盘盖住再小幅上调。
 */
const CHAT_KEYBOARD_VERTICAL_OFFSET = 0;

export default function ChatScreen() {
  const { conversationId, title: initialTitle } = useLocalSearchParams<{
    conversationId: string;
    title: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  /** 键盘显示时不应再叠一层底部安全区，否则会与键盘避让叠加成「输入条离键盘很远」 */
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  /** 新对话删光字后快捷引导再现时 bump，令 KeyboardAvoidingView 重挂以便重新计算键盘避让 */
  const [composerKavRemountNonce, setComposerKavRemountNonce] = useState(0);
  const prevShowQuickStartRef = useRef<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAiReplying, setIsAiReplying] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [authUserId, setUserId] = useState<string | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [conversationTitle, setConversationTitle] = useState(initialTitle || '对话');
  const [newMemberName, setNewMemberName] = useState<string | null>(null);
  const [showNewMemberModal, setShowNewMemberModal] = useState(false);
  const [isFirstMessage, setIsFirstMessage] = useState(false);
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [showVoiceModal, setShowVoiceModal] = useState(false);
  const [voiceModalText, setVoiceModalText] = useState('');
  const [voiceModalEnvError, setVoiceModalEnvError] = useState<string | null>(null);
  const [inputHeight, setInputHeight] = useState(INPUT_MIN_H);
  /** 抽取/去重诊断（不依赖 Metro 控制台） */
  const [extractDebugText, setExtractDebugText] = useState('');
  const [extractDebugModalOpen, setExtractDebugModalOpen] = useState(false);
  const [accessTier, setAccessTier] = useState<AccessTier | null>(null);
  const accessTierRef = useRef<AccessTier | null>(null);

  useEffect(() => {
    accessTierRef.current = accessTier;
  }, [accessTier]);

  const listRef = useRef<FlatList<ChatMessage> | null>(null);
  /** 用户上滑看历史时为 false；仅 true 时响应 onContentSizeChange 自动 scrollToEnd，避免 Android 正式包频繁重算高度把列表锁在底部 */
  const stickToBottomRef = useRef(true);
  /** 发送后键盘收起/布局抖动时 onScroll 会误判「不在bottom」，短时间内勿把 stickToBottomRef 置 false */
  const suppressStickBottomResetUntilRef = useRef(0);
  /**
   * 首屏/换会话后：FlatList 初帧 contentHeight 常为 0，scrollToEnd 无效；须在 onContentSizeChange 中反复滚底直至 Markdown/图片撑高完成。
   */
  const pendingInitialScrollToEndRef = useRef(false);

  const scheduleScrollToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    setShowScrollBtn(false);
    suppressStickBottomResetUntilRef.current = Date.now() + 700;
    const tick = (animated: boolean) => {
      listRef.current?.scrollToEnd({ animated });
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        tick(false);
        setTimeout(() => tick(false), 48);
        setTimeout(() => tick(true), 160);
      });
    });
  }, []);

  /** 首屏：避免 onScroll 抢先篡改 stickToBottom；拉长 suppress + pending，让 onContentSizeChange 接力滚底 */
  useLayoutEffect(() => {
    if (loading) return;
    pendingInitialScrollToEndRef.current = true;
    stickToBottomRef.current = true;
    suppressStickBottomResetUntilRef.current = Date.now() + 3200;
    scheduleScrollToBottom();
  }, [loading, conversationId, scheduleScrollToBottom]);

  useEffect(() => {
    if (loading) return;
    const timeouts = [120, 350, 800, 1600].map(ms =>
      setTimeout(() => {
        if (pendingInitialScrollToEndRef.current) {
          listRef.current?.scrollToEnd({ animated: false });
        }
      }, ms)
    );
    const done = setTimeout(() => {
      pendingInitialScrollToEndRef.current = false;
    }, 3000);
    return () => {
      timeouts.forEach(clearTimeout);
      clearTimeout(done);
    };
  }, [loading, conversationId]);

  const baseInputRef = useRef('');
  const inputRef = useRef<TextInput>(null);
  const stopRecordingRef = useRef<(() => Promise<string | null>) | null>(null);
  const idRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 防止连续触发 send（连点发送/键盘发送叠按）导致上一轮 fetch 被 abort，误判「超时」 */
  const sendInFlightRef = useRef(false);
  /** 与 AbortError 对应：区分用户停止 / 客户端超时 / 被新发送顶替 */
  const aiAbortReasonRef = useRef<AiAbortReason | null>(null);
  const stoppedRef = useRef(false);
  const currentRequestId = useRef(0);
  /**
   * 上一轮 quickDedupCheck 命中时，保存当时的用户原文（非短确认句）。
   * 下一轮用户说「提醒我」等短句时，直接用这段文本作为 extractTextForExtract。
   */
  const lastDedupBlockedUserTextRef = useRef<string | null>(null);
  /**
   * 上一轮 prepareExtractInjectAndPersist 因 dupFe（事件已在库中）阻断提醒写入时，
   * 保存当时抽取到的 ExtractResult（含 events + reminders）。
   * 下一轮「提醒我」时直接作为 extractResultOverride 传入，避免重新 extract 返回空。
   */
  const lastDupFeExtractResultRef = useRef<ExtractResult | null>(null);
  const cacheRef = useRef<{
    familyId: string | null;
    familyMembersStr: string;
    historyStr: string;
    members: { name: string; role: string; linked_user_id?: string | null; notes?: string | null }[];
    recorderLabelByUserId: Record<string, string>;
    userIdToAppRole: Record<string, string>;
    userName: string;
    lastFetched: number;
  } | null>(null);
  const makeId = (prefix: 'u' | 'a') => {
    idRef.current += 1;
    return `${prefix}-${Date.now()}-${idRef.current}`;
  };

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  /** 已有用户消息或非欢迎语的助手消息时视为「有聊天记录」，隐藏快捷引导 */
  const hasMessages = useMemo(
    () =>
      messages.some(
        m => m.role === 'user' || (m.role === 'assistant' && m.id !== 'welcome')
      ),
    [messages]
  );
  const showQuickStartPanel = !hasMessages && input.trim() === '';

  const handleQuickPick = useCallback((text: string) => {
    setInput(text);
    baseInputRef.current = text;
  }, []);

  useEffect(() => {
    const showEv = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEv = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subShow = Keyboard.addListener(showEv, () => {
      setKeyboardOpen(true);
      setTimeout(() => {
        if (stickToBottomRef.current) {
          listRef.current?.scrollToEnd({ animated: false });
        }
      }, 100);
    });
    const subHide = Keyboard.addListener(hideEv, () => setKeyboardOpen(false));
    return () => {
      subShow.remove();
      subHide.remove();
    };
  }, []);

  useLayoutEffect(() => {
    prevShowQuickStartRef.current = null;
  }, [conversationId]);

  useEffect(() => {
    const prev = prevShowQuickStartRef.current;
    prevShowQuickStartRef.current = showQuickStartPanel;
    if (prev === null) return;
    if (showQuickStartPanel && !prev && keyboardOpen) {
      setComposerKavRemountNonce(n => n + 1);
      stickToBottomRef.current = true;
      suppressStickBottomResetUntilRef.current = Date.now() + 500;
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: false });
        setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 80);
      });
    }
  }, [showQuickStartPanel, keyboardOpen]);

  // 卸载时停止录音
  useEffect(() => {
    return () => {
      stopRecordingRef.current?.();
    };
  }, []);

  /** 已识别文本的累计前缀（追加录音时使用） */
  const voiceAccumulatedRef = useRef('');

  /** 开始一轮录音，识别完成后追加到累计文本 */
  const beginVoiceRound = useCallback(() => {
    let cancelled = false;
    (async () => {
      setIsRecognizing(true);

      const handle = await startRecording((state: AsrState) => {
        if (cancelled) return;
        switch (state.status) {
          case 'recording':
            setIsRecognizing(true);
            break;
          case 'transcribing':
            setIsRecognizing(false);
            setVoiceModalText(
              voiceAccumulatedRef.current
                ? voiceAccumulatedRef.current + ' 识别中…'
                : '识别中…'
            );
            break;
          case 'done': {
            setIsRecognizing(false);
            const newPart = state.text?.trim() || '';
            const accumulated = voiceAccumulatedRef.current;
            const endsWithPunct = accumulated && /[。？！，、；：,.?!;]$/.test(accumulated);
            const combined = accumulated
              ? (newPart ? accumulated + (endsWithPunct ? '' : '，') + newPart : accumulated)
              : newPart;
            voiceAccumulatedRef.current = combined;
            setVoiceModalText(combined);
            break;
          }
          case 'error':
            setIsRecognizing(false);
            setVoiceModalEnvError(state.message);
            break;
        }
      });

      if (cancelled) {
        handle?.stop();
        return;
      }

      if (!handle) {
        setIsRecognizing(false);
        setVoiceModalEnvError('录音启动失败，请稍后重试。');
        return;
      }

      stopRecordingRef.current = handle.stop;
    })();

    return () => { cancelled = true; };
  }, []);

  // 语音输入模态：打开后请求权限并开始录音，关闭时停止录音
  useEffect(() => {
    if (!showVoiceModal) {
      // 模态关闭：若仍在录音则停止（丢弃本轮结果，保留已累计文本）
      const stopper = stopRecordingRef.current;
      if (stopper) {
        stopRecordingRef.current = null;
        stopper();
      }
      setIsRecognizing(false);
      return;
    }

    // 重置累计
    voiceAccumulatedRef.current = '';
    setVoiceModalText('');

    let cancelled = false;
    (async () => {
      const granted = await requestMicPermission();
      if (cancelled) return;
      if (!granted) {
        setVoiceModalEnvError('需要麦克风权限才能语音识别。请在系统设置中允许本应用使用麦克风。');
        return;
      }
      const cleanup = beginVoiceRound();
      return cleanup;
    })();

    return () => { cancelled = true; };
  }, [showVoiceModal, beginVoiceRound]);

  const refreshAiPerms = useCallback(async (): Promise<{
    userId: string;
    accessTier: AccessTier | null;
  } | null> => {
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id ?? null;
    setUserId(uid);
    if (!uid) {
      setAccessTier(null);
      return null;
    }
    const SEL =
      'access_tier, perm_ai_full, perm_ai_limited, perm_upload, perm_reminder, perm_view_files';
    const SEL_NO = 'perm_ai_full, perm_ai_limited, perm_upload, perm_reminder, perm_view_files';
    let ur: Parameters<typeof deriveAccessTierFromLegacyPerms>[0] = null;
    const rTier = await supabase.from('users').select(SEL).eq('id', uid).maybeSingle();
    if (rTier.error && isMissingAccessTierColumnError(rTier.error)) {
      const rNo = await supabase.from('users').select(SEL_NO).eq('id', uid).maybeSingle();
      if (rNo.error) {
        setAccessTier(null);
        return null;
      }
      ur = rNo.data;
    } else if (rTier.error) {
      setAccessTier(null);
      return null;
    } else {
      ur = rTier.data;
    }
    const tier = deriveAccessTierFromLegacyPerms(ur);
    setAccessTier(tier);
    if (__DEV__) {
      console.log('[Chat][refreshAiPerms]', { userId: uid, access_tier: tier });
    }
    return { userId: uid, accessTier: tier };
  }, []);

  useEffect(() => {
    void refreshAiPerms();
  }, [refreshAiPerms]);

  useFocusEffect(
    useCallback(() => {
      void refreshAiPerms();
      // 页面重新聚焦时重置发送锁，防止正式包异常退出后锁死
      sendInFlightRef.current = false;
    }, [refreshAiPerms])
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') void refreshAiPerms();
    });
    return () => sub.remove();
  }, [refreshAiPerms]);

  useEffect(
    () =>
      subscribeChatFamilyContextCacheInvalidate(() => {
        cacheRef.current = null;
      }),
    []
  );

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    (async () => {
      const t0 = Date.now();
      console.log('[Chat] load messages start:', conversationId);
      try {
        const { data, error } = await supabase
          .from('messages').select('*')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: true });

        if (error) {
          console.error('[Chat] load messages error:', error.message);
          return;
        }
        if (cancelled) return;

        const mapDbRowToChat = (m: any): ChatMessage => {
          if (m.role === 'user') {
            try {
              const parsed = JSON.parse(m.content);
              if (parsed.__type === 'file') {
                console.log('file msg:', parsed.fileType, parsed.fileUri);
                return {
                  id: m.id,
                  role: 'user' as Role,
                  text: parsed.fileName,
                  fileType: parsed.fileType as 'image' | 'pdf' | 'other',
                  fileUri: parsed.fileUri,
                  fileName: parsed.fileName,
                };
              }
            } catch {}
            return { id: m.id, role: 'user' as Role, text: m.content };
          }
          try {
            const ap = JSON.parse(m.content);
            if (ap.__type === 'reminder_cancel_pick' && Array.isArray(ap.choices)) {
              return {
                id: m.id,
                role: 'assistant' as Role,
                text: typeof ap.intro === 'string' ? ap.intro : '',
                reminderCancelChoices: ap.choices.map((c: any) => ({
                  id: String(c.id),
                  title: String(c.title || ''),
                  remindAtLabel: String(c.remindAtLabel || ''),
                })),
              };
            }
          } catch {}
          return {
            id: m.id,
            role: 'assistant' as Role,
            text: m.content
              .replace(/```json[\s\S]*?```/gi, '')
              .replace(/\{[\s\S]*?"title"[\s\S]*?\}/g, '')
              .replace(/[（(][^）)]*[）)]/g, '')
              .trim(),
          };
        };

        if (data && data.length > 0) {
          if (cancelled) return;
          setMessages(prev => {
            const hasLocalInFlight =
              sendInFlightRef.current ||
              prev.some(x => x.pending) ||
              prev.some(
                x =>
                  typeof x.id === 'string' &&
                  (x.id.startsWith('u-') || x.id.startsWith('a-'))
              );
            if (hasLocalInFlight) {
              console.log('[Chat] load messages: merge with local in-flight / client ids');
              return mergeServerChatRowsWithLocal(data, prev, mapDbRowToChat);
            }
            return data.map(mapDbRowToChat);
          });
          setIsFirstMessage(false);
        } else {
          const welcomeText =
            '你好！我是**家厘**。\n\n生活里那些值得留下来的事，说给我听就好。';
          setMessages([{ id: 'welcome', role: 'assistant', text: welcomeText }]);
          setIsFirstMessage(true);
        }
      } catch (e) {
        console.error('[Chat] load messages exception:', e);
      } finally {
        console.log('[Chat] load messages end, ms:', Date.now() - t0);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const updateTitleFromFirstMessage = async (userText: string, apiKey: string) => {
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-chat', max_tokens: 20, temperature: 0,
          messages: [{ role: 'user', content: `用不超过8个字总结这句话的主题，只输出主题词，不加标点：「${userText}」` }],
        }),
      });
      const data = await res.json();
      const newTitle = data.choices?.[0]?.message?.content?.trim() || '';
      if (newTitle && conversationId) {
        await supabase.from('conversations').update({ title: newTitle } as any).eq('id', conversationId);
        setConversationTitle(newTitle);
      }
    } catch (e) {
      console.error('标题生成失败:', e);
    }
  };

  // ── 文件上传 ──────────────────────────────────────
  const uploadFile = async (uri: string, fileName: string, mimeType: string, docType: string) => {
    if (!authUserId) return;
    const { data: userData } = await supabase.from('users').select('family_id').eq('id', authUserId).single();
    const fid = userData?.family_id;
    if (!fid) return;
  
    const tempId = makeId('u');
    const fileMsg: ChatMessage = {
      id: tempId,
      role: 'user',
      text: fileName,
      fileType: docType as 'image' | 'pdf' | 'other',
      fileUri: uri,
      fileName: fileName,
      pending: true,
    };
    setMessages(prev => [...prev, fileMsg]);
    scheduleScrollToBottom();

    try {
      const base64 = await readFileAsBase64(uri, fileName);
      const ext = fileName.split('.').pop()?.toLowerCase() || 'bin';
      const filePath = `${fid}/${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from('family-documents')
        .upload(filePath, decodeBase64ToUint8(base64), { contentType: mimeType });
  
      if (uploadError) throw uploadError;
  
      const { data: urlData } = supabase.storage.from('family-documents').getPublicUrl(filePath);
      const publicUrl = urlData.publicUrl;
  
      await supabase.from('documents').insert({
        family_id: fid, uploaded_by: authUserId,
        title: fileName, doc_type: docType, file_url: publicUrl,
      } as any);
  
      await supabase.from('messages').insert({
        role: 'user',
        content: JSON.stringify({ __type: 'file', fileType: docType, fileUri: publicUrl, fileName }),
        conversation_id: conversationId,
      } as any);
  
      setMessages(prev => prev.map(m =>
        m.id === tempId ? { ...m, fileUri: publicUrl, pending: false } : m
      ));
    } catch (e: any) {
      setMessages(prev => prev.filter(m => m.id !== tempId));
      Alert.alert('上传失败', e.message || '请重试');
    }
  };

  const handleAttach = () => {
    if (isUploading) return;
    Alert.alert('上传文件', '每次最多3个', [
      {
        text: '拍照', onPress: async () => {
          const { status } = await ImagePicker.requestCameraPermissionsAsync();
          if (status !== 'granted') { Alert.alert('需要相机权限'); return; }
          setIsUploading(true);
          const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
          if (!result.canceled && result.assets[0]) {
            await uploadFile(result.assets[0].uri, `拍照_${Date.now()}.jpg`, 'image/jpeg', 'image');
          }
          setIsUploading(false);
        }
      },
      {
        text: '从相册选择', onPress: async () => {
          const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (status !== 'granted') { Alert.alert('需要相册权限'); return; }
          setIsUploading(true);
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.All,
            quality: 0.8,
            allowsMultipleSelection: true,
            selectionLimit: 3,
            videoMaxDuration: 120,
          });
          if (!result.canceled) {
            for (const asset of result.assets.slice(0, 3)) {
              const isVid = asset.type === 'video';
              const name =
                asset.fileName ||
                (isVid ? `视频_${Date.now()}.mp4` : `图片_${Date.now()}.jpg`);
              const mime = isVid
                ? asset.mimeType && asset.mimeType.startsWith('video/')
                  ? asset.mimeType
                  : 'video/mp4'
                : 'image/jpeg';
              await uploadFile(asset.uri, name, mime, isVid ? 'other' : 'image');
            }
          }
          setIsUploading(false);
        }
      },
      {
        text: '选择文件', onPress: async () => {
          setIsUploading(true);
          const result = await DocumentPicker.getDocumentAsync({
            copyToCacheDirectory: true,
            multiple: true,
          });
          if (!result.canceled) {
            for (const asset of result.assets.slice(0, 3)) {
              const mimeType = asset.mimeType || 'application/octet-stream';
              await uploadFile(asset.uri, asset.name, mimeType, mimeType.includes('pdf') ? 'pdf' : 'other');
            }
          }
          setIsUploading(false);
        }
      },
      { text: '取消', style: 'cancel' },
    ]);
  };

  // ── 语音输入（全屏模态 + 阿里云 ASR）──────────────────
  const openVoiceInputModal = () => {
    setVoiceModalEnvError(null);
    setVoiceModalText('');
    setShowVoiceModal(true);
  };

  // ── 停止回复 ──────────────────────────────────────
  const handleStop = () => {
    stoppedRef.current = true;
    aiAbortReasonRef.current = 'user';
    abortRef.current?.abort();
    abortRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsAiReplying(false);
    /**
     * `send()` 可能在分类/抽取/Supabase 等处仍 await 未结束，外层 finally 尚未跑到，
     * `sendInFlightRef` 会一直为 true，导致「停止后无法再发送」。停止时立即释放，避免按钮无响应。
     * 旧回合后续写完会用 requestId / stoppedRef 尽量不污染 UI。
     */
    sendInFlightRef.current = false;
    setMessages(prev => prev.filter(m => !m.pending));
    /** 停止本轮回复后不应再弹出本轮分类触发的「新成员」询问 */
    setNewMemberName(null);
    setShowNewMemberModal(false);
  };

  const handleReminderCancelPick = async (reminderId: string, choiceTitle: string) => {
    if (!conversationId) return;
    try {
      const upd = await cancelReminderAsDeclined(reminderId);
      if (!upd.ok) {
        Alert.alert('未能取消', upd.error || '请稍后在「记录」页操作');
        return;
      }
      await scheduleAllReminders();
      const line = `已取消提醒「${choiceTitle}」。未记入支出。`;
      const newId = makeId('a');
      setMessages(prev => [...prev, { id: newId, role: 'assistant', text: line }]);
      await supabase.from('messages').insert({
        role: 'assistant',
        content: line,
        conversation_id: conversationId,
      } as any);
      await supabase.from('conversations').update({
        last_message: line.slice(0, 50),
        last_message_at: new Date().toISOString(),
      } as any).eq('id', conversationId);
    } catch (e) {
      console.error('[ReminderCancelPick]', e);
      Alert.alert('操作失败', '请稍后重试');
    }
  };

  // ── 发送消息 ──────────────────────────────────────
  const send = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text) return;
    if (!conversationId) {
      Alert.alert('发送失败', '会话未加载，请返回重新进入');
      return;
    }
    if (sendInFlightRef.current) {
      if (__DEV__) console.log('[Chat][send] skip duplicate (in flight)');
      return;
    }
    sendInFlightRef.current = true;
    // 立即切换到「回复中」状态，让发送按钮在下一帧变为停止按钮，
    // 消灭 NetInfo.fetch() 等 await 期间的重复点击窗口
    setIsAiReplying(true);
    try {
    /**
     * 方案 A：send 不再 await refreshAiPerms，避免与 load messages 等交错拉长「仅有 sendInFlight、尚未挂上本地气泡」的窗口。
     * 权限由 mount / focus / AppState 的 refreshAiPerms 与现有 state 驱动；仅当尚未拿到 userId 时补一次拉取。
     */
    const sessionUserId = authUserId;
    let resolvedUserId: string | null = sessionUserId;
    if (!resolvedUserId) {
      const permLatest = await refreshAiPerms();
      if (!permLatest?.userId) return;
      resolvedUserId = permLatest.userId;
    }
    const userId = resolvedUserId;

    const apiKey = process.env.EXPO_PUBLIC_DEEPSEEK_API_KEY;
    if (!apiKey) {
      Alert.alert('无法发送', '请先在 EAS 构建配置中设置 EXPO_PUBLIC_DEEPSEEK_API_KEY');
      return;
    }

    if (shouldBlockSensitiveChatInput(text)) {
      Keyboard.dismiss();
      stickToBottomRef.current = true;
      const placeholderUser =
        `为保护你的隐私，这条消息未保存，也未转发给${brand.productName}助手。`;
      const assistantSafeReply =
        `这边拦了一下：你刚才发的很像密码、卡号或平台密钥，${brand.productName}不会存档，也不会发给外部模型。\n\n` +
        '若是真在用的信息，建议尽快改密、能开双重验证就开；卡类可留意账单。\n\n' +
        '以后记提醒可以只说这事，别提具体数字或口令～';
      const uidBlock = makeId('u');
      const aidBlock = makeId('a');
      setMessages(prev => [
        ...prev,
        { id: uidBlock, role: 'user', text: placeholderUser },
        { id: aidBlock, role: 'assistant', text: assistantSafeReply },
      ]);
      setInput('');
      baseInputRef.current = '';
      setInputHeight(INPUT_MIN_H);
      scheduleScrollToBottom();
      try {
        await supabase.from('messages').insert({
          role: 'user',
          content: placeholderUser,
          conversation_id: conversationId,
        } as any);
        await supabase.from('messages').insert({
          role: 'assistant',
          content: assistantSafeReply,
          conversation_id: conversationId,
        } as any);
        await supabase
          .from('conversations')
          .update({
            last_message: `${brand.productName}：为保护隐私，未保存疑似敏感信息。`,
            last_message_at: new Date().toISOString(),
          } as any)
          .eq('id', conversationId);
        if (isFirstMessage) {
          setIsFirstMessage(false);
          const safeTitle = '聊天';
          await supabase.from('conversations').update({ title: safeTitle } as any).eq('id', conversationId);
          setConversationTitle(safeTitle);
        }
      } catch (e) {
        console.warn('[Chat] sensitive content block persist failed', e);
      }
      return;
    }

    // 清理上一轮可能遗留的请求（避免网络切换后误伤下一次发送）
    if (abortRef.current) {
      aiAbortReasonRef.current = 'superseded';
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const userMsg: ChatMessage = { id: makeId('u'), role: 'user', text };
    const loadingId = makeId('a');
    const loadingMsg: ChatMessage = { id: loadingId, role: 'assistant', text: '理解中…', pending: true };

    // 无网则直接提示，不发起请求
    const net = await NetInfo.fetch().catch(() => null);
    if (net && net.isConnected === false) {
      stickToBottomRef.current = true;
      setMessages(prev => [
        ...prev,
        userMsg,
        { id: makeId('a'), role: 'assistant', text: '当前网络不可用，请连接网络后重试。', pending: false },
      ]);
      setInput('');
      baseInputRef.current = '';
      setInputHeight(INPUT_MIN_H);
      scheduleScrollToBottom();
      return;
    }

    Keyboard.dismiss();
    stickToBottomRef.current = true;
    setMessages(prev => [...prev, userMsg, loadingMsg]);
    setInput('');
    baseInputRef.current = '';
    setInputHeight(INPUT_MIN_H);
    setExtractDebugText('');
    setExtractDebugModalOpen(false);
    scheduleScrollToBottom();
    setIsAiReplying(true);
    stoppedRef.current = false;
    const requestId = ++currentRequestId.current;
    let extractPersistLater: (() => Promise<ExtractPersistOutcome>) | null = null;
    let extractPersistRan = false;
    /** 供 roundSummary 日志：本轮是否满足 gate 并执行 prepare */
    let shouldRunExtractEarlyForLog: boolean | undefined;
    let extractTraceForLog: string[] | null = null;
    /** persist 成功后的诊断行（主路径 await 时写入） */
    let persistDiagnosisForLog: string[] | undefined;
    /** AI 回复已写入气泡后，后续 Haptics/落库 抛错不得再覆盖成「网络超时」 */
    let assistantReplyCommittedToUi = false;
    /** fetch 期间的省略号动画 interval，finally 中统一清除 */
    let loadingTickInterval: ReturnType<typeof setInterval> | null = null;
    /** 本轮内置调试行，最终追加到 extractDebugText */
    const debugLines: string[] = [];

    const wasFirstMessage = isFirstMessage;
    setIsFirstMessage(false);

    try {
      await supabase.from('messages').insert({ role: 'user', content: text, conversation_id: conversationId } as any);

      if (wasFirstMessage) {
        if (accessTierRef.current === 'auxiliary') {
          const short = text.replace(/\s/g, '').slice(0, 8) || '对话';
          if (conversationId) {
            await supabase.from('conversations').update({ title: short } as any).eq('id', conversationId);
            setConversationTitle(short);
          }
        } else {
          updateTitleFromFirstMessage(text, apiKey);
        }
      }

      const isAuxiliaryChat = accessTierRef.current === 'auxiliary';

      /** 用 DB 最近条拼近期对话，避免 messagesRef 滞后导致丢上一轮助手问句、「按年」误落库 */
      const { data: recentRows, error: recentRowsErr } = await supabase
        .from('messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(24);
      let recentMsgs: string;
      if (!recentRowsErr && recentRows && recentRows.length > 0) {
        recentMsgs = [...recentRows]
          .reverse()
          .map(m => {
            const label = m.role === 'user' ? '用户' : 'AI';
            const c = flatMessageContentForClassifier(String(m.content ?? ''));
            return `${label}：${c}`;
          })
          .filter(line => line.length > 2)
          .join('\n');
      } else {
        recentMsgs = [...messagesRef.current.slice(-5), userMsg]
          .map(m => `${m.role === 'user' ? '用户' : 'AI'}：${m.text}`)
          .join('\n');
      }

      /** 缺槽位补答只有时间片时，抽取合并上一轮用户句，减轻事主/钟点误判 */
      let extractTextForExtract = text;

      // 「提醒我/设置提醒」等短确认句：不管上一轮 AI 说了什么，直接用上上轮用户的原话提取
      // 优先用 ref（同一session内可靠），fallback 用 recentRows[2]（跨session也能工作）
      const isSetReminderConfirm =
        text.trim().length <= 15 &&
        /提醒我|帮我提醒|帮我设|设置提醒|要提醒|需要提醒|设个提醒|设一下|提醒一下|帮设/.test(text.trim());
      const dedupBlockedText = isSetReminderConfirm ? lastDedupBlockedUserTextRef.current : null;
      debugLines.push(`[dedup-confirm] isSetReminderConfirm=${isSetReminderConfirm} dedupBlockedText=${dedupBlockedText ?? 'null'} recentRows[1].role=${recentRows?.[1]?.role ?? '?'} recentRows[2].role=${recentRows?.[2]?.role ?? '?'}`);
      if (dedupBlockedText) {
        extractTextForExtract = dedupBlockedText;
        lastDedupBlockedUserTextRef.current = null;
      } else if (
        isSetReminderConfirm &&
        !recentRowsErr &&
        recentRows &&
        recentRows.length >= 3 &&
        recentRows[0]?.role === 'user' &&
        recentRows[1]?.role === 'assistant' &&
        recentRows[2]?.role === 'user' &&
        // 只在上一轮 AI 明确说「已记过/已有提醒」时才视为提醒确认场景，
        // 避免把「今晚提醒我请客」这种完整事件句误判为确认短语
        isAssistantAlreadyRecordedReply(String(recentRows[1].content ?? ''))
      ) {
        // fallback：DB 里找上上轮用户句，且上上轮必须包含时间/周期词才替换
        const prevU = flatMessageContentForClassifier(String(recentRows[2].content ?? '')).trim();
        const hasTimeContent = /[点时分]|\d{1,2}[:：]\d{2}|每周|每天|每月|周[一二三四五六日天]|星期|下午|上午|晚上|明天|后天/.test(prevU);
        if (prevU && prevU.length > text.trim().length && hasTimeContent) {
          extractTextForExtract = prevU;
          debugLines.push(`[dedup-confirm] fallback to recentRows[2]: ${prevU.slice(0, 80)}`);
        }
      } else if (
        !recentRowsErr &&
        recentRows &&
        recentRows.length >= 3 &&
        recentRows[0]?.role === 'user' &&
        recentRows[1]?.role === 'assistant' &&
        recentRows[2]?.role === 'user' &&
        isAssistantDeterministicMissingKeyReplyContent(String(recentRows[1].content ?? ''))
      ) {
        const prevU = flatMessageContentForClassifier(String(recentRows[2].content ?? '')).trim();
        if (prevU) extractTextForExtract = `${prevU}\n${text.trim()}`;
      } else if (
        !recentRowsErr &&
        recentRows &&
        recentRows.length >= 2 &&
        text.trim().length <= 20 &&
        recentRows[0]?.role === 'user' &&
        recentRows[1]?.role === 'user' &&
        flatMessageContentForClassifier(String(recentRows[0]?.content ?? '')).trim() ===
          flatMessageContentForClassifier(text).trim()
      ) {
        /** 连续两条均为用户：本轮短句视为对上一句的补充（与「AI 确定性追问→补答」路径互斥：该路径要求 [1] 为 assistant） */
        const prevUserText = flatMessageContentForClassifier(
          String(recentRows[1]?.content ?? '')
        ).trim();
        if (prevUserText && prevUserText.length > text.trim().length) {
          extractTextForExtract = `${prevUserText}\n${text.trim()}`;
        }
      }

      // 先查 family_id 与缓存，再做意图分类（让分类器知道家庭成员）
      const { data: userData } = await supabase
        .from('users')
        .select('family_id, name')
        .eq('id', userId)
        .single();
      const familyId = userData?.family_id;
      let familyMembersStr = '';
      let historyStr = '';
      let membersArr: { name: string; role: string; linked_user_id?: string | null; notes?: string | null }[] = [];
      let recorderLabelByUserId: Record<string, string> = {};
      let userIdToAppRole: Record<string, string> = {};

      const CACHE_TTL = 2 * 60 * 1000;
      const now_ts = Date.now();
      const cacheValid = cacheRef.current &&
        cacheRef.current.familyId === familyId &&
        (now_ts - cacheRef.current.lastFetched) < CACHE_TTL;

      if (familyId) {
        if (cacheValid && cacheRef.current) {
          familyMembersStr = cacheRef.current.familyMembersStr;
          historyStr = cacheRef.current.historyStr;
          membersArr = cacheRef.current.members;
          recorderLabelByUserId = cacheRef.current.recorderLabelByUserId || {};
          userIdToAppRole = cacheRef.current.userIdToAppRole || {};
        } else {
          const [{ data: members }, { data: recentEvents }, { data: familyUsers }] = await Promise.all([
            supabase.from('family_members').select('name, role, linked_user_id, notes').eq('family_id', familyId),
            supabase
              .from('family_events')
              .select('title, description, event_date, related_member, event_type, created_by')
              .eq('family_id', familyId)
              .order('created_at', { ascending: false })
              .limit(20),
            supabase.from('users').select('id, name, role').eq('family_id', familyId),
          ]);

          membersArr = (members || []).map((m: any) => ({
            name: m.name || '',
            role: m.role || '',
            linked_user_id: m.linked_user_id ?? null,
            notes: m.notes ?? null,
          }));
          familyMembersStr = formatFamilyMembersStrForClassifier(
            (members || []).map((m: any) => ({ name: m.name || '', role: m.role || '', notes: m.notes ?? null }))
          );
          console.log('[DEBUG][members]', JSON.stringify((members || []).map((m: any) => ({ name: m.name, notes: m.notes }))));
          console.log('[DEBUG][familyMembersStr]', familyMembersStr);
          recorderLabelByUserId = buildRecorderLabelByUserId(membersArr, familyUsers || []);
          userIdToAppRole = Object.fromEntries(
            (familyUsers || []).map((u: any) => [u.id, String(u.role || '').trim()])
          );
          historyStr =
            recentEvents
              ?.map((e: any) => {
                const line = formatFamilyEventHistoryLine(e, recorderLabelByUserId, membersArr);
                const persp = getFamilyEventHistoryPerspectiveFields(e, membersArr);
                const note = buildHistoryLineCrossPerspectiveNote(
                  e.created_by,
                  persp.displayRelated,
                  persp.displayTitle,
                  membersArr,
                  userId,
                  {
                    listenerRoleFromUser: userId ? userIdToAppRole[userId] : null,
                    recorderRoleFromUser: e.created_by ? userIdToAppRole[e.created_by] : null,
                  },
                  e.description
                );
                return line + note;
              })
              .join('\n') || '';

          cacheRef.current = {
            familyId,
            familyMembersStr,
            historyStr,
            members: membersArr,
            recorderLabelByUserId,
            userIdToAppRole,
            userName: userData?.name || '',
            lastFetched: now_ts,
          };
        }
      }

      const linkedMemberRow = userId
        ? membersArr.find(m => m.linked_user_id != null && m.linked_user_id === userId)
        : undefined;
      const linkedMemberPayload = linkedMemberRow
        ? { name: linkedMemberRow.name, role: linkedMemberRow.role }
        : null;

      const currentUserMemberName =
        linkedMemberPayload?.name?.trim() || (userData?.name || '').trim() || '';
      console.log('[DEBUG][classify] currentUserMemberName:', currentUserMemberName);

      const now = new Date();
      const todayStr = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const currentTimeStr = now.toLocaleTimeString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
      });
      const weekDates = weekDatesLineForPromptShanghai(now);

      let postExtractInject = '';
      let sameEventVoiceHintForPrompt: SameEventVoiceHint | null = null;
      let skipExtractFromQuickDedup = false;
      let quickDedupDiag: ExtractDebugDiag | null = null;

      /** 已写入本轮用户句后 recentRows 为降序：[0]=本轮 user、[1]=上一条（补答追问时为 assistant） */
      const prevTurn = !recentRowsErr && recentRows && recentRows.length >= 2 ? recentRows[1] : null;
      const assistantContent = prevTurn?.role === 'assistant' ? String(prevTurn.content ?? '') : '';
      const isFollowUpAnswer =
        text.trim().length <= 20 &&
        recentRows?.[0]?.role === 'user' &&
        flatMessageContentForClassifier(String(recentRows?.[0]?.content ?? '')).trim() ===
          flatMessageContentForClassifier(text).trim() &&
        assistantContent.length > 0 &&
        (isAssistantDeterministicMissingKeyReplyContent(assistantContent) ||
          /具体哪天|周几|几号|哪天|几点/.test(
            flatMessageContentForClassifier(assistantContent)
          ));

      if (familyId && text.trim().length >= 3 && !isFollowUpAnswer && !isSetReminderConfirm) {
        const qh = await quickDedupCheck(text, familyId);
        if (qh) {
          // 命中 reminder → 整条跳过（reminder 已存在，无需再创建）
          // 命中 event → 仅阻止重复写 family_event；reminder 仍可继续创建
          if (qh.source === 'reminder') {
            skipExtractFromQuickDedup = true;
            // 保存当前用户原文，供下一轮「提醒我」等短确认句使用
            if (text.trim().length > 8) {
              lastDedupBlockedUserTextRef.current = text.trim();
              debugLines.push(`[dedup-save] saved for next round: ${text.trim().slice(0, 80)}`);
            }
            const qRec = resolveRecorderVoiceMeta(
              qh.created_by,
              userId,
              recorderLabelByUserId,
              membersArr.map(m => ({
                name: m.name,
                linked_user_id: m.linked_user_id ?? null,
              }))
            );
            sameEventVoiceHintForPrompt = {
              kind: 'already_recorded',
              summary: qh.title,
              scope: 'reminder',
              diffType: 'exact',
              recorderIsSelf: qRec.recorderIsSelf,
              recorderDisplayName: qRec.recorderDisplayName,
            };
            postExtractInject = buildSameEventVoiceInject(
              sameEventVoiceHintForPrompt,
              sameEventVoiceRecordedByForInject(sameEventVoiceHintForPrompt)
            );
          }
          quickDedupDiag = {
            quickDedupHit: qh,
            extractOutput: qh.source === 'reminder' ? '(skipped extract)' : '(event-only dedup, reminder may proceed)',
            candidateCountFe: 0,
            candidateCountRem: 0,
            dupFeId: qh.source === 'event' ? qh.id : null,
            dupRemId: qh.source === 'reminder' ? qh.id : null,
            writeBlocked: qh.source === 'reminder' ? 'quick_dedup_no_extract' : 'quick_dedup_event_only',
            skipWrite: qh.source === 'reminder',
            skipReminder: qh.source === 'reminder',
          };
        }
      }

      const shouldExtractGate = Boolean(
        familyId && !skipExtractFromQuickDedup && text.trim().length >= 3
      );
      const extractAppendixEarly =
        membersArr.length > 0
          ? buildKinshipRulesForPrompt(membersArr, userData?.name || '', linkedMemberPayload)
          : '';
      const currentUserMemberForExtract = formatCurrentUserMemberForExtract(
        linkedMemberPayload,
        userData?.name || ''
      );

      const combined = await classifyAndExtract(
        text,
        recentMsgs,
        familyMembersStr,
        currentUserMemberName,
        todayStr,
        weekDates,
        shouldExtractGate,
        apiKey!,
        {
          auxiliaryAccount: isAuxiliaryChat,
          extractAppendix: extractAppendixEarly,
          currentUserMemberForExtract,
          currentUserLinkedRoleForClassifier: linkedMemberPayload?.role ?? null,
        }
      );

      let mergedExtractFromCombined: ExtractResult | null = null;
      let intent: IntentResult;
      if (combined) {
        intent = combined.intent;
        mergedExtractFromCombined = combined.extract;
      } else {
        intent = await classifyIntent(text, recentMsgs, familyMembersStr, apiKey!, {
          auxiliaryAccount: isAuxiliaryChat,
          currentUserMemberName,
          currentUserLinkedRole: linkedMemberPayload?.role ?? null,
        });
        mergedExtractFromCombined = null;
      }

      const dbResult = { familyId, familyMembersStr, historyStr };

      intent = applyIntentProductHeuristics(intent, text);
      intent = applySubscriptionRenewalDayFollowUpHeuristic(intent, text, recentMsgs);
      intent = applySubscriptionRenewalConfirmHeuristic(intent, text, recentMsgs);
      intent = applyRepaymentDayFollowUpHeuristic(intent, text, recentMsgs);
      intent = applyFinanceAmountFollowUpHeuristic(intent, text, recentMsgs);
      intent = applyCancelReminderHeuristic(intent, text);
      intent = applyDeepReasoningHeuristic(intent, text);
      intent = applySubscriptionCycleShortAnswerHardLock(intent, text, recentMsgs);
      debugLines.push(`[intent-before-reminder-heuristic] intent=${intent.intent} has_record=${intent.has_record_value} needs_reminder=${intent.needs_reminder} dedupBlockedText=${dedupBlockedText ?? 'null'}`);
      intent = applySetReminderAfterAlreadyRecordedHeuristic(intent, text, recentRows, dedupBlockedText);
      debugLines.push(`[intent-after-heuristics] intent=${intent.intent} has_record=${intent.has_record_value} needs_reminder=${intent.needs_reminder} missing=${intent.missing_key_info ?? ''} extractText=${extractTextForExtract.slice(0, 60)}`);
      intent = applyMissingKeyTimeAnswerHeuristic(intent, text);
      intent = applyMissingKeyDateAnswerHeuristic(intent, text);
      intent = applyMissingKeyConfirmAnswerHeuristic(intent, text, recentMsgs);

      const relatedMemberBeforeListDefault = (intent.related_member || '').trim();
      if (!memberMentionedInUserText(text, membersArr)) {
        intent.related_member = currentUserMemberName;
      }
      intent = supplementUnknownMemberDetectedFromRelatedMember(
        intent,
        relatedMemberBeforeListDefault,
        text,
        membersArr,
        currentUserMemberName,
        userId ?? null,
        linkedMemberPayload?.role ?? null
      );
      if (intent.event_type === 'plant_pet' && intent.related_member) {
        const memberNames = membersArr.map(m => m.name).filter(Boolean);
        const isPerson = memberNames.some(
          name => intent.related_member.includes(name) || name.includes(intent.related_member)
        );
        if (isPerson) {
          intent.event_type = 'health';
        }
      }

      const cancelFlow = await runCancelReminderFlow(familyId, intent, text);

      if (cancelFlow.kind === 'multi') {
        const content = JSON.stringify({
          __type: 'reminder_cancel_pick',
          intro: cancelFlow.intro,
          choices: cancelFlow.choices,
        });
        setMessages(prev =>
          prev.map(m =>
            m.id === loadingId
              ? {
                  ...m,
                  text: cancelFlow.intro,
                  reminderCancelChoices: cancelFlow.choices,
                  pending: false,
                }
              : m
          )
        );
        await supabase.from('messages').insert({
          role: 'assistant',
          content,
          conversation_id: conversationId,
        } as any);
        await supabase.from('conversations').update({
          last_message: cancelFlow.intro.slice(0, 50),
          last_message_at: new Date().toISOString(),
        } as any).eq('id', conversationId);
        return;
      }

      let cancelSystemInject = '';
      if (cancelFlow.kind === 'single') {
        cancelSystemInject = `\n\n【系统已执行】用户已通过对话取消未完成提醒「${cancelFlow.title}」。此操作与 App「记录」页中「取消提醒」一致：仅关闭提醒，**不计入已消费**、**不产生财务流水**。请用一两句话确认，勿编造其他提醒状态。`;
      } else if (cancelFlow.kind === 'failed') {
        cancelSystemInject =
          '\n\n【系统错误】取消提醒写入数据库失败。**禁止**对用户说「已经取消」或「已帮你关掉」。请说明暂时无法完成，建议用户稍后再试或到「记录」页左滑取消。';
      } else if (cancelFlow.kind === 'none') {
        cancelSystemInject = `\n\n【重要】用户想取消与「${cancelFlow.keywords}」相关的提醒，但**系统中没有匹配的未完成项**。**严禁**说「已经取消」「已删除」等成功表述。请如实说明没找到对应提醒，并建议用户到「记录」页核对标题或说得更具体。`;
      } else if (cancelFlow.kind === 'vague') {
        cancelSystemInject =
          '\n\n【上下文】用户表达了取消提醒的意向，但未说明具体是哪一条。**不要**假装已帮用户取消。请追问要取消的是哪一件事（可提示在「记录」页查看待办）。';
      }

      /** 仅家庭权限：检测到不在列表中的家人称呼时询问是否添加；辅助账号不识别、不弹窗 */
      if (!isAuxiliaryChat) {
        const unknownRaw = intent.unknown_member_detected?.trim() || '';
        const unknownNorm = unknownRaw ? normalizeUnknownMemberName(unknownRaw) : '';
        if (unknownNorm && !isWorkplaceHonorific(unknownNorm)) {
          const declined = await loadDeclinedNewMemberNames(userId);
          if (
            !declined.includes(unknownNorm) &&
            !stoppedRef.current &&
            requestId === currentRequestId.current
          ) {
            setNewMemberName(unknownNorm);
            setShowNewMemberModal(true);
          }
        }
      }

      /** 辅助权限：仅「记录 / 提醒」走落库；闲聊与查询一律「已收到」；缺关键信息只追问一句 */
      if (isAuxiliaryChat) {
        const early = resolveAuxiliaryEarlyReply(intent);
        if (early.kind === 'ack') {
          const reply = '已收到。';
          if (!stoppedRef.current && requestId === currentRequestId.current) {
            setMessages(prev =>
              prev.map(m => (m.id === loadingId ? { ...m, text: reply, pending: false } : m))
            );
          }
          await supabase.from('messages').insert({
            role: 'assistant',
            content: reply,
            conversation_id: conversationId,
          } as any);
          await supabase.from('conversations').update({
            last_message: reply,
            last_message_at: new Date().toISOString(),
          } as any).eq('id', conversationId);
          setIsAiReplying(false);
          scheduleScrollToBottom();
          return;
        }
        if (early.kind === 'clarify') {
          const reply = buildDeterministicMissingKeyReply(text, early.question, membersArr);
          if (!stoppedRef.current && requestId === currentRequestId.current) {
            setMessages(prev =>
              prev.map(m => (m.id === loadingId ? { ...m, text: reply, pending: false } : m))
            );
          }
          await supabase.from('messages').insert({
            role: 'assistant',
            content: reply,
            conversation_id: conversationId,
          } as any);
          await supabase.from('conversations').update({
            last_message: reply.slice(0, 50),
            last_message_at: new Date().toISOString(),
          } as any).eq('id', conversationId);
          setIsAiReplying(false);
          scheduleScrollToBottom();
          return;
        }
      }

      /** 重复说同一件事时分类器可能把 has_record_value 判成 false，但仍 needs_reminder；须跑抽取才能去重口播 */
      const shouldWriteEvents =
        intent.intent === 'record' &&
        (intent.has_record_value || intent.needs_reminder === true);
      const processExtractedEventsForDedupe = heuristicProcessExtractedEventsForDedupe(intent, text);
      const missingKeyTrim = (intent.missing_key_info || '').trim();
      /**
       * 只要缺关键槽位就不走抽取/落库。否则分类器把「按年」标成 has_record_value=false 时，
       * 旧逻辑 !(shouldWriteEvents && missing) 仍为 true，会误跑抽取并编造 3 月 31 日等。
       */
      const wantsExtract =
        shouldWriteEvents || intent.write_finance || processExtractedEventsForDedupe;
      const unknownMemberTrim = (intent.unknown_member_detected || '').trim();
      const shouldRunExtractEarly = Boolean(
        familyId &&
          !skipExtractFromQuickDedup &&
          wantsExtract &&
          !missingKeyTrim
      );
      const gateDebugPayload = {
        intent,
        familyId: Boolean(familyId),
        notQuickDedupBlocked: !skipExtractFromQuickDedup,
        hasRecord: shouldWriteEvents,
        writeFinance: Boolean(intent.write_finance),
        heuristicHit: processExtractedEventsForDedupe,
        wantsExtract,
        missing_key_info: intent.missing_key_info ?? '',
        hasMissingKey: Boolean(missingKeyTrim),
        unknown_member_detected: unknownMemberTrim,
        shouldRunExtractEarly,
      };
      console.log('[DEBUG][gate] conditions:', gateDebugPayload);
      debugLines.push(`[gate] shouldWriteEvents=${shouldWriteEvents} shouldRunExtractEarly=${shouldRunExtractEarly} skipExtractFromQuickDedup=${skipExtractFromQuickDedup} wantsExtract=${wantsExtract} missingKey="${missingKeyTrim}" unknownMember="${unknownMemberTrim}"`);

      let extractPrepareDebugTrace: string[] | null = null;
      let extractPrepareDebugDiag: ExtractDebugDiag | null = null;

      if (shouldRunExtractEarly && familyId) {
        setMessages(prev =>
          prev.map(m => (m.id === loadingId ? { ...m, text: '正在整理记录…' } : m))
        );
        const prep = await prepareExtractInjectAndPersist(
          apiKey!,
          {
            text: extractTextForExtract,
            thisRoundUserText: text,
            familyMembersStr,
            currentUserMember: currentUserMemberForExtract,
            codeRelatedMember: intent.related_member || undefined,
            membersBrief: membersArr.map(m => ({
              name: m.name,
              role: m.role,
              linked_user_id: m.linked_user_id ?? null,
            })),
            recorderLabelByUserId,
            recorderLinkedRole: linkedMemberPayload?.role ?? null,
            recentMsgs,
            todayStr,
            weekDates,
            familyId,
            userId,
            conversationId,
            shouldWriteEvents,
            processExtractedEventsForDedupe,
            writeFinance: intent.write_finance,
            extractAppendix: extractAppendixEarly,
            userSpecifiedConcreteTime: userSpecifiedConcreteReminderTimeInText(extractTextForExtract),
            // 「提醒我」确认场景：提取文本已替换为上轮原话，事件去重不得阻止提醒写入
            forceCreateReminder: isSetReminderConfirm && extractTextForExtract !== text,
          },
          (() => {
            // 「提醒我」确认场景：优先用上一轮 dupFe 保存的 extractResult，避免重新 extract 返回空
            const savedExtract = (isSetReminderConfirm && extractTextForExtract !== text)
              ? lastDupFeExtractResultRef.current
              : null;
            if (savedExtract) {
              lastDupFeExtractResultRef.current = null;
              debugLines.push(`[dedup-reuse-extract] 复用上一轮 extractResult events=${savedExtract.events.length} reminders=${savedExtract.reminders?.length ?? 0}`);
              return { extractResultOverride: savedExtract };
            }
            return mergedExtractFromCombined ? { extractResultOverride: mergedExtractFromCombined } : undefined;
          })()
        );
        postExtractInject = prep.injectText;
        extractPersistLater = prep.persist;
        sameEventVoiceHintForPrompt = prep.sameEventVoiceHint;
        extractPrepareDebugTrace = prep.debugTrace;
        extractPrepareDebugDiag = prep.debugDiag;
        // dupFe 阻断了提醒写入时，保存 extractResult 供下一轮「提醒我」复用
        if (prep.extractResultForReuse) {
          lastDupFeExtractResultRef.current = prep.extractResultForReuse;
          debugLines.push(`[dedup-save-extract] 保存 extractResult 供下一轮「提醒我」复用 events=${prep.extractResultForReuse.events.length} reminders=${prep.extractResultForReuse.reminders?.length ?? 0}`);
        }
        cacheRef.current = null;
      }

      shouldRunExtractEarlyForLog = shouldRunExtractEarly;
      extractTraceForLog = extractPrepareDebugTrace;

      if (SHOW_EXTRACT_DEBUG) {
        const diagParts: string[] = [];
        if (debugLines.length > 0) {
          diagParts.push(`[本轮诊断]\n${debugLines.join('\n')}`);
        }
        diagParts.push(`[DEBUG][gate] conditions: ${JSON.stringify(gateDebugPayload, null, 2)}`);
        if (quickDedupDiag) {
          diagParts.push(
            `[quickDedup] extract 已跳过:\n${JSON.stringify(quickDedupDiag, null, 2)}`
          );
        }
        if (extractPrepareDebugTrace) {
          diagParts.push(extractPrepareDebugTrace.join('\n'));
          diagParts.push(`debugDiag:\n${JSON.stringify(extractPrepareDebugDiag, null, 2)}`);
        } else {
          diagParts.push('[prepare] prepareExtractInjectAndPersist 未调用');
        }
        setExtractDebugText(diagParts.join('\n\n'));
      }

      /** 缺关键槽位（任意非空 missing_key_info）时确定性追问，不调用主模型 */
      const skipDeepSeekForMissingKey =
        !isAuxiliaryChat &&
        Boolean(missingKeyTrim) &&
        !sameEventVoiceHintForPrompt &&
        intent.intent === 'record' &&
        !intent.cancel_reminder &&
        (shouldWriteEvents || intent.needs_reminder === true);

      if (skipDeepSeekForMissingKey) {
        const reply = buildDeterministicMissingKeyReply(text, intent.missing_key_info, membersArr);
        if (!stoppedRef.current && requestId === currentRequestId.current) {
          setMessages(prev =>
            prev.map(m => (m.id === loadingId ? { ...m, text: reply, pending: false } : m))
          );
          assistantReplyCommittedToUi = true;
          console.log('[DEBUG][reply] deterministic missing_key:', reply);
        }
        if (stoppedRef.current || requestId !== currentRequestId.current) return;

        try {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          setTimeout(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium), 80);
          setTimeout(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium), 160);
          setTimeout(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light), 240);
        } catch (hapticsErr) {
          console.log('[Chat] Haptics skipped', hapticsErr);
        }
        try {
          const ins = await supabase
            .from('messages')
            .insert({ role: 'assistant', content: reply, conversation_id: conversationId } as any);
          if (ins.error) {
            console.log('[Chat] assistant message insert error', ins.error.message, ins.error);
          }
          const upd = await supabase
            .from('conversations')
            .update({
              last_message: reply.slice(0, 50),
              last_message_at: new Date().toISOString(),
            } as any)
            .eq('id', conversationId);
          if (upd.error) {
            console.log('[Chat] conversations update error', upd.error.message, upd.error);
          }
        } catch (persistErr) {
          console.log('[Chat] assistant persist threw', persistErr);
        }
        return;
      }

      const loadingHint = intent.needs_deep_reasoning ? '正在深度思考…' : '回复中…';
      setMessages(prev =>
        prev.map(m => (m.id === loadingId ? { ...m, text: loadingHint } : m))
      );

      const perspectiveBlock =
        familyId && (linkedMemberPayload || (userData?.name || '').trim())
          ? `${buildConversationPerspectiveBlock(userData?.name || '', linkedMemberPayload)}\n\n`
          : '';

      const familyHistoryRulesBlock = familyId ? `${buildFamilyHistoryProvenanceRules()}\n\n` : '';

      let recentCompletedRemindersBlock = '';
      if (familyId && !isAuxiliaryChat) {
        /** 闲聊场景压缩注入，减轻主请求体积（意图分类已成功、大包 POST 仍失败的多为链路/超时问题） */
        const completedLimit = intent.intent === 'chat' ? 6 : 18;
        recentCompletedRemindersBlock = await buildRecentCompletedRemindersPromptBlock(
          familyId,
          recorderLabelByUserId,
          completedLimit
        );
      }

      const HISTORY_CAP_CHAT = 8000;
      let historyStrForPrompt =
        intent.intent === 'chat' && (historyStr || '').length > HISTORY_CAP_CHAT
          ? `${(historyStr || '').slice(0, HISTORY_CAP_CHAT)}\n…（近期家庭记录已省略后续，本轮为闲聊）`
          : historyStr || '';
      if (isAuxiliaryChat) {
        historyStrForPrompt = '';
      }

      const membersLineForPrompt = isAuxiliaryChat
        ? '系统已解析家庭成员关系（请勿在回复中主动罗列全家姓名清单或复述他人隐私。）'
        : familyMembersStr || '暂无记录';
      const historyLineForPrompt = isAuxiliaryChat
        ? '不向本账号注入家庭历史流水；仅依据用户本条消息、对话摘要及系统已抽取/已写入结果作答。'
        : historyStrForPrompt || '暂无记录';

      /** 刚插入的用户句在 DB 最新一条；上一条助手为代码追问则本拍为「补答后的确认轮」 */
      const userFollowsDeterministicMissingKeyClarify =
        !recentRowsErr &&
        recentRows &&
        recentRows.length >= 2 &&
        recentRows[0]?.role === 'user' &&
        recentRows[1]?.role === 'assistant' &&
        isAssistantDeterministicMissingKeyReplyContent(String(recentRows[1].content ?? ''));

      const injectPrincipalForConfirmRound =
        !isAuxiliaryChat &&
        Boolean(currentUserMemberName) &&
        intent.intent === 'record' &&
        !missingKeyTrim &&
        (intent.related_member || '').trim() === currentUserMemberName &&
        userFollowsDeterministicMissingKeyClarify;

      let systemPrompt = `你是${brand.productName}，这个家庭的智能参谋和贴心朋友。现在是北京时间${todayStr} ${currentTimeStr}。本周日期：${weekDates}。

家庭成员：${membersLineForPrompt}
家庭近期记录：
${historyLineForPrompt}${recentCompletedRemindersBlock}

${familyHistoryRulesBlock}${perspectiveBlock}【禁止直呼用户姓名或家庭成员称谓】
- **禁止**在回复里称呼用户的名字、昵称（如「老刘」「肖珺」及家庭成员列表中出现的其它姓名指代**当前对话中的你**）
- 对当前用户**一律用「你」**指称，不要用第三人称直呼 Ta
- **禁止**在回复里加「作为儿子/女儿/妻子/丈夫」等身份评语或说教式身份定位（可按系统关联角色在内心换算视角，**勿写出来**）

【你的性格】
- 像了解这个家庭多年的老朋友，说话自然真实，有温度但不矫情
- 有判断力，遇到模糊情况主动判断，不反复追问
- 偶尔幽默，但不油腻；关心但不说教
- 用「你」不用「您」，拉近距离

【回复风格】
- 中文，自然流畅，长度根据问题灵活调整，简单问题简短回答，复杂问题可以展开
- 可以用 Markdown 格式（加粗、列表），但不滥用
- 情绪支持场景：先共情，再给建议，不急着解决问题
- 不对家庭成员做是非评判，不干预夫妻关系

【价值观】
- 家庭隐私优先：对话内容绝对保密，不评判任何家庭成员
- 儿童保护：涉及孩子安全的话题保持审慎和认真
- 尊重用户决定：给建议但不强推，用户有最终决定权
- 健康话题加免责：「以上仅供参考，请以医生诊断为准」

【能力边界】
- 不是医生、律师、理财顾问，专业问题给方向但不给定论
- 不记录日常琐事（买菜、加油、停车）
- 遇到超出能力的问题，坦诚说「这个我不太确定」
- 提醒与待办：用户未明说已做且下方也无【最近已完成的待办】对应项时，勿将「已过期」臆测为已做完；**若【最近已完成的待办】中有与用户问题一致的标题，必须引用其中的「完成」时间，说明家人已在 App 内勾选完成（视为已落实），勿再说「记录分不清是计划还是已做」或让用户猜测是否已剪/已办**`;
      systemPrompt += cancelSystemInject;

      if (intent.intent === 'chat') {
        if (sameEventVoiceHintForPrompt) {
          systemPrompt += `\n\n【当前场景·同一件事（意图可能被标成闲聊）】
下方注入里若有「同一件事·口播」，你必须**只按口播**回复，该段**优先于**「闲聊」说明。
- 口播为「已记录过」：用口语说明用户**之前已提过**、**已经记过了**；**禁止**再承诺「帮你设提醒」「记下了」「到点提醒你」；**禁止**单独一行「✓ 已记录」。
- 口播为「问是否更新」：**只问一句**是否改成新人物/新时间；**禁止**说已改库、已更新。
- 若口播写明本轮**没有任何数据库写入**，则**禁止**声称已写入、已设提醒。`;
        } else if (isAuxiliaryChat) {
          systemPrompt += `\n\n当前场景：辅助账号。若用户未明确要记录或设置提醒，仅作一两句极简回应，勿展开家庭话题或给长篇建议。`;
        } else {
          systemPrompt += `\n\n当前场景：日常闲聊或情绪支持。`;
        }
      } else if (intent.intent === 'query') {
        if (isAuxiliaryChat) {
          systemPrompt +=
            `\n\n【当前场景·辅助账号】禁止向用户朗读或总结家庭待办、历史记录、财务或他人日程详情。若用户询问这些内容，仅用一两句说明：详细需由家庭管理员在本 App「记录」中查看；不要编造任何清单。若与本轮要记录/设提醒直接相关，仍按记录类规则极简确认。`;
        } else {
        let queryContext = '';
        if ((intent.query_type === 'status' || intent.query_type === 'time') && familyId) {
          const { data: pendingReminders } = await supabase
            .from('reminders')
            .select('title, remind_at, event_date, event_type, related_member, is_done')
            .eq('family_id', familyId)
            .eq('is_done', false)
            .limit(50);
          if (pendingReminders && pendingReminders.length > 0) {
            const sorted = [...pendingReminders].sort((a, b) =>
              getReminderSortKey(a).localeCompare(getReminderSortKey(b))
            );
            queryContext =
              '\n\n【日程与待办】**本段为刚才从数据库实时查询**：仅包含 is_done=false 的未完成项；若用户已在「记录/提醒」页点过「完成」，对应项**不会**出现在下列列表中，**禁止**仍将其说成未完成或「已过期待办」。\n' +
              '事项日以 event_date 为准，无则用 remind_at 的北京时间日期；响铃时刻以 remind_at 的北京时间为准。\n' +
              '状态「已过期·未完成」仅表示已过计划日/时刻且数据库仍为未完成；**不得**与用户口头说「我做了」混同，但若列表中已无该项，应认为用户可能已在 App 内完成。\n';
            sorted.forEach((r: any, i: number) => {
              const st = getReminderStatus(r.remind_at, r.event_date);
              const stLabel = getReminderIncompleteStatusLabel(st);
              const dayPart = formatReminderDisplayTime({
                remind_at: r.remind_at,
                event_date: r.event_date,
              });
              const clock = r.remind_at ? formatReminderWallTimeShanghai(r.remind_at) : '';
              const when =
                clock && !dayPart.includes(':')
                  ? `${dayPart}（提醒时刻 ${clock}）`
                  : dayPart;
              const who = r.related_member ? r.related_member + '：' : '';
              queryContext += `${i + 1}. [${stLabel}] ${who}${r.title}（${when}）\n`;
            });
          } else {
            queryContext = '\n\n【日程与待办】暂无未完成提醒。\n';
          }
        }
        if (intent.query_type === 'history' && familyId) {
          const todayDate = getShanghaiYmd();
          const { data: todayEvents } = await supabase
            .from('family_events')
            .select('title, description, amount, event_date, event_type, related_member, created_at, created_by')
            .eq('family_id', familyId)
            .gte('created_at', `${todayDate}T00:00:00+08:00`).lte('created_at', `${todayDate}T23:59:59+08:00`)
            .order('created_at', { ascending: true });
          if (todayEvents && todayEvents.length > 0) {
            const totalAmount = todayEvents.reduce((sum: number, e: any) => sum + (e.amount || 0), 0);
            queryContext =
              '\n\n【今日完整记录】（含记录人；「我妈」等相对该记录人，规则同「家庭近期记录」）\n';
            todayEvents.forEach((e: any, i: number) => {
              const rec =
                e.created_by && recorderLabelByUserId[e.created_by]
                  ? `记录人：${recorderLabelByUserId[e.created_by]}｜`
                  : '';
              const perspToday = getFamilyEventHistoryPerspectiveFields(e, membersArr);
              const whoToday = perspToday.displayRelated ? `${perspToday.displayRelated}：` : '';
              const xNote = buildHistoryLineCrossPerspectiveNote(
                e.created_by,
                perspToday.displayRelated,
                perspToday.displayTitle,
                membersArr,
                userId,
                {
                  listenerRoleFromUser: userId ? userIdToAppRole[userId] : null,
                  recorderRoleFromUser: e.created_by ? userIdToAppRole[e.created_by] : null,
                },
                e.description
              );
              queryContext += `${i + 1}. ${rec}${whoToday}${perspToday.displayTitle}${e.description ? '：' + e.description : ''}${e.amount ? '，¥' + e.amount : ''}${xNote}\n`;
            });
            queryContext += `今日总支出：¥${totalAmount}`;
          } else {
            queryContext = '\n\n【今日记录】暂无记录。';
          }
        }
        const qTypeMap: Record<string, string> = {
          time: '时间查询：严格基于下方【日程与待办】中的事项日与提醒时刻（北京时间）回答；勿将「已过期·未完成」说成已完成',
          document: '资料查询：引导用户查看上传的资料',
          history: '历史查询：严格基于下方【今日完整记录】回答',
          status: '状态查询：严格基于下方【日程与待办】回答，排序与记录页一致；勿默认过期项已做完',
        };
        systemPrompt += `\n\n当前场景：${qTypeMap[intent.query_type || ''] || '查询'}。${queryContext}找不到时说「没有找到相关记录，是否现在记录一下？」`;
        }
      } else {
        if (sameEventVoiceHintForPrompt) {
          systemPrompt += `\n\n【当前场景·同一件事（系统已判定）】
下方注入里若有「同一件事·口播」，你必须**只按口播**回复，该段**优先于**任何「已记录 / 设提醒」模板。
- 口播为「已记录过」：用口语说明用户**之前已提过**、**已经记过了**；**禁止**再承诺「帮你设提醒」「记下了」「到点提醒你」；**禁止**单独一行「✓ 已记录」。
- 口播为「问是否更新」：**只问一句**是否改成新人物/新时间；**禁止**说已改库、已更新。
- 若口播写明本轮**没有任何数据库写入**，则**禁止**声称已写入、已设提醒。`;
        } else if (!intent.has_record_value) {
          systemPrompt += `\n\n当前场景：日常小事，无需记录。自然回应即可。`;
        } else {
          const sceneKnowledge = SCENE_KNOWLEDGE[intent.event_type] || SCENE_KNOWLEDGE.daily;
          const whoLock = (intent.related_member || '').trim()
            ? `\n4. 事项主体已由系统定为「${(intent.related_member || '').trim()}」（**仅作内部对齐**）：对当前用户回复**只称「你」**，禁止直呼该姓名；**禁止**改写成家庭成员列表中的其他人。\n5. 用户本条仅确认本条事务时，**勿**主动岔开插入其他无关待办/提醒（除非用户明确问到）。`
            : '';
          systemPrompt += `\n\n【重要指令，必须严格遵守】
1. 不追问金额费用，其他信息可以自然追问
2. 用自然的称呼，不强制第三人称转换
3. 简短温暖地确认已记录${whoLock}

当前场景：记录家庭事件（${intent.event_type}类）
场景参考：${sceneKnowledge}
回复格式：
1. **确认记录只需一两句口语**：第一句自然确认已记下（语气像朋友，**不要**写成条文）；**至多**再跟一句收口，例如「如有后续可以继续告诉我。」——**不要**第三句及以后继续展开、复述或总结
2. 换行：✓ 已记录${
            intent.needs_reminder
              ? `
3. 若本轮 **needs_reminder 为 true**：**不要**在正文里再写「已设好提醒、X月X日X点叫你」等与具体钟点/日期绑定的确认句——系统在**实际写库成功**后会自动在你整段回复**末尾**追加一行「已设好提醒，M月D日 HH:mm 提醒你。」（与数据库一致）。你只需在前文自然带过「会提醒你」等**不含具体时刻**的表述即可，避免与系统追加句重复或矛盾。`
              : ''
          }
${intent.needs_reminder ? '4' : '3'}. 若有周期/订阅/月供类提醒，回复中可简要提**规则**（如「每月15号」「按年续费」）；**具体本次响铃时刻**以系统追加行为准

【回复版式·记录确认】
- **禁止**输出「记录详情」「事项」「类别」「记录人」等**字段名式**列表或键值块（用户不是在看数据库导出）
- **禁止**用 Markdown **表格**、或 **加粗小标题 + 多条列表** 来排版、复述刚记下的内容

【禁止行为】（记录场景：用户只是在陈述要记的事，**不是在征求意见**）
- **禁止**对用户所记的消费品、事件、选择发表评价、感想或价值判断（例如「冰箱可是提升生活幸福感的好东西」「这个选择很明智」「真是个好主意」「太棒了」等）
- 确认记录时用「已记下」「好的，记下了」「收到」等**简短确认**即可，**不加**评论、感慨或延伸议论
- **禁止**把对方的陈述当成聊天话题展开；用户不是在请你点评或聊天
不需要输出任何JSON，数据已由系统自动提取。`;
        }
      }

      if (postExtractInject.trim()) {
        systemPrompt += postExtractInject;
      }

      if (injectPrincipalForConfirmRound) {
        systemPrompt += `\n\n【事主】本次记录的事主即当前发言用户本人（系统内姓名仅供对齐数据：${currentUserMemberName}）。**回复面向用户时只称「你」**，禁止直呼该姓名，禁止「作为儿子/女儿/妻子/丈夫」等身份评语；禁止说成其他家庭成员。`;
      }

      if (isAuxiliaryChat) {
        systemPrompt += `\n\n【辅助账号·回复规范】后台仍会照常解析意图、抽取信息与写入提醒。你在**可见回复**中必须极简（建议总长不超过 80 字）：已写入记录用「已记录」或单独一行 ✓ 已记录；已设提醒可写「已设置提醒」等**不写具体钟点**；具体响铃时间由系统在写库成功后**自动追加在回复末尾**。信息不足时**只追问一个**短问题。禁止展开家庭隐私、禁止罗列待办/历史、禁止长篇闲聊或说教。`;
      } else {
        systemPrompt += `\n\n【权限与上下文】当前用户为 **家庭权限·完整对话** 模式。请针对本轮问题给出有信息量的实质回答；**禁止**仅用「已收到」「已记录」等无信息短句敷衍。若历史消息里有极短占位句，多为早期或辅助场景的提示，**请勿模仿**为当前轮的默认篇幅。`;
      }

      const finalSystemPrompt = systemPrompt;

      const model =
        isAuxiliaryChat || !intent.needs_deep_reasoning ? 'deepseek-chat' : 'deepseek-reasoner';
      console.log('[Chat] 意图分类:', {
        intent: intent.intent,
        needs_deep_reasoning: intent.needs_deep_reasoning,
        model,
        event_type: intent.event_type,
      });

      console.log('=== SYSTEM PROMPT ===\n', finalSystemPrompt);

      const deepseekMessages: { role: string; content: string }[] = [
        { role: 'system', content: finalSystemPrompt },
        ...messagesRef.current
          .filter(m =>
            !m.pending &&
            m.id !== 'welcome' &&
            m.text !== '抱歉，没有收到回复，请再试一次。' &&
            m.text !== '已停止回复' &&
            m.text.length > 0 &&
            !(m.role === 'assistant' && isAiLimitedCannedReply(m.text))
          )
          .slice(-20)
          .map(m => ({ role: m.role, content: m.text })),
        { role: 'user', content: text },
      ];
      if (sameEventVoiceHintForPrompt) {
        deepseekMessages.push({
          role: 'assistant',
          content: sameEventAssistantPrefillForApi(sameEventVoiceHintForPrompt),
        });
      }

      const requestBody = JSON.stringify({
        model,
        stream: false,
        max_tokens: isAuxiliaryChat ? 220 : intent.needs_deep_reasoning ? 1000 : 600,
        messages: deepseekMessages,
      });

      console.log('[Chat][DeepSeek] body ready', { chars: requestBody.length, model });

      /** 主对话请求体大；弱网下拉长等待，失败时最多 3 次尝试（含 HTTP 5xx/429 退避） */
      const AI_TIMEOUT_CHAT_MS = 120000;
      const AI_TIMEOUT_REASONER_MS = 180000;
      const timeoutMs = intent.needs_deep_reasoning ? AI_TIMEOUT_REASONER_MS : AI_TIMEOUT_CHAT_MS;

      /** fetch 期间循环更新省略号，让用户看到"还在转"而非静止气泡 */
      const loadingBaseText = intent.needs_deep_reasoning ? '正在深度思考' : '回复中';
      const loadingDots = ['…', '……', '………'];
      let loadingDotIdx = 0;
      loadingTickInterval = setInterval(() => {
        loadingDotIdx = (loadingDotIdx + 1) % loadingDots.length;
        setMessages(prev =>
          prev.map(m =>
            m.id === loadingId && m.pending
              ? { ...m, text: `${loadingBaseText}${loadingDots[loadingDotIdx]}` }
              : m
          )
        );
      }, 600);

      let aiData: any;
      fetchAttempts: for (let attempt = 0; attempt < 3; attempt++) {
        if (stoppedRef.current) {
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          throw new Error('已停止回复');
        }

        abortRef.current = new AbortController();
        const aiController = abortRef.current;
        aiAbortReasonRef.current = null;
        timerRef.current = setTimeout(() => {
          aiAbortReasonRef.current = 'timer';
          aiController.abort();
        }, timeoutMs);

        console.log('[Chat][DeepSeek] fetch start', {
          attempt: attempt + 1,
          maxAttempts: 3,
          timeoutMs,
          bodyChars: requestBody.length,
          model,
        });

        try {
          const aiRes = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            signal: aiController.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: requestBody,
          });

          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }

          if (!aiRes.ok) {
            const errText = await aiRes.text();
            if (attempt < 2 && (aiRes.status === 429 || aiRes.status >= 500)) {
              console.log('[Chat][DeepSeek] http retry', { status: aiRes.status, attempt: attempt + 1 });
              await sleep(1000 + Math.floor(Math.random() * 400));
              continue fetchAttempts;
            }
            throw new Error(`[DeepSeek ${aiRes.status}] ${errText.slice(0, 300) || '请求失败'}`);
          }

          aiData = await aiRes.json();
          console.log('[Chat][DeepSeek] fetch ok', { attempt: attempt + 1 });
          break fetchAttempts;
        } catch (err: any) {
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          const reasonAfter = aiAbortReasonRef.current;
          const retry =
            attempt < 2 &&
            !stoppedRef.current &&
            (reasonAfter === 'timer' ||
              isRetryableNetworkError(err) ||
              (isAbortLikeError(err) && reasonAfter !== 'user' && reasonAfter !== 'superseded'));
          if (retry) {
            aiAbortReasonRef.current = null;
            console.log('[Chat][DeepSeek] retry after error', {
              attempt: attempt + 1,
              reasonAfter,
              errName: err?.name,
              errMessage: err?.message,
            });
            await sleep(800);
            continue fetchAttempts;
          }
          throw err;
        }
      }

      const message = aiData?.choices?.[0]?.message;
      const rawReplyBody =
        message?.content ||
        message?.reasoning_content ||
        '抱歉，没有收到回复，请再试一次。';
      let rawReply = rawReplyBody;

      let displayReply = rawReply
        .replace(/```json[\s\S]*?```/gi, '')
        .replace(/\{[^{}]*"title"[^{}]*\}/g, '')
        // 只删除括号内含有 JSON 字段特征的内容，避免误删正常中文括号（如「（38.5°C）」「（下午3点）」）
        .replace(/[（(][^）)]*(?:remind_at|event_type|event_date|"title")[^）)]*[）)]/g, '')
        .trim();

      /** 提醒实际写库成功后由代码追加「已设好提醒…」，与 DB remind_at 一致（不依赖模型口述时刻） */
      if (extractPersistLater && !stoppedRef.current && requestId === currentRequestId.current) {
        try {
          const persistOutcome = await extractPersistLater();
          extractPersistRan = true;
          extractPersistLater = null;
          persistDiagnosisForLog = persistOutcome.persistDiagnosisLines;
          const { insertedReminderRemindAt } = persistOutcome;
          const persistLines = persistOutcome.persistDiagnosisLines;
          if (SHOW_EXTRACT_DEBUG && persistLines?.length) {
            setExtractDebugText(
              prev => `${prev}\n\n---\n[persist 执行]\n${persistLines.join('\n')}`
            );
          }
          if (insertedReminderRemindAt.length > 0) {
            const firstIso = insertedReminderRemindAt[0];
            const suffix = `\n已设好提醒，${formatReminderConfirmShanghaiDateTime(firstIso)} 提醒你。`;
            // 删除模型自行写的「已设好提醒，X月X日…提醒你」句（时间可能错误），统一用写库后的正确时间替换
            const stripModelConfirm = (s: string) =>
              s.replace(/\n?已设好提醒，[^\n。]*提醒你[^\n]*。?/g, '').trim();
            displayReply = `${stripModelConfirm(displayReply)}${suffix}`.trim();
            rawReply = `${stripModelConfirm(rawReply)}${suffix}`.trim();
          }
          if (persistOutcome.failedItems.length > 0) {
            const failMsg = `\n\n⚠️ 部分内容未能保存：${persistOutcome.failedItems.join('、')}。请稍后重试或检查网络。`;
            displayReply = `${displayReply}${failMsg}`.trim();
            rawReply = `${rawReply}${failMsg}`.trim();
          }
        } catch (e) {
          console.error('[Chat] extractPersist 在主回复前失败:', e);
          extractPersistRan = true;
          extractPersistLater = null;
          // persist 整体抛异常（非 Supabase error）：追加提示，让用户知道数据未保存
          const errMsg = e instanceof Error ? e.message : String(e);
          const failMsg = `\n\n⚠️ 记录未能保存（${errMsg.slice(0, 80)}），请稍后重试或检查网络。`;
          displayReply = `${displayReply}${failMsg}`.trim();
          rawReply = `${rawReply}${failMsg}`.trim();
        }
      }

      // 拿到整段回复后更新气泡（若 loading 行已被异步 load 冲掉，则追加一条，避免 map 空转仍误打 committed）
      if (!stoppedRef.current && requestId === currentRequestId.current) {
        setMessages(prev => {
          if (!prev.some(m => m.id === loadingId)) {
            console.log('[Chat] loading bubble missing, append assistant reply', { loadingId });
            return [
              ...prev,
              {
                id: loadingId,
                role: 'assistant',
                text: displayReply || rawReply,
                pending: false,
              },
            ];
          }
          return prev.map(m =>
            m.id === loadingId
              ? { ...m, text: displayReply || rawReply, pending: false }
              : m
          );
        });
        assistantReplyCommittedToUi = true;
        console.log('[DEBUG][reply] content:', rawReply);
        console.log('[Chat] assistant reply committed to UI');
      }

      if (stoppedRef.current || requestId !== currentRequestId.current) return;

      try {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        setTimeout(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium), 80);
        setTimeout(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium), 160);
        setTimeout(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light), 240);
      } catch (hapticsErr) {
        console.log('[Chat] Haptics skipped', hapticsErr);
      }

      try {
        const ins = await supabase
          .from('messages')
          .insert({ role: 'assistant', content: rawReply, conversation_id: conversationId } as any);
        if (ins.error) {
          console.log('[Chat] assistant message insert error', ins.error.message, ins.error);
        }
        const upd = await supabase
          .from('conversations')
          .update({
            last_message: displayReply.slice(0, 50),
            last_message_at: new Date().toISOString(),
          } as any)
          .eq('id', conversationId);
        if (upd.error) {
          console.log('[Chat] conversations update error', upd.error.message, upd.error);
        }
      } catch (persistErr) {
        console.log('[Chat] assistant persist threw', persistErr);
      }

    } catch (error: any) {
      if (assistantReplyCommittedToUi) {
        console.log('[Chat][send][catch] skipped UI overwrite (model ok, error after UI)', {
          errName: error?.name,
          errMessage: error?.message,
        });
        return;
      }
      /** RN 上 abort fetch 有时报 Network request timed out 而非 AbortError，须按「已停止」收口避免红屏与误提示 */
      const abortLike =
        stoppedRef.current ||
        aiAbortReasonRef.current === 'user' ||
        isAbortLikeError(error) ||
        error?.message === '已停止回复';
      let msg: string;
      if (abortLike) {
        if (stoppedRef.current || aiAbortReasonRef.current === 'user' || error?.message === '已停止回复') {
          msg = '已停止回复';
        } else if (aiAbortReasonRef.current === 'timer') {
          msg = '连接模型超时（内容较多或网络较慢），请稍后再试或缩短问题。';
        } else if (aiAbortReasonRef.current === 'superseded') {
          msg = '请求被中断，请重新发送。';
        } else {
          msg = '网络不稳定或已中断，请检查网络后重试。';
        }
      } else {
        msg = `出错了：${error?.message || String(error)}`;
      }
      console.log('[Chat][send][catch]', {
        abortLike,
        abortReason: aiAbortReasonRef.current,
        stopped: stoppedRef.current,
        errName: error?.name,
        errMessage: error?.message,
      });
      setMessages(prev => prev.map(m => m.id === loadingId ? { ...m, text: msg, pending: false } : m));
    } finally {
      if (loadingTickInterval !== null) {
        clearInterval(loadingTickInterval);
        loadingTickInterval = null;
      }
      if (extractPersistLater && !extractPersistRan) {
        void extractPersistLater()
          .then(out => {
            persistDiagnosisForLog = out.persistDiagnosisLines ?? persistDiagnosisForLog;
            const pl = out.persistDiagnosisLines;
            if (SHOW_EXTRACT_DEBUG && pl?.length) {
              setExtractDebugText(
                prev => `${prev}\n\n---\n[persist 执行·finally]\n${pl.join('\n')}`
              );
            }
            if (out.failedItems.length > 0) {
              console.error('[Chat] 延后写提醒/流水部分失败:', out.failedItems);
            }
            // 停止时 AI 气泡已被移除，但数据已写库 —— 追加一条确认气泡告知用户
            if (out.insertedReminderRemindAt && out.insertedReminderRemindAt.length > 0) {
              const firstIso = out.insertedReminderRemindAt[0];
              const confirmText = `已设好提醒，${formatReminderConfirmShanghaiDateTime(firstIso)} 提醒你。`;
              const confirmId = `confirm_${Date.now()}`;
              setMessages(prev => [
                ...prev,
                { id: confirmId, role: 'assistant' as const, text: confirmText, pending: false },
              ]);
            }
          })
          .catch(e => console.error('[Chat] 延后写提醒/流水失败:', e));
      }
      {
        const r = parseRemindersCountFromExtractDebugTrace(extractTraceForLog);
        const pastSkip = extractDebugTraceHasPastRemindAtSkip(extractTraceForLog);
        console.log('[Chat][send][roundSummary] ==========');
        console.log(
          JSON.stringify(
            {
              shouldRunExtractEarly: shouldRunExtractEarlyForLog,
              '[DEBUG][extract] reminders': r.foundExtractOutputLine
                ? r.remindersCount === null
                  ? '解析失败'
                  : r.remindersCount === 0
                    ? '空数组'
                    : `${r.remindersCount} 条`
                : '(无 extract output 行 / 未跑 prepare)',
              reminder_skip_pastRemindAt: pastSkip ? '是' : '否',
            },
            null,
            2
          )
        );
        console.log(
          '[Chat][send][roundSummary] full prepare debugTrace:\n',
          (extractTraceForLog ?? []).join('\n') || '(无)'
        );
        if (persistDiagnosisForLog?.length) {
          console.log('[Chat][send][roundSummary] persist diagnosis:\n', persistDiagnosisForLog.join('\n'));
        }
        console.log('[Chat][send][roundSummary] ========== end');
      }
      scheduleScrollToBottom();
      setIsAiReplying(false);
      abortRef.current = null;
      aiAbortReasonRef.current = null;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
    } finally {
      sendInFlightRef.current = false;
      setIsAiReplying(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.center}><Text style={s.loadingText}>加载中…</Text></View>
      </SafeAreaView>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        style={s.safe}
        behavior="padding"
        keyboardVerticalOffset={Platform.OS === 'ios' ? CHAT_KEYBOARD_VERTICAL_OFFSET : 0}>
        <SafeAreaView style={s.screen} edges={['top']}>

        <View style={s.header}>
          <Pressable onPress={() => router.back()} style={s.backBtn}>
            <Text style={s.backText}>‹ 返回</Text>
          </Pressable>
          <Text style={s.title} numberOfLines={1}>{conversationTitle}</Text>
          {extractDebugText.length > 0 ? (
            <Pressable
              style={s.backBtn}
              onPress={() => setExtractDebugModalOpen(true)}
              hitSlop={8}>
              <Text style={s.extractDebugHeaderBtn}>诊断</Text>
            </Pressable>
          ) : (
            <View style={s.backBtn} />
          )}
        </View>

        <View
          key={composerKavRemountNonce}
          style={s.screen}>
          <View style={{ flex: 1 }}>
            <FlatList
              ref={r => { listRef.current = r; }}
              data={messages}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              onScrollBeginDrag={Keyboard.dismiss}
              keyExtractor={m => m.id}
              renderItem={({ item }) => {
                const isUser = item.role === 'user';

                if (isUser) {
                  // 图片消息
                  if (item.fileType === 'image' && item.fileUri) {
                    console.log('rendering image:', item.fileUri);
                    return (
                      <View style={s.rowRight}>
                        <View style={s.fileBubble}>
                          <View style={{ position: 'relative' }}>
                          <Image
                            source={{ uri: item.fileUri }}
                            style={[s.imageThumb, item.pending && { opacity: 0.5 }]}
                            resizeMode="cover"
                            onError={(e) => console.log('图片加载失败:', e.nativeEvent.error, item.fileUri)}
                            onLoad={() => console.log('图片加载成功:', item.fileUri)}
                          />
                            {item.pending && (
                              <View style={s.uploadingOverlay}>
                                <ActivityIndicator size="small" color="#fff" />
                                <Text style={s.uploadingText}>上传中…</Text>
                              </View>
                            )}
                          </View>
                          <Text style={s.fileNameText} numberOfLines={1}>{item.fileName}</Text>
                        </View>
                      </View>
                    );
                  }
                  // PDF / 其他文件消息
                  if (item.fileType === 'pdf' || item.fileType === 'other') {
                    return (
                      <View style={s.rowRight}>
                        <View style={[s.fileBubble, item.pending && { opacity: 0.6 }]}>
                          <View style={s.fileIconWrap}>
                            {item.pending
                              ? <ActivityIndicator size="small" color={PRIMARY} />
                              : <Text style={s.fileIconText}>{item.fileType === 'pdf' ? '📄' : '📎'}</Text>
                            }
                          </View>
                          <Text style={s.fileNameText} numberOfLines={2}>{item.fileName}</Text>
                          {item.pending && <Text style={s.uploadingTextFile}>上传中…</Text>}
                        </View>
                      </View>
                    );
                  }
                  // 普通文字消息
                  return (
                    <View style={s.rowRight}>
                      <Pressable
                        style={s.userBubble}
                        onLongPress={() => {
                          Clipboard.setStringAsync(item.text);
                          Alert.alert('已复制', '消息已复制到剪贴板');
                        }}>
                        <Text style={s.userText} selectable>{item.text}</Text>
                      </Pressable>
                    </View>
                  );
                }

                // AI消息
                return (
                  <View style={s.aiRow}>
                    <View style={s.aiAvatar}>
                      <Logo13Icon size={20} gradientIdSuffix="chat-av" />
                    </View>
                    <View style={s.aiContent}>
                      {item.pending ? (
                        <Text style={s.pendingText} selectable>{item.text}</Text>
                      ) : (
                        <>
                          <Pressable onLongPress={() => {
                            Clipboard.setStringAsync(item.text);
                            Alert.alert('已复制', '消息已复制到剪贴板');
                          }}>
                            <Markdown style={markdownStyles}>{item.text}</Markdown>
                          </Pressable>
                          {item.reminderCancelChoices && item.reminderCancelChoices.length > 0 ? (
                            <View style={s.cancelChoicesWrap}>
                              {item.reminderCancelChoices.map(c => (
                                <Pressable
                                  key={c.id}
                                  style={({ pressed }) => [s.cancelChoiceBtn, pressed && s.cancelChoiceBtnPressed]}
                                  onPress={() => handleReminderCancelPick(c.id, c.title)}>
                                  <Text style={s.cancelChoiceTitle} numberOfLines={2}>{c.title}</Text>
                                  <Text style={s.cancelChoiceMeta}>{c.remindAtLabel}</Text>
                                  <Text style={s.cancelChoiceAction}>取消这条提醒</Text>
                                </Pressable>
                              ))}
                            </View>
                          ) : null}
                        </>
                      )}
                    </View>
                  </View>
                );
              }}
              contentContainerStyle={s.listContent}
              removeClippedSubviews={Platform.OS === 'android' ? false : undefined}
              showsVerticalScrollIndicator={false}
              ListFooterComponent={<Pressable style={{ height: 16 }} onPress={Keyboard.dismiss} />}
              onContentSizeChange={() => {
                if (!stickToBottomRef.current && !pendingInitialScrollToEndRef.current) return;
                requestAnimationFrame(() => {
                  listRef.current?.scrollToEnd({
                    animated: !pendingInitialScrollToEndRef.current,
                  });
                });
              }}
              onScroll={({ nativeEvent }) => {
                const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
                const fromBottom =
                  contentSize.height - layoutMeasurement.height - contentOffset.y;
                const nearBottom = fromBottom <= 72;
                if (
                  Date.now() >= suppressStickBottomResetUntilRef.current &&
                  !pendingInitialScrollToEndRef.current
                ) {
                  stickToBottomRef.current = nearBottom;
                }
                setShowScrollBtn(fromBottom > 100 && !pendingInitialScrollToEndRef.current);
              }}
              scrollEventThrottle={16}
              nestedScrollEnabled
            />
            {showScrollBtn && (
              <Pressable
                style={s.scrollBtn}
                onPress={() => {
                  stickToBottomRef.current = true;
                  listRef.current?.scrollToEnd({ animated: true });
                }}>
                <Text style={s.scrollBtnText}>↓ 最新消息</Text>
              </Pressable>
            )}
          </View>

          {/* 快捷引导 + 输入框；键盘收起时用 insets.bottom 抵 Home 条，键盘打开时不叠否则会拉大与键盘间距 */}
          <View
            style={[
              s.composerStack,
              !showQuickStartPanel && s.composerStackTopRule,
              { paddingBottom: keyboardOpen ? 0 : Math.max(0, insets.bottom) },
            ]}>
            <QuickStartPanel
              visible={showQuickStartPanel}
              onPick={handleQuickPick}
              inputRef={inputRef}
            />
            <View style={[s.composer, keyboardOpen && { paddingBottom: 6 }]}>
            <Pressable
              style={[s.attachBtn, isUploading && { opacity: 0.5 }]}
              onPress={handleAttach}
              disabled={isUploading}>
              {isUploading
                ? <ActivityIndicator size="small" color={PRIMARY} />
                : <Paperclip size={18} color={colors.mutedForeground} strokeWidth={1.5} />
              }
            </Pressable>

            <View style={s.inputWrap}>
            <TextInput
              ref={inputRef}
              value={input}
              onChangeText={t => {
                baseInputRef.current = t;
                setInput(t);
              }}
              onContentSizeChange={e => {
                const h = e.nativeEvent.contentSize.height;
                setInputHeight(Math.min(Math.max(h, INPUT_MIN_H), INPUT_MAX_H));
              }}
              placeholder="今天发生了什么…"
              placeholderTextColor={colors.mutedForeground}
              style={[s.input, { height: Math.max(inputHeight, INPUT_MIN_H) }]}
              multiline
              {...(Platform.OS === 'android' ? { textAlignVertical: 'top' as const } : {})}
              scrollEnabled
              returnKeyType="default"
              blurOnSubmit={false}
              editable={true}
            />
            </View>

            <Pressable
              style={[s.micBtn, isRecognizing && s.micBtnActive]}
              onPress={openVoiceInputModal}>
              <Mic
                size={18}
                color={isRecognizing ? PRIMARY : colors.mutedForeground}
                strokeWidth={1.5}
              />
            </Pressable>

            {isUploading ? (
              <View style={[s.sendBtn, { opacity: 0.4 }]}>
                <Send size={16} color="#fff" strokeWidth={2} />
              </View>
            ) : isAiReplying ? (
              <Pressable onPress={handleStop} style={s.stopBtn}>
                <Square size={14} color="#fff" strokeWidth={2} />
              </Pressable>
            ) : (
              <Pressable
                onPress={() => send()}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                style={({ pressed }) => [s.sendBtn, pressed && s.sendBtnPressed]}>
                <Send size={16} color="#fff" strokeWidth={2} />
              </Pressable>
            )}
            </View>
          </View>
        </View>

        {/* 新成员弹窗 */}
        <Modal visible={showNewMemberModal} transparent animationType="fade">
          <View style={s.modalOverlay}>
            <View style={s.modalSheet}>
              <View style={s.modalIconWrap}>
                <UserPlus size={24} color={PRIMARY} strokeWidth={1.5} />
              </View>
              <Text style={s.modalTitle}>发现新成员</Text>
              <Text style={s.modalDesc}>
                我注意到你提到了「{newMemberName}」，要把 TA 添加到家庭成员吗？
              </Text>
              <View style={s.modalBtns}>
                <Pressable
                  style={s.modalBtnSecondary}
                  onPress={() => {
                    if (authUserId && newMemberName) void recordDeclinedNewMemberName(authUserId, newMemberName);
                    setShowNewMemberModal(false);
                    setNewMemberName(null);
                  }}>
                  <Text style={s.modalBtnSecondaryText}>不用了</Text>
                </Pressable>
                <Pressable
                  style={s.modalBtnPrimary}
                  onPress={() => {
                    setShowNewMemberModal(false);
                    router.push({
                      pathname: '/family-members',
                      params: { autoOpenAdd: '1', prefillName: newMemberName || '' },
                    });
                  }}>
                  <Text style={s.modalBtnPrimaryText}>去添加</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <VoiceInputModal
          visible={showVoiceModal}
          transcript={voiceModalText}
          environmentError={voiceModalEnvError}
          isRecording={isRecognizing}
          onStopRecording={() => {
            const stopper = stopRecordingRef.current;
            if (stopper) {
              stopRecordingRef.current = null;
              stopper();
            }
          }}
          onReRecord={() => {
            beginVoiceRound();
          }}
          onClose={() => {
            setShowVoiceModal(false);
            setVoiceModalEnvError(null);
          }}
          onSend={() => {
            const t = voiceModalText.trim();
            if (!t || t === '识别中…') return;
            setShowVoiceModal(false);
            setVoiceModalEnvError(null);
            send(t);
          }}
        />

        <Modal
            visible={extractDebugModalOpen}
            animationType="slide"
            transparent
            onRequestClose={() => setExtractDebugModalOpen(false)}>
            <View style={s.extractDebugModalOverlay}>
              <View style={s.extractDebugModalSheet}>
                <Text style={s.extractDebugModalTitle}>抽取 / 去重诊断</Text>
                <Text style={s.extractDebugModalHint}>
                  Metro 可能不打印日志；此处含 gate 条件、prepare 轨迹（含 [DEBUG][extract] output）、debugDiag（含
                  reminderOpsCount、reminderOpsDetail、extractRemindersRaw），模型回复后追加 persist 段（含 about to
                  insert）。正式包可设 EXPO_PUBLIC_DEBUG_EXTRACT=1。
                </Text>
                <ScrollView style={s.extractDebugScroll} nestedScrollEnabled>
                  <Text style={s.extractDebugBody} selectable>
                    {extractDebugText.slice(0, 24000)}
                  </Text>
                </ScrollView>
                <View style={s.extractDebugModalActions}>
                  <Pressable
                    style={s.extractDebugModalBtn}
                    onPress={async () => {
                      await Clipboard.setStringAsync(extractDebugText);
                      Alert.alert('已复制', '诊断文本已复制');
                    }}>
                    <Text style={s.extractDebugModalBtnText}>复制</Text>
                  </Pressable>
                  <Pressable
                    style={[s.extractDebugModalBtn, s.extractDebugModalBtnPrimary]}
                    onPress={() => setExtractDebugModalOpen(false)}>
                    <Text style={[s.extractDebugModalBtnText, s.extractDebugModalBtnTextPrimary]}>关闭</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </Modal>

        </SafeAreaView>
      </KeyboardAvoidingView>
    </>
  );
}

const CHAT_PAGE_BG = '#F6F7F9';

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: CHAT_PAGE_BG },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { fontSize: 15, color: colors.mutedForeground },
  screen: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { width: 60 },
  backText: { fontSize: 17, color: PRIMARY },
  extractDebugHeaderBtn: { fontSize: 13, color: PRIMARY, fontWeight: '600', textAlign: 'right' },
  title: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '500', color: colors.foreground },
  listContent: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 16,
    flexGrow: 1,
    backgroundColor: CHAT_PAGE_BG,
  },
  rowRight: { flexDirection: 'row', justifyContent: 'flex-end' },
  userBubble: {
    maxWidth: '75%', backgroundColor: PRIMARY,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 18, borderBottomRightRadius: 4,
    shadowColor: PRIMARY, shadowOpacity: 0.2, shadowRadius: 6, elevation: 2,
  },
  userText: { fontSize: 15, lineHeight: 20, color: colors.primaryForeground },
  aiRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  aiAvatar: {
    width: 32, height: 32, borderRadius: 10,
    backgroundColor: colors.card,
    borderWidth: 0.5,
    borderColor: colors.border,
    justifyContent: 'center', alignItems: 'center', flexShrink: 0, marginTop: 2,
  },
  aiContent: { flex: 1, paddingTop: 4 },
  pendingText: { fontSize: 15, color: PRIMARY, fontStyle: 'italic' },
  cancelChoicesWrap: { marginTop: 12, gap: 8 },
  cancelChoiceBtn: {
    borderWidth: 1,
    borderColor: 'rgba(90, 108, 255, 0.35)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: 'rgba(90, 108, 255, 0.06)',
  },
  cancelChoiceBtnPressed: { opacity: 0.85 },
  cancelChoiceTitle: { fontSize: 15, fontWeight: '600', color: colors.foreground, marginBottom: 4 },
  cancelChoiceMeta: { fontSize: 13, color: colors.mutedForeground, marginBottom: 6 },
  cancelChoiceAction: { fontSize: 13, fontWeight: '600', color: PRIMARY },
  composerStack: {
    backgroundColor: CHAT_PAGE_BG,
  },
  /** 新对话展示快捷引导时不画上横线；引导收起后保留与消息区的分割 */
  composerStackTopRule: {
    borderTopWidth: 0.5,
    borderTopColor: colors.border,
  },
  composer: {
    flexDirection: 'row', gap: 8, alignItems: 'flex-end',
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12,
    backgroundColor: CHAT_PAGE_BG,
  },
  attachBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  micBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  micBtnActive: {
    backgroundColor: 'rgba(90, 108, 255, 0.15)',
  },
  /** flex 行内多行输入必须收紧宽度，否则 TextInput 被撑成「无限宽」→ 不换行、不增高 */
  inputWrap: {
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
  },
  input: {
    width: '100%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 0.5,
    borderColor: colors.hairline,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    color: colors.foreground,
    fontSize: 15,
    lineHeight: 22,
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: PRIMARY, alignItems: 'center', justifyContent: 'center',
    shadowColor: PRIMARY, shadowOpacity: 0.3, shadowRadius: 8, elevation: 3,
  },
  sendBtnPressed: { opacity: 0.85 },
  stopBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: PRIMARY, alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  scrollBtn: {
    position: 'absolute', bottom: 12, alignSelf: 'center',
    backgroundColor: PRIMARY, paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: 20, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 6, elevation: 4,
  },
  scrollBtnText: { color: colors.primaryForeground, fontSize: 13, fontWeight: '600' },
  extractDebugModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  extractDebugModalSheet: {
    maxHeight: '72%',
    backgroundColor: colors.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 28,
  },
  extractDebugModalTitle: { fontSize: 17, fontWeight: '700', color: colors.foreground, marginBottom: 6 },
  extractDebugModalHint: { fontSize: 12, color: colors.mutedForeground, marginBottom: 10, lineHeight: 18 },
  extractDebugScroll: { maxHeight: 420 },
  extractDebugBody: { fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: colors.foreground, lineHeight: 16 },
  extractDebugModalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 14 },
  extractDebugModalBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  extractDebugModalBtnPrimary: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  extractDebugModalBtnText: { fontSize: 15, color: colors.foreground },
  extractDebugModalBtnTextPrimary: { color: colors.primaryForeground, fontWeight: '600' },
  fileBubble: {
    maxWidth: '75%', backgroundColor: colors.card,
    borderRadius: 16, borderWidth: 0.5,
    borderColor: colors.hairline, overflow: 'hidden',
  },
  imageThumb: { width: 200, height: 150 },
  uploadingOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  uploadingText: { fontSize: 12, color: '#fff' },
  uploadingTextFile: { fontSize: 11, color: colors.mutedForeground, paddingHorizontal: 10, paddingBottom: 6 },
  fileIconWrap: { padding: 16, alignItems: 'center' },
  fileIconText: { fontSize: 36 },
  fileNameText: { fontSize: 12, color: colors.mutedForeground, paddingHorizontal: 10, paddingBottom: 8 },
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center', justifyContent: 'center', padding: 32,
  },
  modalSheet: {
    backgroundColor: colors.card, borderRadius: 24, padding: 24, width: '100%', alignItems: 'center',
  },
  modalIconWrap: {
    width: 56, height: 56, borderRadius: 18,
    backgroundColor: PRIMARY + '15', alignItems: 'center', justifyContent: 'center', marginBottom: 14,
  },
  modalTitle: { fontSize: 18, fontWeight: '600', color: colors.foreground, marginBottom: 8 },
  modalDesc: { fontSize: 14, color: colors.mutedForeground, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  modalBtns: { flexDirection: 'row', gap: 10, width: '100%' },
  modalBtnSecondary: {
    flex: 1, paddingVertical: 13, borderRadius: 14, backgroundColor: colors.muted, alignItems: 'center',
  },
  modalBtnSecondaryText: { fontSize: 15, color: colors.foreground, fontWeight: '500' },
  modalBtnPrimary: {
    flex: 1, paddingVertical: 13, borderRadius: 14, backgroundColor: PRIMARY, alignItems: 'center',
    shadowColor: PRIMARY, shadowOpacity: 0.25, shadowRadius: 8, elevation: 3,
  },
  modalBtnPrimaryText: { fontSize: 15, color: colors.primaryForeground, fontWeight: '500' },
});

