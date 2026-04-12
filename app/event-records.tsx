import { categoryColors, colors } from '@/constants/designTokens';
import { supabase } from '@/lib/supabase';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
    FlatList,
    Pressable,
    RefreshControl,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type RecordItem = {
  id: string;
  title: string | null;
  related_member: string | null;
  event_type: string | null;
  event_date: string | null;
  created_at: string;
};

const typeColor: Record<string, string> = { ...categoryColors };

const typeLabel: Record<string, string> = {
  health: '健康', finance: '财务', child: '孩子',
  vehicle: '车辆', house: '房产', relationship: '关系',
  admin: '行政', plant_pet: '植物宠物', daily: '日常',
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

export default function EventRecordsScreen() {
  const router = useRouter();
  const [events, setEvents] = useState<RecordItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadEvents = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data: userData } = await supabase
      .from('users').select('family_id').eq('id', user.id).single();
    const fid = userData?.family_id;
    if (!fid) return;
    const { data } = await supabase
      .from('family_events')
      .select('id, title, related_member, event_type, event_date, created_at')
      .eq('family_id', fid)
      .order('created_at', { ascending: false });
    setEvents(((data || []) as any[]).map(r => ({
      id: String(r.id), title: r.title ?? null,
      related_member: r.related_member ?? null,
      event_type: r.event_type ?? null,
      event_date: r.event_date ?? null,
      created_at: r.created_at,
    })));
  }, []);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    (async () => {
      try { if (!cancelled) await loadEvents(); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [loadEvents]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await loadEvents(); }
    finally { setRefreshing(false); }
  }, [loadEvents]);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.header}>
        <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/me')} style={s.backBtn}>
          <Text style={s.backText}>‹ 返回</Text>
        </Pressable>
        <Text style={s.headerTitle}>家庭记录</Text>
        <View style={s.backBtn} />
      </View>
      <FlatList
        data={events}
        keyExtractor={item => item.id}
        renderItem={({ item }) => {
          const color = typeColor[item.event_type ?? 'daily'] || colors.mutedForeground;
          const label = typeLabel[item.event_type ?? 'daily'] || '日常';
          return (
            <View style={s.card}>
              <Text style={s.cardTitle}>{item.title || '无摘要'}</Text>
              <View style={s.metaRow}>
                <View style={[s.tag, { backgroundColor: color + '18' }]}>
                  <Text style={[s.tagText, { color }]}>{label}</Text>
                </View>
                {item.related_member ? <Text style={s.metaText}>{item.related_member} · </Text> : null}
                <Text style={s.metaText}>{formatDate(item.created_at)}</Text>
              </View>
            </View>
          );
        }}
        contentContainerStyle={s.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyIcon}>📋</Text>
            <Text style={s.emptyTitle}>还没有家庭记录</Text>
            <Text style={s.emptyDesc}>在对话里告诉我发生了什么，我会自动记录</Text>
          </View>
        }
        ListFooterComponent={<View style={{ height: 24 }} />}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  backBtn: { width: 60 },
  backText: { fontSize: 17, color: colors.primary },
  headerTitle: { fontSize: 17, fontWeight: '500', color: colors.foreground },
  listContent: { paddingHorizontal: 24, paddingTop: 16 },
  card: {
    backgroundColor: colors.card, borderRadius: 20, padding: 18,
    marginBottom: 10, borderWidth: 0.5, borderColor: colors.border,
  },
  cardTitle: { fontSize: 17, fontWeight: '500', color: colors.foreground, marginBottom: 12 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  tag: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  tagText: { fontSize: 12, fontWeight: '500' },
  metaText: { fontSize: 13, color: colors.mutedForeground },
  empty: { alignItems: 'center', paddingTop: 60, gap: 10 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: 17, fontWeight: '500', color: colors.foreground },
  emptyDesc: { fontSize: 14, color: colors.mutedForeground, textAlign: 'center', lineHeight: 20 },
});