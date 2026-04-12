import { colors } from '@/constants/designTokens';
import { useFamilyAccess } from '@/contexts/FamilyAccessContext';
import { getShanghaiYmd } from '@/lib/reminderDates';
import { supabase } from '@/lib/supabase';
import { useFocusEffect, useRouter } from 'expo-router';
import { MessageCircle, Plus, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const PRIMARY = colors.primary;

type TodayReminder = {
  id: string;
  title: string;
  time: string;
  member?: string;
  completed?: boolean;
};

const CHAT_TAB_CACHE_TTL = 60 * 1000; // 60s：跨 remount 复用
let chatTabCache: {
  uid: string | null;
  familyId: string | null;
  conversations: Conversation[];
  conversationsFetchedAt: number;
} = {
  uid: null,
  familyId: null,
  conversations: [],
  conversationsFetchedAt: 0,
};

const formatDate = (dateStr: string) => {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days}天前`;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => { if (p.type !== 'literal') acc[p.type] = p.value; return acc; }, {});
  return `${parseInt(parts.month ?? '1', 10)}月${parseInt(parts.day ?? '1', 10)}日`;
};

type Conversation = {
  id: string;
  title: string;
  last_message: string | null;
  last_message_at: string | null;
  created_at: string;
};

export default function ConversationListScreen() {
  const router = useRouter();
  const { access } = useFamilyAccess();
  const showTodayReminderCard = Boolean(
    access && access.accessTier !== 'auxiliary'
  );
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [initialLoading, setInitialLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const userIdRef = useRef<string | null>(null);
  const familyIdRef = useRef<string | null>(null);
  const [showTopup, setShowTopup] = useState(false);
  const [todayReminders, setTodayReminders] = useState<TodayReminder[]>([]);
  const topupAnim = useRef(new Animated.Value(0)).current;
  /** 避免每次待办条数不变却重复播入场动画 */
  const topupWasVisibleRef = useRef(false);

  const activeReminders = todayReminders.filter((r) => !r.completed);

  const createAndOpenChat = useCallback(async (uid: string) => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })
      .formatToParts(now)
      .reduce<Record<string, string>>((acc, p) => { if (p.type !== 'literal') acc[p.type] = p.value; return acc; }, {});
    const title = `${parseInt(parts.month ?? '1', 10)}月${parseInt(parts.day ?? '1', 10)}日`;
    const { data, error } = await supabase
      .from('conversations')
      .insert({ user_id: uid, title } as any)
      .select('id, title')
      .single();
    if (error || !data) {
      console.error('[ChatTab] create conversation:', error?.message);
      return;
    }
    /** 下一轮 loadConversations 必须拉库，否则会命中「0 条」缓存 */
    chatTabCache = { ...chatTabCache, conversationsFetchedAt: 0 };
    router.push({ pathname: '/chat', params: { conversationId: data.id, title: data.title } });
  }, [router]);

  const loadTodayReminders = useCallback(async (familyId: string): Promise<TodayReminder[]> => {
    try {
      const t0 = Date.now();
      // 只拉取「今天」上海日历日内的 remind_at（与写入侧 dateFromShanghaiWallClock 一致）
      const ymd = getShanghaiYmd();
      const startIso = new Date(`${ymd}T00:00:00+08:00`).toISOString();
      const endIso = new Date(`${ymd}T23:59:59.999+08:00`).toISOString();

      const { data, error } = await supabase
        .from('reminders')
        .select('id, title, related_member, remind_at, is_done')
        .eq('family_id', familyId)
        .eq('is_done', false)
        .gte('remind_at', startIso)
        .lte('remind_at', endIso)
        .limit(50)
        .order('remind_at', { ascending: true });

      if (error) {
        console.error('[ChatTab] loadTodayReminders error:', error.message);
        setTodayReminders([]);
        return [];
      }

      const list: TodayReminder[] = (data || [])
        .map((r) => ({
          id: r.id,
          title: r.title,
          time: new Date(r.remind_at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }),
          member: r.related_member || undefined,
          completed: r.is_done,
        }));
      setTodayReminders(list);
      console.log('[ChatTab] loadTodayReminders:', { familyId, count: list.length, ms: Date.now() - t0 });
      return list;
    } catch {
      setTodayReminders([]);
      return [];
    }
  }, []);

  const loadConversations = useCallback(async (uid: string, silent = false) => {
    const t0 = Date.now();
    const now = Date.now();
    const cacheValid = chatTabCache.uid === uid && (now - chatTabCache.conversationsFetchedAt) < CHAT_TAB_CACHE_TTL;
    if (silent && cacheValid) {
      setConversations(chatTabCache.conversations);
      console.log('[ChatTab] loadConversations cache hit:', { uid, count: chatTabCache.conversations.length });
      return chatTabCache.conversations.length;
    }

    if (!silent) setRefreshing(true);
    const { data, error } = await supabase
      .from('conversations')
      .select('id, title, last_message, last_message_at, created_at')
      .eq('user_id', uid)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(50);
    if (!error) {
      const list = (data || []) as Conversation[];
      setConversations(list);
      chatTabCache = { ...chatTabCache, uid, conversations: list, conversationsFetchedAt: now };
    } else {
      console.error('[ChatTab] loadConversations error:', error.message);
    }
    if (!silent) setRefreshing(false);
    if (!error) console.log('[ChatTab] loadConversations:', { uid, count: (data || []).length, ms: Date.now() - t0 });
    return (data || []).length;
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      topupWasVisibleRef.current = false;

      const applyTopupFromReminders = (list: TodayReminder[]) => {
        const n = list.filter((r) => !r.completed).length;
        if (!active) return;
        setShowTopup(n > 0);
      };

      (async () => {
        // 第一次加载
        if (!userIdRef.current) {
          console.log('[ChatTab] focus first load');
          const { data: { user } } = await supabase.auth.getUser();
          if (!active) return;
          if (!user) { router.replace('/login'); return; }
          userIdRef.current = user.id;
          setUserId(user.id);

          // 获取 family_id 并缓存
          const { data: userData } = await supabase
            .from('users').select('family_id').eq('id', user.id).single();
          familyIdRef.current = userData?.family_id || null;
          chatTabCache = { ...chatTabCache, uid: user.id, familyId: familyIdRef.current };

          // 先用缓存立刻渲染（跨 remount）
          const cacheValid = chatTabCache.uid === user.id && (Date.now() - chatTabCache.conversationsFetchedAt) < CHAT_TAB_CACHE_TTL;
          if (cacheValid && chatTabCache.conversations.length > 0) {
            setConversations(chatTabCache.conversations);
          }

          let reminders: TodayReminder[] = [];
          let convCount = 0;
          try {
            convCount = await loadConversations(user.id, true);
            if (familyIdRef.current && showTodayReminderCard) {
              reminders = await loadTodayReminders(familyIdRef.current);
            }
          } catch (e) {
            console.error('[ChatTab] load parallel failed:', e);
          }
          if (!active) return;
          if (convCount === 0) {
            await createAndOpenChat(user.id);
            if (!active) return;
          }
          applyTopupFromReminders(reminders);
          setInitialLoading(false);
          console.log('[ChatTab] focus first load done');
        } else {
          // 再次进入「聊天」Tab：重新拉待办，有待办才展示 topup，再开始 15s 倒计时
          console.log('[ChatTab] focus refresh');
          if (!familyIdRef.current) {
            const { data: userData } = await supabase
              .from('users').select('family_id').eq('id', userIdRef.current).single();
            familyIdRef.current = userData?.family_id || null;
          }
          let reminders: TodayReminder[] = [];
          let convCount = 0;
          try {
            convCount = await loadConversations(userIdRef.current, true);
            if (familyIdRef.current && showTodayReminderCard) {
              reminders = await loadTodayReminders(familyIdRef.current);
            }
          } catch (e) {
            console.error('[ChatTab] refresh parallel failed:', e);
          }
          if (!active) return;
          if (convCount === 0) {
            await createAndOpenChat(userIdRef.current);
            if (!active) return;
          }
          applyTopupFromReminders(reminders);
        }
      })();

      return () => {
        active = false;
        setShowTopup(false);
        topupWasVisibleRef.current = false;
        topupAnim.setValue(0);
      };
    }, [createAndOpenChat, loadConversations, loadTodayReminders, router, showTodayReminderCard])
  );

  /** 仅首次展开时播一次动画；useNativeDriver:false 避免部分 Android release 上透明度不生效 */
  useEffect(() => {
    const visible = showTodayReminderCard && showTopup && activeReminders.length > 0;
    if (visible && !topupWasVisibleRef.current) {
      topupWasVisibleRef.current = true;
      topupAnim.setValue(0);
      Animated.timing(topupAnim, { toValue: 1, duration: 280, useNativeDriver: false }).start();
    } else if (!visible) {
      topupWasVisibleRef.current = false;
      topupAnim.setValue(0);
    }
  }, [showTodayReminderCard, showTopup, activeReminders.length, topupAnim]);

  /** 展示期间 15s 后收起；依赖不含「待办条数」细微变化，避免 Expo 下反复重置计时 */
  useEffect(() => {
    if (!showTodayReminderCard || !showTopup || activeReminders.length === 0) return;
    const timer = setTimeout(() => setShowTopup(false), 15000);
    return () => clearTimeout(timer);
  }, [showTodayReminderCard, showTopup]);

  const handleCloseTopup = () => setShowTopup(false);
  const handleViewAll = () => {
    setShowTopup(false);
    router.push('/(tabs)/records');
  };

  const onRefresh = useCallback(async () => {
    if (!userIdRef.current) return;
    await loadConversations(userIdRef.current, false);
    const list =
      familyIdRef.current && showTodayReminderCard
        ? await loadTodayReminders(familyIdRef.current)
        : [];
    const n = list.filter((r) => !r.completed).length;
    if (n > 0) {
      setShowTopup(false);
      topupWasVisibleRef.current = false;
      setTimeout(() => setShowTopup(true), 0);
    } else {
      setShowTopup(false);
    }
  }, [loadConversations, loadTodayReminders, showTodayReminderCard]);

  const createNewConversation = async () => {
    const uid = userIdRef.current;
    if (!uid) return;
    await createAndOpenChat(uid);
  };

  const openConversation = (item: Conversation) => {
    router.push({ pathname: '/chat', params: { conversationId: item.id, title: item.title } });
  };

  if (initialLoading) {
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.center}><Text style={s.loadingText}>加载中…</Text></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <Text style={s.headerTitle}>聊天</Text>
      </View>

      {showTodayReminderCard && showTopup && activeReminders.length > 0 && (
        <Animated.View
          style={[
            s.topupWrap,
            {
              opacity: topupAnim,
              transform: [
                {
                  translateY: topupAnim.interpolate({ inputRange: [0, 1], outputRange: [-100, 0] }),
                },
              ],
            },
          ]}>
          <View style={s.topupCard}>
            <View style={s.topupLeft}>
              <View style={s.topupLabelRow}>
                <View style={s.topupDot} />
                <Text style={s.topupLabel}>今天 · {activeReminders.length}件待办</Text>
              </View>
              <Text style={s.topupEarliest} numberOfLines={1}>
                最早：{activeReminders[0]?.time} {activeReminders[0]?.title}
              </Text>
            </View>
            <View style={s.topupRight}>
              <Pressable onPress={handleViewAll} style={s.topupViewAll}>
                <Text style={s.topupViewAllText}>查看全部</Text>
              </Pressable>
              <Pressable onPress={handleCloseTopup} style={s.topupClose}>
                <X size={14} color="rgba(0,0,0,0.4)" strokeWidth={2} />
              </Pressable>
            </View>
          </View>
        </Animated.View>
      )}

      {conversations.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyIcon}>💬</Text>
          <Text style={s.emptyTitle}>还没有对话</Text>
          <Text style={s.emptyDesc}>点击右下角按钮开始记录家里的事情</Text>
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={item => item.id}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={7}
          removeClippedSubviews
          renderItem={({ item }) => (
            <Pressable
              onPress={() => openConversation(item)}
              style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.muted }]}>
              <View style={s.iconWrap}>
                <MessageCircle size={20} color={PRIMARY} strokeWidth={1.5} />
              </View>
              <View style={s.rowBody}>
                <View style={s.rowTop}>
                  <Text style={s.cardTitle}>{item.title}</Text>
                  <Text style={s.cardTime}>
                    {item.last_message_at
                      ? formatDate(item.last_message_at)
                      : formatDate(item.created_at)}
                  </Text>
                </View>
                <Text style={s.cardPreview} numberOfLines={1}>
                  {item.last_message || '还没有消息'}
                </Text>
              </View>
            </Pressable>
          )}
          contentContainerStyle={s.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PRIMARY} />
          }
        />
      )}

      <Pressable
        style={({ pressed }) => [s.fab, pressed && { opacity: 0.85 }]}
        onPress={createNewConversation}>
        <Plus size={26} color={colors.primaryForeground} strokeWidth={2} />
      </Pressable>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { fontSize: 15, color: colors.mutedForeground },
  header: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 20,
  },
  headerTitle: { fontSize: 28, fontWeight: '500', color: colors.foreground },
  topupWrap: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 8 },
  topupCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(124, 139, 255, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(124, 139, 255, 0.35)',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  topupLeft: { flex: 1, minWidth: 0 },
  topupLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  topupDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: PRIMARY },
  topupLabel: { fontSize: 13, color: 'rgba(31,31,31,0.7)' },
  topupEarliest: { fontSize: 13, color: 'rgba(31,31,31,0.5)', paddingLeft: 14 },
  topupRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  topupViewAll: { paddingHorizontal: 8, paddingVertical: 4 },
  topupViewAllText: { fontSize: 12, color: PRIMARY },
  topupClose: {
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  listContent: { paddingBottom: 100 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: colors.card, paddingHorizontal: 24, paddingVertical: 14,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  iconWrap: {
    width: 44, height: 44, borderRadius: 14,
    backgroundColor: PRIMARY + '12', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  rowBody: { flex: 1 },
  rowTop: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4,
  },
  cardTitle: { fontSize: 15, fontWeight: '500', color: colors.foreground },
  cardTime: { fontSize: 12, color: colors.mutedForeground },
  cardPreview: { fontSize: 13, color: colors.mutedForeground, lineHeight: 18 },
  empty: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 40, gap: 12, paddingBottom: 80,
  },
  emptyIcon: { fontSize: 48, marginBottom: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '500', color: colors.foreground },
  emptyDesc: { fontSize: 14, color: colors.mutedForeground, textAlign: 'center', lineHeight: 20 },
  fab: {
    position: 'absolute', bottom: 100, right: 24,
    width: 56, height: 56, borderRadius: 18, backgroundColor: PRIMARY,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: PRIMARY, shadowOpacity: 0.35, shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
});