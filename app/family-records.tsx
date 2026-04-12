import { categoryColors, colors } from '@/constants/designTokens';
import { supabase } from '@/lib/supabase';
import { Stack, useRouter } from 'expo-router';
import { Baby, ChevronDown, ChevronUp, Heart, TrendingUp } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Dimensions,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const { width } = Dimensions.get('window');
const CHART_WIDTH = width - 48 - 40;
const CHART_HEIGHT = 160;

type MemoryItem = {
  id: string;
  title: string;
  description: string;
  event_date: string | null;
  created_at: string;
  event_type: string;
};

type GrowthItem = {
  id: string;
  child_name: string;
  recorded_date: string;
  height: number | null;
  weight: number | null;
};

type ExpenseItem = {
  event_type: string;
  total: number;
};

const EVENT_EMOJIS: Record<string, string> = {
  health: '🏥', child: '👶', finance: '💰',
  vehicle: '🚗', house: '🏠', relationship: '❤️',
  admin: '📋', plant_pet: '🌱', daily: '✨',
};

const EXPENSE_COLORS: Record<string, string> = { ...categoryColors };

const EXPENSE_LABELS: Record<string, string> = {
  health: '健康医疗', child: '孩子教育', finance: '财务',
  vehicle: '车辆', house: '房产', relationship: '社交',
  admin: '行政', plant_pet: '植物宠物', daily: '日常',
};

const formatMonth = (dateStr: string) => {
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${parseInt(m[2], 10)}月`;
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: 'numeric' })
    .formatToParts(new Date(dateStr))
    .find(x => x.type === 'month');
  return `${parseInt(p?.value ?? '1', 10)}月`;
};

const formatDate = (dateStr: string) => {
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(dateStr))
    .reduce<Record<string, string>>((acc, p) => { if (p.type !== 'literal') acc[p.type] = p.value; return acc; }, {});
  return `${parseInt(parts.month ?? '1', 10)}/${parseInt(parts.day ?? '1', 10)}`;
};

function LineChart({ data, color }: {
  data: { label: string; value: number }[];
  color: string;
}) {
  if (data.length < 2) return null;
  const values = data.map(d => d.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;
  const padY = CHART_HEIGHT * 0.1;

  const points = data.map((d, i) => ({
    x: (i / (data.length - 1)) * CHART_WIDTH,
    y: CHART_HEIGHT - padY - ((d.value - minVal) / range) * (CHART_HEIGHT - padY * 2),
    label: d.label,
    value: d.value,
  }));

  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={{ fontSize: 11, color: '#8E8E93' }}>{minVal}</Text>
        <Text style={{ fontSize: 11, color: '#8E8E93' }}>{maxVal}</Text>
      </View>
      <View style={{ height: CHART_HEIGHT + 20 }}>
        <View style={{ height: CHART_HEIGHT, position: 'relative' }}>
          {[0, 0.25, 0.5, 0.75, 1].map((r, i) => (
            <View key={i} style={{
              position: 'absolute', top: r * CHART_HEIGHT,
              left: 0, right: 0, height: 0.5,
              backgroundColor: 'rgba(31,31,31,0.06)',
            }} />
          ))}
          {points.slice(1).map((p, i) => {
            const prev = points[i];
            const dx = p.x - prev.x;
            const dy = p.y - prev.y;
            const length = Math.sqrt(dx * dx + dy * dy);
            const angle = Math.atan2(dy, dx) * 180 / Math.PI;
            return (
              <View key={i} style={{
                position: 'absolute', left: prev.x, top: prev.y,
                width: length, height: 2.5, backgroundColor: color,
                borderRadius: 1,
                transform: [{ rotate: `${angle}deg` }],
              }} />
            );
          })}
          {points.map((p, i) => (
            <View key={i} style={{
              position: 'absolute', left: p.x - 5, top: p.y - 5,
              width: 10, height: 10, borderRadius: 5,
              backgroundColor: color, borderWidth: 2, borderColor: '#fff',
              shadowColor: color, shadowOpacity: 0.3, shadowRadius: 3, elevation: 2,
            }} />
          ))}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
          {points.map((p, i) => (
            <Text key={i} style={{ fontSize: 9, color: '#8E8E93', textAlign: 'center' }}>
              {p.label}
            </Text>
          ))}
        </View>
      </View>
    </View>
  );
}

function PieChart({ data }: { data: ExpenseItem[] }) {
  const total = data.reduce((sum, d) => sum + d.total, 0);
  if (total === 0) return null;

  return (
    <View>
      <Text style={pie.total}>本月总支出 ¥{total.toLocaleString()}</Text>
      <View style={pie.barWrap}>
        {data.map((d, i) => (
          <View key={i} style={{
            flex: d.total / total,
            height: 20,
            backgroundColor: EXPENSE_COLORS[d.event_type] || '#8E8E93',
            borderTopLeftRadius: i === 0 ? 10 : 0,
            borderBottomLeftRadius: i === 0 ? 10 : 0,
            borderTopRightRadius: i === data.length - 1 ? 10 : 0,
            borderBottomRightRadius: i === data.length - 1 ? 10 : 0,
          }} />
        ))}
      </View>
      <View style={pie.grid}>
        {data.map((d, i) => {
          const pct = Math.round((d.total / total) * 100);
          const color = EXPENSE_COLORS[d.event_type] || '#8E8E93';
          return (
            <View key={i} style={pie.item}>
              <View style={[pie.dot, { backgroundColor: color }]} />
              <View style={{ flex: 1 }}>
                <Text style={pie.itemLabel}>{EXPENSE_LABELS[d.event_type] || d.event_type}</Text>
                <Text style={pie.itemValue}>¥{d.total.toLocaleString()}</Text>
              </View>
              <Text style={[pie.itemPct, { color }]}>{pct}%</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const pie = StyleSheet.create({
  total: { fontSize: 13, color: '#8E8E93', marginBottom: 14, textAlign: 'center' },
  barWrap: {
    flexDirection: 'row', height: 20, borderRadius: 10,
    overflow: 'hidden', marginBottom: 20, gap: 2,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  item: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    width: '47%', backgroundColor: '#F6F7F9', borderRadius: 12, padding: 10,
  },
  dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  itemLabel: { fontSize: 11, color: '#8E8E93' },
  itemValue: { fontSize: 14, fontWeight: '500', color: '#1F1F1F' },
  itemPct: { fontSize: 12, fontWeight: '500' },
});

export default function FamilyRecordsScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [showAllMemories, setShowAllMemories] = useState(false);
  const [growthData, setGrowthData] = useState<GrowthItem[]>([]);
  const [childNames, setChildNames] = useState<string[]>([]);
  const [selectedChild, setSelectedChild] = useState<string>('');
  const [expenses, setExpenses] = useState<ExpenseItem[]>([]);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: userData } = await supabase
        .from('users').select('family_id').eq('id', user.id).single();
      const fid = userData?.family_id;
      if (!fid) { setLoading(false); return; }

      const { data: eventsData } = await supabase
        .from('family_events')
        .select('id, title, description, event_date, created_at, event_type')
        .eq('family_id', fid)
        .eq('is_milestone', true)
        .order('event_date', { ascending: false, nullsFirst: false });
      setMemories((eventsData || []) as MemoryItem[]);

      const { data: growthRes } = await supabase
        .from('child_growth')
        .select('id, child_name, recorded_date, height, weight')
        .eq('family_id', fid)
        .order('recorded_date', { ascending: true });
      const growth = (growthRes || []) as GrowthItem[];
      setGrowthData(growth);
      const names = [...new Set(growth.map(g => g.child_name))];
      setChildNames(names);
      if (names.length > 0) setSelectedChild(names[0]);

      const todayShanghai = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date());
      const monthStart = `${todayShanghai}-01`;
      const { data: expenseRes } = await supabase
        .from('finance_transactions')
        .select('category, amount')
        .eq('family_id', fid)
        .eq('direction', 'expense')
        .gte('occurred_at', `${monthStart}T00:00:00+08:00`);

      const expMap: Record<string, number> = {};
      (expenseRes || []).forEach((e: any) => {
        expMap[e.category] = (expMap[e.category] || 0) + Number(e.amount || 0);
      });
      setExpenses(
        Object.entries(expMap)
          .map(([event_type, total]) => ({ event_type, total }))
          .sort((a, b) => b.total - a.total)
      );

      setLoading(false);
    })();
  }, []);

  const displayedMemories = showAllMemories ? memories : memories.slice(0, 3);
  const childGrowth = growthData.filter(g => g.child_name === selectedChild);
  const heightData = childGrowth.filter(g => g.height).map(g => ({ label: formatDate(g.recorded_date), value: g.height! }));
  const weightData = childGrowth.filter(g => g.weight).map(g => ({ label: formatDate(g.recorded_date), value: g.weight! }));

  if (loading) {
    return (
      <SafeAreaView style={s.safe}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={s.center}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backText}>‹ 返回</Text>
        </Pressable>
        <Text style={s.headerTitle}>家庭记录</Text>
        <View style={s.backBtn} />
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* 家庭记忆 */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Heart size={16} color={colors.primary} strokeWidth={1.5} />
            <Text style={s.sectionTitle}>家庭记忆</Text>
          </View>
          {memories.length === 0 ? (
            <View style={s.emptyCard}>
              <Text style={s.emptyText}>重要的家庭时刻会在这里留存，比如第一次看海、孩子学会走路、全家旅行……告诉 AI 你们的故事吧。</Text>
            </View>
          ) : (
            <>
              {displayedMemories.map((item, i) => (
                <View key={item.id} style={s.memoryRow}>
                  <View style={s.memoryLeft}>
                    <Text style={s.memoryMonth}>
                      {item.event_date ? formatMonth(item.event_date) : formatMonth(item.created_at)}
                    </Text>
                    <View style={[s.memoryEmoji, { backgroundColor: colors.primary + '15' }]}>
                      <Text style={{ fontSize: 22 }}>{EVENT_EMOJIS[item.event_type] || '✨'}</Text>
                    </View>
                    {i < displayedMemories.length - 1 && <View style={s.memoryLine} />}
                  </View>
                  <View style={s.memoryCard}>
                    <Text style={s.memoryTitle}>{item.title}</Text>
                    {item.description ? <Text style={s.memoryDesc} numberOfLines={2}>{item.description}</Text> : null}
                  </View>
                </View>
              ))}
              {memories.length > 3 && (
                <Pressable style={s.expandBtn} onPress={() => setShowAllMemories(!showAllMemories)}>
                  <Text style={s.expandBtnText}>
                    {showAllMemories ? '收起' : `展开全部（${memories.length}条）`}
                  </Text>
                  {showAllMemories
                    ? <ChevronUp size={14} color="#8E8E93" strokeWidth={2} />
                    : <ChevronDown size={14} color="#8E8E93" strokeWidth={2} />
                  }
                </Pressable>
              )}
            </>
          )}
        </View>

        {/* 孩子成长 */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Baby size={16} color={colors.primary} strokeWidth={1.5} />
            <Text style={s.sectionTitle}>孩子成长</Text>
          </View>
          {childNames.length === 0 ? (
            <View style={s.emptyCard}>
              <Text style={s.emptyText}>
                和 AI 聊聊孩子的成长吧，比如「仔仔现在110cm、18kg」，AI 会自动记录下来，慢慢就能看到属于你们家的成长曲线。
              </Text>
            </View>
          ) : (
            <View style={s.card}>
              {childNames.length > 1 && (
                <View style={s.childTabs}>
                  {childNames.map(name => (
                    <Pressable
                      key={name}
                      style={[s.childTab, selectedChild === name && s.childTabActive]}
                      onPress={() => setSelectedChild(name)}>
                      <Text style={[s.childTabText, selectedChild === name && s.childTabTextActive]}>{name}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
              <Text style={s.chartTitle}>{selectedChild}的成长曲线</Text>
              {heightData.length >= 2 ? (
                <View style={s.chartSection}>
                  <View style={s.chartLegend}>
                    <View style={[s.legendDot, { backgroundColor: colors.primary }]} />
                    <Text style={s.legendText}>身高（cm）</Text>
                  </View>
                  <LineChart data={heightData} color={colors.primary} />
                </View>
              ) : (
                <View style={s.chartPlaceholder}>
                  <Text style={s.chartPlaceholderText}>至少需要2条记录才能显示身高曲线</Text>
                </View>
              )}
              {weightData.length >= 2 ? (
                <View style={[s.chartSection, { marginTop: 20 }]}>
                  <View style={s.chartLegend}>
                    <View style={[s.legendDot, { backgroundColor: '#7C8BFF' }]} />
                    <Text style={s.legendText}>体重（kg）</Text>
                  </View>
                  <LineChart data={weightData} color="#7C8BFF" />
                </View>
              ) : (
                <View style={s.chartPlaceholder}>
                  <Text style={s.chartPlaceholderText}>至少需要2条记录才能显示体重曲线</Text>
                </View>
              )}
            </View>
          )}
        </View>

        {/* 消费习惯 */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <TrendingUp size={16} color={colors.primary} strokeWidth={1.5} />
            <Text style={s.sectionTitle}>消费习惯</Text>
          </View>
          {expenses.length === 0 ? (
            <View style={s.emptyCard}>
              <Text style={s.emptyText}>本月还没有消费记录，在对话里提到金额时 AI 会自动记录</Text>
            </View>
          ) : (
            <View style={s.card}>
              <PieChart data={expenses} />
            </View>
          )}
        </View>

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F6F7F9' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderBottomWidth: 0.5, borderBottomColor: 'rgba(31,31,31,0.06)',
  },
  backBtn: { width: 60 },
  backText: { fontSize: 17, color: colors.primary },
  headerTitle: { fontSize: 17, fontWeight: '500', color: '#1F1F1F' },
  scroll: { padding: 24 },
  section: { marginBottom: 28 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  sectionTitle: { fontSize: 16, fontWeight: '500', color: '#1F1F1F' },
  card: {
    backgroundColor: '#fff', borderRadius: 20, padding: 18,
    borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.06)',
  },
  emptyCard: {
    backgroundColor: '#fff', borderRadius: 20, padding: 20,
    borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.06)',
  },
  emptyText: { fontSize: 14, color: '#8E8E93', lineHeight: 22, textAlign: 'center' },
  memoryRow: { flexDirection: 'row', gap: 14, marginBottom: 12 },
  memoryLeft: { alignItems: 'center', width: 48 },
  memoryMonth: { fontSize: 11, color: '#8E8E93', marginBottom: 6 },
  memoryEmoji: {
    width: 48, height: 48, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  memoryLine: { width: 1.5, flex: 1, backgroundColor: 'rgba(31,31,31,0.08)', marginTop: 6 },
  memoryCard: {
    flex: 1, backgroundColor: '#fff', borderRadius: 16, padding: 14,
    borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.06)',
  },
  memoryTitle: { fontSize: 15, fontWeight: '500', color: '#1F1F1F', marginBottom: 4 },
  memoryDesc: { fontSize: 13, color: '#8E8E93', lineHeight: 18 },
  expandBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, backgroundColor: '#fff', borderRadius: 14, paddingVertical: 12,
    borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.06)', marginTop: 4,
  },
  expandBtnText: { fontSize: 14, color: '#8E8E93' },
  childTabs: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  childTab: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, backgroundColor: '#F6F7F9' },
  childTabActive: { backgroundColor: colors.primary },
  childTabText: { fontSize: 13, color: '#8E8E93', fontWeight: '500' },
  childTabTextActive: { color: '#fff' },
  chartTitle: { fontSize: 14, fontWeight: '500', color: '#1F1F1F', marginBottom: 16 },
  chartSection: {},
  chartLegend: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 12, color: '#8E8E93' },
  chartPlaceholder: {
    height: 80, backgroundColor: '#F6F7F9', borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', marginBottom: 8,
  },
  chartPlaceholderText: { fontSize: 12, color: '#C0C0C0', textAlign: 'center' },
});