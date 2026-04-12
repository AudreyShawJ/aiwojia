import { colors, categoryColors } from '@/constants/designTokens';
import { completeReminderOccurrence } from '@/lib/completeReminderOccurrence';
import { formatRecurringRuleLabelChinese, formatReminderListMeta } from '@/lib/reminderDates';
import { supabase } from '@/lib/supabase';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Reminder = {
  id: string;
  title: string;
  related_member: string;
  remind_at: string;
  event_date?: string | null;
  source_type: string;
  recurring_rule: string | null;
  recurring_days?: number[] | null;
  is_done: boolean;
  event_type: string;
};

const TYPE_COLORS: Record<string, string> = { ...categoryColors };

const TYPE_LABELS: Record<string, string> = {
  health: '健康',
  finance: '财务',
  child: '孩子',
  vehicle: '车辆',
  house: '房产',
  relationship: '社会关系',
  admin: '行政',
  plant_pet: '植物宠物',
  daily: '日常',
};

const SOURCE_LABELS: Record<string, string> = {
  manual: '手动设置',
  ai_extract: 'AI建议',
  recurring: '周期提醒',
};

/** 「即将到来」：有事项日 event_date 则以其日历日为准，否则以 remind_at */
const isUpcoming = (remindAt: string, eventDate?: string | null) => {
  const ymd =
    eventDate && eventDate.length >= 10 ? eventDate.slice(0, 10) : null;
  const anchorMs = ymd
    ? new Date(`${ymd}T12:00:00+08:00`).getTime()
    : new Date(remindAt).getTime();
  if (Number.isNaN(anchorMs)) return false;
  const now = Date.now();
  const diff = anchorMs - now;
  return diff >= 0 && diff <= 7 * 24 * 60 * 60 * 1000;
};

export default function RemindersScreen() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadReminders = useCallback(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: userData } = await supabase
        .from('users')
        .select('family_id')
        .eq('id', user.id)
        .single();

      if (!userData?.family_id) return;

      const { data, error } = await supabase
        .from('reminders')
        .select('*')
        .eq('family_id', userData.family_id)
        .eq('is_done', false)
        .order('remind_at', { ascending: true });

      if (error) { console.error('读取提醒失败:', error.message); return; }
      setReminders(data || []);
    } catch (e) {
      console.error('加载提醒失败:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    loadReminders();
  }, [loadReminders]));

  const markDone = async (id: string) => {
    const res = await completeReminderOccurrence(id);
    if (!res.ok) {
      Alert.alert('操作失败', res.error);
      return;
    }
    await loadReminders();
  };

  const renderItem = ({ item }: { item: Reminder }) => {
    const color = TYPE_COLORS[item.event_type] || colors.mutedForeground;
    const label = TYPE_LABELS[item.event_type] || '日常';
    const upcoming = isUpcoming(item.remind_at, item.event_date);
    const sourceLabel = SOURCE_LABELS[item.source_type] || '';
    const recurringLabel = formatRecurringRuleLabelChinese(
      item.recurring_rule,
      item.recurring_days,
      item.event_date
    );

    return (
      <View style={[styles.card, upcoming && styles.cardUpcoming]}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <View style={styles.cardContent}>
          <Text style={styles.cardTitle}>{item.title}</Text>
          <View style={styles.meta}>
            <View style={[styles.tag, { backgroundColor: color + '20' }]}>
              <Text style={[styles.tagText, { color }]}>{label}</Text>
            </View>
            {item.related_member ? (
              <Text style={styles.metaText}>{item.related_member}</Text>
            ) : null}
            {item.remind_at ? (
              <Text style={[styles.metaText, upcoming && styles.metaUpcoming]}>
                {formatReminderListMeta(item.remind_at, item.event_date, item.recurring_rule)}
                {upcoming ? ' · 即将到来' : ''}
              </Text>
            ) : null}
            {recurringLabel ? (
              <Text style={styles.metaText}>🔄 {recurringLabel}</Text>
            ) : null}
            {sourceLabel ? (
              <Text style={styles.sourceText}>{sourceLabel}</Text>
            ) : null}
          </View>
        </View>
        <TouchableOpacity style={styles.doneBtn} onPress={() => markDone(item.id)}>
          <Text style={styles.doneBtnText}>完成</Text>
        </TouchableOpacity>
      </View>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.title}>提醒</Text>
        <Text style={styles.subtitle}>待办与跟进事项</Text>
      </View>
      <FlatList
        data={reminders}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        contentContainerStyle={reminders.length === 0 ? styles.emptyContainer : styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={loadReminders} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>🔔</Text>
            <Text style={styles.emptyTitle}>暂无提醒</Text>
            <Text style={styles.emptySubtitle}>
              告诉我需要跟进的事情{'\n'}我会帮你记住
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16 },
  title: { fontSize: 28, fontWeight: '700', color: colors.foreground },
  subtitle: { fontSize: 14, color: colors.mutedForeground, marginTop: 4 },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  emptyContainer: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.card, borderRadius: 14,
    padding: 16, marginBottom: 10,
    shadowColor: 'rgba(31,31,31,0.08)', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 1, shadowRadius: 8, elevation: 2, gap: 12,
  },
  cardUpcoming: { borderLeftWidth: 3, borderLeftColor: colors.primary },
  dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0, marginTop: 2, alignSelf: 'flex-start' },
  cardContent: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: '500', color: colors.foreground, marginBottom: 8 },
  meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  tag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  tagText: { fontSize: 11, fontWeight: '600' },
  metaText: { fontSize: 12, color: colors.mutedForeground },
  metaUpcoming: { color: colors.primary, fontWeight: '500' },
  sourceText: { fontSize: 11, color: colors.mutedForeground },
  doneBtn: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 8, backgroundColor: colors.muted,
  },
  doneBtnText: { fontSize: 13, color: colors.primary, fontWeight: '500' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 120 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: colors.foreground, marginBottom: 8 },
  emptySubtitle: { fontSize: 14, color: colors.mutedForeground, textAlign: 'center', lineHeight: 22 },
});