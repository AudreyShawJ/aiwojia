import { categoryColors, colors } from '@/constants/designTokens';
import { useFamilyAccess } from '@/contexts/FamilyAccessContext';
import { showRecordsReminderTab, showRecordsReviewTab } from '@/lib/familyAccess';
import { completeReminderOccurrence } from '@/lib/completeReminderOccurrence';
import { cancelReminderAsDeclined } from '@/lib/reminderCancel';
import {
  addCalendarDaysShanghaiYmd,
  dateFromShanghaiWallClock,
  formatDaysLeft,
  formatRecurringRuleLabelChinese,
  formatReminderDisplayTime as formatDisplayTime,
  getReminderSortKey as getSortKey,
  getReminderStatus,
  getShanghaiHourMinuteFromIso,
  getShanghaiYmd,
  getShanghaiYmdFromEventDateField,
  getShanghaiYmdFromIso,
} from '@/lib/reminderDates';
import { supabase } from '@/lib/supabase';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import { AlertCircle, Baby, Calendar, Check, ChevronDown, ChevronUp, Clock, Heart, RefreshCw, Trash2, TrendingUp, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path, Line } from 'react-native-svg';

type TabType = 'reminders' | 'events';
type Priority = 'overdue' | 'today' | 'upcoming' | 'future';

type ReminderItem = {
  id: string;
  title: string;
  remind_at: string;
  event_type: string;
  related_member: string | null;
  is_done: boolean;
  recurring_rule: string | null;
  recurring_days: number[] | null;
  description?: string;
  event_date?: string | null;
  pending_expense_amount?: number | null;
  pending_expense_category?: string | null;
  linked_event_id?: string | null;
  completed_occurrence_count?: number | null;
};

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

const { width } = Dimensions.get('window');
/** 与「记录」页回顾区左右 padding 对齐（ScrollView 24 + 卡片 24）×2，避免折线与 x 轴标签宽度不一致导致日期与点对不齐 */
const CHART_WIDTH = Math.max(200, width - 96);
const CHART_HEIGHT = 200;

const typeColor: Record<string, string> = { ...categoryColors };

const typeLabel: Record<string, string> = {
  health: '健康', finance: '财务', child: '孩子',
  vehicle: '车辆', house: '房产', relationship: '关系',
  admin: '行政', plant_pet: '植物宠物', daily: '日常',
};

const REMINDER_SWIPE_DELETE_WIDTH = 100;

function deleteGradientForPriority(priority: Priority): [string, string] {
  switch (priority) {
    case 'overdue':
      return ['#EF4444', colors.destructive];
    /** 与同日历组内「完成」按钮 btnColor() #F59E0B 同系 */
    case 'today':
      return ['#F59E0B', '#D97706'];
    case 'upcoming':
      return [colors.primary, colors.accent];
    default:
      return ['#9CA3AF', '#6B7280'];
  }
}

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

const RECORDS_CACHE_TTL = 45 * 1000; // 45s 缓存
let recordsTabCache: {
  uid: string | null;
  familyId: string | null;
  reminders: ReminderItem[];
  fetchedAt: number;
} = { uid: null, familyId: null, reminders: [], fetchedAt: 0 };

const formatMonth = (dateStr: string) => {
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${parseInt(m[2], 10)}月`;
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: 'numeric' })
    .formatToParts(new Date(dateStr)).find(x => x.type === 'month');
  return `${parseInt(p?.value ?? '1', 10)}月`;
};

/** 图表横轴：优先按日历字符串解析，避免 YYYY-MM-DD 被当成 UTC 午夜在部分时区偏一天 */
const formatDateShort = (dateStr: string) => {
  const raw = String(dateStr);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`;
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })
      .formatToParts(d).reduce<Record<string, string>>((acc, p) => { if (p.type !== 'literal') acc[p.type] = p.value; return acc; }, {});
    return `${parseInt(parts.month ?? '1', 10)}/${parseInt(parts.day ?? '1', 10)}`;
  }
  return raw;
};

function localDateFromYmdHm(editDate: string, editTime: string): Date {
  const [y, m, d] = editDate.split('-').map(Number);
  const [h, min] = editTime.split(':').map(Number);
  return new Date(y, m - 1, d, Number.isFinite(h) ? h : 0, Number.isFinite(min) ? min : 0, 0, 0);
}

function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const mo = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

function formatHm(d: Date): string {
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function LineChart({
  data,
  color,
  standardData,
  unit = '',
}: {
  data: { label: string; value: number }[];
  color: string;
  standardData?: { label: string; value: number }[];
  unit?: string;
}) {
  if (data.length < 2) return null;
  const allValues = [...data.map(d => d.value), ...(standardData?.map(d => d.value) || [])];
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const range = maxVal - minVal || 1;
  const padY = CHART_HEIGHT * 0.15;

  const getY = (value: number) =>
    CHART_HEIGHT - padY - ((value - minVal) / range) * (CHART_HEIGHT - padY * 2);

  const points = data.map((d, i) => ({
    x: data.length === 1 ? CHART_WIDTH / 2 : (i / (data.length - 1)) * CHART_WIDTH,
    y: getY(d.value),
    label: d.label,
    value: d.value,
  }));

  const standardPoints =
    standardData && standardData.length >= 2
      ? standardData.map((d, i) => ({
          x: standardData.length === 1 ? CHART_WIDTH / 2 : (i / (standardData.length - 1)) * CHART_WIDTH,
          y: getY(d.value),
        }))
      : null;

  const toPath = (pts: { x: number; y: number }[]) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

  return (
    <View style={{ width: CHART_WIDTH, alignSelf: 'center' }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={{ fontSize: 12, color: '#8E8E93' }}>{maxVal}{unit}</Text>
        <Text style={{ fontSize: 12, color: '#8E8E93' }}>{minVal}{unit}</Text>
      </View>
      <View style={{ height: CHART_HEIGHT + 24, position: 'relative' }}>
        {/* 使用 SVG 绘制网格线和曲线 - Figma: stroke #E5E7EB, dashed 3 3 */}
        <Svg width={CHART_WIDTH} height={CHART_HEIGHT} style={{ position: 'absolute', left: 0, top: 0 }}>
          {/* 网格线 */}
          {[0, 0.25, 0.5, 0.75, 1].map((r, i) => (
            <Line
              key={i}
              x1={0}
              y1={r * CHART_HEIGHT}
              x2={CHART_WIDTH}
              y2={r * CHART_HEIGHT}
              stroke="#E5E7EB"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          ))}
          {/* 标准曲线 - 虚线 */}
          {standardPoints && standardPoints.length >= 2 && (
            <Path
              d={toPath(standardPoints)}
              stroke={color}
              strokeWidth={2}
              strokeDasharray="5 5"
              fill="none"
            />
          )}
          {/* 实际曲线 - 实线 */}
          <Path d={toPath(points)} stroke={color} strokeWidth={3} fill="none" />
        </Svg>
        {/* 数据点 - Figma: r: 4 */}
        {points.map((p, i) => (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: p.x - 4,
              top: p.y - 4,
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: color,
              borderWidth: 2,
              borderColor: '#fff',
              shadowColor: color,
              shadowOpacity: 0.3,
              shadowRadius: 3,
              elevation: 2,
            }}
          />
        ))}
        {/* x 轴标签：与数据点 x 对齐，避免整行 space-between 与 CHART_WIDTH 折线错位 */}
        {points.map((p, i) => {
          const labelW = 52;
          const left = Math.max(0, Math.min(CHART_WIDTH - labelW, p.x - labelW / 2));
          return (
            <Text
              key={i}
              style={{
                position: 'absolute',
                left,
                bottom: 0,
                width: labelW,
                fontSize: 11,
                color: '#8E8E93',
                textAlign: 'center',
              }}>
              {p.label}
            </Text>
          );
        })}
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
          <View key={i} style={{ flex: d.total / total, height: 20, backgroundColor: EXPENSE_COLORS[d.event_type] || '#8E8E93', borderTopLeftRadius: i === 0 ? 10 : 0, borderBottomLeftRadius: i === 0 ? 10 : 0, borderTopRightRadius: i === data.length - 1 ? 10 : 0, borderBottomRightRadius: i === data.length - 1 ? 10 : 0 }} />
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
  barWrap: { flexDirection: 'row', height: 20, borderRadius: 10, overflow: 'hidden', marginBottom: 20, gap: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, width: '47%', backgroundColor: '#F6F7F9', borderRadius: 12, padding: 10 },
  dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  itemLabel: { fontSize: 11, color: '#8E8E93' },
  itemValue: { fontSize: 14, fontWeight: '500', color: '#1F1F1F' },
  itemPct: { fontSize: 12, fontWeight: '500' },
});

function MemoryCard({
  item,
  isLast,
  onDelete,
}: {
  item: MemoryItem;
  isLast: boolean;
  onDelete: (id: string) => void;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const DELETE_W = 80;
  const THRESHOLD = -DELETE_W / 2;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_: any, g: any) =>
        Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_: any, g: any) => {
        if (g.dx < 0) translateX.setValue(Math.max(g.dx, -DELETE_W));
      },
      onPanResponderRelease: (_: any, g: any) => {
        if (g.dx < THRESHOLD) {
          Animated.spring(translateX, { toValue: -DELETE_W, useNativeDriver: true }).start();
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  return (
    <View style={fr.memoryRow}>
      {/* 左侧时间轴（不参与滑动） */}
      <View style={fr.memoryLeft}>
        <Text style={fr.memoryMonth}>
          {item.event_date ? formatMonth(item.event_date) : formatMonth(item.created_at)}
        </Text>
        <View style={[fr.memoryEmoji, { backgroundColor: colors.primary + '15' }]}>
          <Text style={{ fontSize: 22 }}>{EVENT_EMOJIS[item.event_type] || '✨'}</Text>
        </View>
        {!isLast && <View style={fr.memoryLine} />}
      </View>

      {/* 右侧：删除按钮在底层，卡片在上层 */}
      <View style={{ flex: 1, overflow: 'hidden', borderRadius: 16 }}>
        {/* 底层删除按钮 */}
        <View style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: DELETE_W, borderRadius: 16, overflow: 'hidden' }}>
          <LinearGradient
            colors={['#EF4444', '#DC2626']}
            start={{ x: 1, y: 0.5 }}
            end={{ x: 0, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
          <Pressable
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 }}
            onPress={() => {
              Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
              onDelete(item.id);
            }}>
            <Trash2 size={18} color="#fff" strokeWidth={2} />
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '500' }}>删除</Text>
          </Pressable>
        </View>

        {/* 滑动卡片 */}
        <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
          <View style={fr.memoryCard}>
            <Text style={fr.memoryTitle}>{item.title}</Text>
            {item.description ? (
              <Text style={fr.memoryDesc} numberOfLines={2}>{item.description}</Text>
            ) : null}
          </View>
        </Animated.View>
      </View>
    </View>
  );
}

function FamilyRecordsContent() {
  const [loading, setLoading] = useState(true);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [showAllMemories, setShowAllMemories] = useState(false);
  const [growthData, setGrowthData] = useState<GrowthItem[]>([]);
  const [childNames, setChildNames] = useState<string[]>([]);
  const [selectedChild, setSelectedChild] = useState<string>('');
  const [expenses, setExpenses] = useState<ExpenseItem[]>([]);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: userData } = await supabase.from('users').select('family_id').eq('id', user.id).single();
      const fid = userData?.family_id;
      if (!fid) { if (!cancelled) setLoading(false); return; }

      const todayShanghai = getShanghaiYmd();
      const monthStart = `${todayShanghai.slice(0, 7)}-01`;
      const [eventsData, growthRes, expenseRes] = await Promise.all([
        supabase.from('family_events').select('id, title, description, event_date, created_at, event_type').eq('family_id', fid).eq('is_milestone', true).order('event_date', { ascending: false, nullsFirst: false }),
        supabase.from('child_growth').select('id, child_name, recorded_date, height, weight').eq('family_id', fid).order('recorded_date', { ascending: true }),
        supabase.from('finance_transactions').select('category, amount').eq('family_id', fid).eq('direction', 'expense').gte('occurred_at', `${monthStart}T00:00:00+08:00`),
      ]);

      if (!cancelled) {
        const list = (eventsData.data || []) as MemoryItem[];
        list.sort((a, b) => {
          const timeA = new Date(a.event_date || a.created_at || 0).getTime();
          const timeB = new Date(b.event_date || b.created_at || 0).getTime();
          return timeB - timeA;
        });
        setMemories(list);
        const growth = (growthRes.data || []) as GrowthItem[];
        setGrowthData(growth);
        const names = [...new Set(growth.map(g => g.child_name))];
        setChildNames(names);
        if (names.length > 0) setSelectedChild(names[0]);
        const expMap: Record<string, number> = {};
        (expenseRes.data || []).forEach((e: any) => { expMap[e.category] = (expMap[e.category] || 0) + Number(e.amount || 0); });
        setExpenses(Object.entries(expMap).map(([event_type, total]) => ({ event_type, total })).sort((a, b) => b.total - a.total));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []));

  const handleDeleteMemory = async (id: string) => {
    setMemories(prev => prev.filter(m => m.id !== id));
    await supabase.from('family_events').delete().eq('id', id);
  };

  const displayedMemories = showAllMemories ? memories : memories.slice(0, 3);
  const childGrowth = [...growthData.filter(g => g.child_name === selectedChild)].sort((a, b) =>
    String(a.recorded_date).localeCompare(String(b.recorded_date))
  );
  const heightData = childGrowth.filter(g => g.height).map(g => ({ label: formatDateShort(g.recorded_date), value: g.height! }));
  const weightData = childGrowth.filter(g => g.weight).map(g => ({ label: formatDateShort(g.recorded_date), value: g.weight! }));
  // 标准曲线数据（与记录点对齐，用于参考）- 暂无出生日期时可不传
  const heightStandardData: { label: string; value: number }[] | undefined = undefined;
  const weightStandardData: { label: string; value: number }[] | undefined = undefined;

  if (loading) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.primary} /></View>;

  return (
    <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>

      {/* 家庭记忆 */}
      <View style={fr.section}>
        <View style={fr.sectionHeader}>
          <Heart size={16} color={colors.primary} strokeWidth={1.5} />
          <Text style={fr.sectionTitle}>家庭记忆</Text>
        </View>
        {memories.length === 0 ? (
          <View style={fr.emptyCard}><Text style={fr.emptyText}>重要的家庭时刻会在这里留存，比如第一次看海、孩子学会走路、全家旅行……告诉 AI 你们的故事吧。</Text></View>
        ) : (
          <>
            {displayedMemories.map((item, i) => (
              <MemoryCard
                key={item.id}
                item={item}
                isLast={i === displayedMemories.length - 1}
                onDelete={handleDeleteMemory}
              />
            ))}
            {memories.length > 3 && (
              <Pressable style={fr.expandBtn} onPress={() => setShowAllMemories(!showAllMemories)}>
                <Text style={fr.expandBtnText}>{showAllMemories ? '收起' : `展开全部（${memories.length}条）`}</Text>
                {showAllMemories ? <ChevronUp size={14} color="#8E8E93" strokeWidth={2} /> : <ChevronDown size={14} color="#8E8E93" strokeWidth={2} />}
              </Pressable>
            )}
          </>
        )}
      </View>

      {/* 孩子成长 - Figma 样式 */}
      <View style={fr.growthSection}>
        <View style={fr.growthSectionHeader}>
          <Baby size={16} color={colors.primary} strokeWidth={1.5} />
          <Text style={fr.growthSectionTitle}>孩子成长</Text>
        </View>
        {childNames.length === 0 ? (
          <View style={fr.growthCard}><Text style={fr.emptyText}>和 AI 聊聊孩子的成长吧，比如「仔仔现在110cm、18kg」，AI 会自动记录下来。</Text></View>
        ) : (
          <View style={fr.growthCard}>
            {childNames.length > 1 && (
              <View style={fr.childTabs}>
                {childNames.map(name => (
                  <Pressable key={name} style={[fr.childTab, selectedChild === name && fr.childTabActive]} onPress={() => setSelectedChild(name)}>
                    <Text style={[fr.childTabText, selectedChild === name && fr.childTabTextActive]}>{name}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            <View style={fr.growthChartHeader}>
              <Text style={fr.growthChartTitle}>{selectedChild}的成长曲线</Text>
              <Text style={fr.growthChartSubtitle}>身高体重发育情况</Text>
            </View>
            {heightData.length >= 2 ? (
              <View style={fr.growthChartBlock}>
                <View style={fr.growthLegend}>
                  <View style={[fr.growthLegendDot, { backgroundColor: colors.primary }]} />
                  <Text style={fr.growthLegendText}>身高 (cm)</Text>
                  <View style={[fr.growthLegendDot, { backgroundColor: colors.primary + '4D', marginLeft: 8 }]} />
                  <Text style={fr.growthLegendTextMuted}>标准值</Text>
                </View>
                <LineChart data={heightData} color={colors.primary} standardData={heightStandardData} />
              </View>
            ) : <View style={fr.chartPlaceholder}><Text style={fr.chartPlaceholderText}>至少需要2条记录才能显示身高曲线</Text></View>}
            {weightData.length >= 2 ? (
              <View style={fr.growthChartBlock}>
                <View style={fr.growthLegend}>
                  <View style={[fr.growthLegendDot, { backgroundColor: '#7C8BFF' }]} />
                  <Text style={fr.growthLegendText}>体重 (kg)</Text>
                  <View style={[fr.growthLegendDot, { backgroundColor: '#7C8BFF4D', marginLeft: 8 }]} />
                  <Text style={fr.growthLegendTextMuted}>标准值</Text>
                </View>
                <LineChart data={weightData} color="#7C8BFF" standardData={weightStandardData} />
              </View>
            ) : <View style={fr.chartPlaceholder}><Text style={fr.chartPlaceholderText}>至少需要2条记录才能显示体重曲线</Text></View>}
          </View>
        )}
      </View>

      {/* 消费习惯 */}
      <View style={fr.section}>
        <View style={fr.sectionHeader}>
          <TrendingUp size={16} color={colors.primary} strokeWidth={1.5} />
          <Text style={fr.sectionTitle}>消费习惯</Text>
        </View>
        {expenses.length === 0 ? (
          <View style={fr.emptyCard}><Text style={fr.emptyText}>本月还没有消费记录，在对话里提到金额时 AI 会自动记录</Text></View>
        ) : (
          <View style={fr.card}><PieChart data={expenses} /></View>
        )}
      </View>
    </ScrollView>
  );
}

const fr = StyleSheet.create({
  section: { marginBottom: 28 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  sectionTitle: { fontSize: 16, fontWeight: '500', color: '#1F1F1F' },
  card: { backgroundColor: '#fff', borderRadius: 20, padding: 18, borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.06)' },
  emptyCard: { backgroundColor: '#fff', borderRadius: 20, padding: 20, borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.06)' },
  emptyText: { fontSize: 14, color: '#8E8E93', lineHeight: 22, textAlign: 'center' },
  memoryRow: { flexDirection: 'row', gap: 14, marginBottom: 12 },
  memoryLeft: { alignItems: 'center', width: 48 },
  memoryMonth: { fontSize: 11, color: '#8E8E93', marginBottom: 6 },
  memoryEmoji: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  memoryLine: { width: 1.5, flex: 1, backgroundColor: 'rgba(31,31,31,0.08)', marginTop: 6 },
  memoryCard: { flex: 1, backgroundColor: '#fff', borderRadius: 16, padding: 14, borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.06)' },
  memoryTitle: { fontSize: 15, fontWeight: '500', color: '#1F1F1F', marginBottom: 4 },
  memoryDesc: { fontSize: 13, color: '#8E8E93', lineHeight: 18 },
  expandBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#fff', borderRadius: 14, paddingVertical: 12, borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.06)', marginTop: 4 },
  expandBtnText: { fontSize: 14, color: '#8E8E93' },
  childTabs: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  childTab: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, backgroundColor: '#F6F7F9' },
  childTabActive: { backgroundColor: colors.primary },
  childTabText: { fontSize: 13, color: '#8E8E93', fontWeight: '500' },
  childTabTextActive: { color: '#fff' },
  chartTitle: { fontSize: 14, fontWeight: '500', color: '#1F1F1F', marginBottom: 16 },
  chartLegend: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 12, color: '#8E8E93' },
  chartPlaceholder: { height: 200, backgroundColor: '#F6F7F9', borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  chartPlaceholderText: { fontSize: 12, color: '#C0C0C0', textAlign: 'center' },
  // 孩子成长 Figma 样式
  growthSection: { paddingTop: 16, paddingBottom: 24, marginBottom: 28 },
  growthSectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 },
  growthSectionTitle: { fontSize: 15, fontWeight: '500', color: '#1F1F1F', letterSpacing: -0.3 },
  growthCard: { backgroundColor: '#fff', borderRadius: 24, padding: 24, borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.06)', shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 8, elevation: 2 },
  growthChartHeader: { marginBottom: 24 },
  growthChartTitle: { fontSize: 14, fontWeight: '500', color: '#1F1F1F', letterSpacing: -0.3, marginBottom: 4 },
  growthChartSubtitle: { fontSize: 12, color: '#8E8E93' },
  growthChartBlock: { marginBottom: 32 },
  growthLegend: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  growthLegendDot: { width: 12, height: 12, borderRadius: 6 },
  growthLegendText: { fontSize: 13, color: '#1F1F1F' },
  growthLegendTextMuted: { fontSize: 13, color: '#8E8E93' },
});

export default function RecordsScreen() {
  const { access } = useFamilyAccess();
  const showReminderTab = showRecordsReminderTab(access ?? null);
  const showEventsTab = showRecordsReviewTab(access ?? null);

  const [activeTab, setActiveTab] = useState<TabType>('reminders');
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showFuture, setShowFuture] = useState(false);

  useEffect(() => {
    if (showReminderTab && !showEventsTab) setActiveTab('reminders');
    else if (!showReminderTab && showEventsTab) setActiveTab('events');
  }, [showReminderTab, showEventsTab]);

  const loadAll = useCallback(async (silent = false) => {
    const { data: { session } } = await supabase.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) return;
    const now = Date.now();
    const cacheValid = recordsTabCache.uid === uid && (now - recordsTabCache.fetchedAt) < RECORDS_CACHE_TTL;
    if (silent && cacheValid && recordsTabCache.reminders.length > 0) {
      setReminders(recordsTabCache.reminders);
      setLoading(false);
      return;
    }
    const { data: userData } = await supabase.from('users').select('family_id').eq('id', uid).single();
    const fid = userData?.family_id;
    if (!fid) return;
    const { data } = await supabase.from('reminders')
      .select(
        'id, title, description, remind_at, event_type, related_member, is_done, recurring_rule, recurring_days, event_date, pending_expense_amount, pending_expense_category, linked_event_id, completed_occurrence_count'
      )
      .eq('family_id', fid).eq('is_done', false)
      .order('remind_at', { ascending: true })
      .limit(100);
    const list = ((data || []) as ReminderItem[]).sort((a, b) => getSortKey(a).localeCompare(getSortKey(b)));
    recordsTabCache = { uid, familyId: fid, reminders: list, fetchedAt: Date.now() };
    setReminders(list);
  }, []);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const uid = session?.user?.id;
      if (!uid) { setLoading(false); return; }
      const now = Date.now();
      const cacheValid = recordsTabCache.uid === uid && (now - recordsTabCache.fetchedAt) < RECORDS_CACHE_TTL;
      if (cacheValid && recordsTabCache.reminders.length > 0) {
        setReminders(recordsTabCache.reminders);
        setLoading(false);
        loadAll(false).catch(() => {}); // 后台静默刷新
        return;
      }
      setLoading(true);
      try {
        await loadAll(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadAll]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await loadAll(); }
    finally { setRefreshing(false); }
  }, [loadAll]);

  const handleComplete = async (id: string) => {
    const res = await completeReminderOccurrence(id);
    if (!res.ok) {
      Alert.alert('操作失败', res.error);
      return;
    }
    if (res.mode === 'done') {
      const next = reminders.filter(r => r.id !== id);
      setReminders(next);
      recordsTabCache = { ...recordsTabCache, reminders: next, fetchedAt: Date.now() };
      return;
    }
    const { data: updated } = await supabase
      .from('reminders')
      .select(
        'id, title, description, remind_at, event_type, related_member, is_done, recurring_rule, recurring_days, event_date, pending_expense_amount, pending_expense_category, linked_event_id, completed_occurrence_count'
      )
      .eq('id', id)
      .single();
    if (updated) {
      const next = reminders
        .map(r => (r.id === id ? { ...r, ...updated } as ReminderItem : r))
        .sort((a, b) => getSortKey(a).localeCompare(getSortKey(b)));
      setReminders(next);
      recordsTabCache = { ...recordsTabCache, reminders: next, fetchedAt: Date.now() };
    } else {
      await loadAll(true);
    }
  };

  const handleCancel = async (id: string) => {
    const res = await cancelReminderAsDeclined(id);
    if (!res.ok) {
      Alert.alert('操作失败', res.error || '请稍后重试');
      return;
    }
    const next = reminders.filter(r => r.id !== id);
    setReminders(next);
    recordsTabCache = { ...recordsTabCache, reminders: next, fetchedAt: Date.now() };
  };

  const handleSaveEdit = async (id: string, updates: { title: string; description: string; event_date: string; remind_at: string }) => {
    try {
      await supabase.from('reminders').update({
        title: updates.title,
        description: updates.description || null,
        event_date: updates.event_date || null,
        remind_at: updates.remind_at,
      } as any).eq('id', id);
      const next = reminders.map(r => r.id === id ? { ...r, ...updates } : r).sort((a, b) => getSortKey(a).localeCompare(getSortKey(b)));
      setReminders(next);
      recordsTabCache = { ...recordsTabCache, reminders: next, fetchedAt: Date.now() };
    } catch (e) {
      console.error('保存失败', e);
    }
  };

  const handlePostpone = async (id: string, days: number) => {
    const reminder = reminders.find(r => r.id === id);
    if (!reminder) return;
    const baseYmd = reminder.event_date && reminder.event_date.length >= 10
      ? getShanghaiYmdFromEventDateField(reminder.event_date) ?? getShanghaiYmdFromIso(reminder.remind_at)
      : getShanghaiYmdFromIso(reminder.remind_at);
    const newEventDate = addCalendarDaysShanghaiYmd(baseYmd, days);
    const { hour, minute } = getShanghaiHourMinuteFromIso(reminder.remind_at);
    const newRemindAt = dateFromShanghaiWallClock(newEventDate, hour, minute).toISOString();
    const updated = { ...reminder, event_date: newEventDate, remind_at: newRemindAt };
    const next = reminders.map(r => r.id === id ? updated : r).sort((a, b) => getSortKey(a).localeCompare(getSortKey(b)));
    setReminders(next);
    recordsTabCache = { ...recordsTabCache, reminders: next, fetchedAt: Date.now() };
    if (getReminderStatus(newRemindAt, newEventDate) === 'future') setShowFuture(true);
    try {
      await supabase.from('reminders').update({ event_date: newEventDate, remind_at: newRemindAt } as any).eq('id', id);
    } catch (e) {
      setReminders(reminders);
      recordsTabCache = { ...recordsTabCache, reminders, fetchedAt: Date.now() };
    }
  };

  const overdueReminders = reminders.filter(r => getReminderStatus(r.remind_at, r.event_date) === 'overdue');
  const todayReminders = reminders.filter(r => getReminderStatus(r.remind_at, r.event_date) === 'today');
  const upcomingReminders = reminders.filter(r => getReminderStatus(r.remind_at, r.event_date) === 'upcoming');
  const futureReminders = reminders.filter(r => getReminderStatus(r.remind_at, r.event_date) === 'future');

  const showSegment = showReminderTab && showEventsTab;
  const headerTitle =
    showReminderTab && !showEventsTab ? '提醒'
      : !showReminderTab && showEventsTab ? '回顾'
        : activeTab === 'reminders' ? '提醒' : '回顾';

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <Text style={s.headerTitle}>{headerTitle}</Text>
        {showSegment ? (
          <View style={s.segmentRow}>
            {(['reminders', 'events'] as TabType[]).map(tab => (
              <Pressable key={tab} style={[s.segBtn, activeTab === tab && s.segBtnActive]} onPress={() => setActiveTab(tab)}>
                <Text style={[s.segBtnText, activeTab === tab && s.segBtnTextActive]}>
                  {tab === 'reminders' ? '提醒' : '回顾'}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      {showReminderTab && activeTab === 'reminders' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={[s.listContent, loading && reminders.length === 0 && { flex: 1, justifyContent: 'center' }]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>

          {loading && reminders.length === 0 ? (
            <View style={s.empty}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={[s.emptyDesc, { marginTop: 12 }]}>加载中…</Text>
            </View>
          ) : reminders.length === 0 ? (
            <View style={s.empty}>
              <Text style={s.emptyIcon}>🔔</Text>
              <Text style={s.emptyTitle}>暂无提醒</Text>
              <Text style={s.emptyDesc}>在对话里告诉AI需要提醒的事情</Text>
            </View>
          ) : null}

          {overdueReminders.length > 0 && (
            <View style={s.section}>
              <View style={s.sectionLabelRow}>
                <View style={[s.dot, { backgroundColor: '#EF4444' }]} />
                <Text style={[s.sectionLabel, { color: '#DC2626' }]}>已过期</Text>
                <Text style={[s.sectionCount, { color: '#EF4444' }]}>({overdueReminders.length})</Text>
              </View>
              {overdueReminders.map(r => <ReminderCard key={r.id} item={r} priority="overdue" onComplete={handleComplete} onPostpone={handlePostpone} onCancel={handleCancel} onSaveEdit={handleSaveEdit} />)}
            </View>
          )}

          {todayReminders.length > 0 && (
            <View style={s.section}>
              <View style={s.sectionLabelRow}>
                <View style={[s.dot, { backgroundColor: '#F59E0B' }]} />
                <Text style={[s.sectionLabel, { color: '#D97706' }]}>今天</Text>
                <Text style={[s.sectionCount, { color: '#F59E0B' }]}>({todayReminders.length})</Text>
              </View>
              {todayReminders.map(r => <ReminderCard key={r.id} item={r} priority="today" onComplete={handleComplete} onPostpone={handlePostpone} onCancel={handleCancel} onSaveEdit={handleSaveEdit} />)}
            </View>
          )}

          {upcomingReminders.length > 0 && (
            <View style={s.section}>
              <View style={s.sectionLabelRow}>
                <View style={[s.dot, { backgroundColor: '#3B82F6' }]} />
                <Text style={[s.sectionLabel, { color: '#2563EB' }]}>未来7天</Text>
                <Text style={[s.sectionCount, { color: '#3B82F6' }]}>({upcomingReminders.length})</Text>
              </View>
              {upcomingReminders.map(r => <ReminderCard key={r.id} item={r} priority="upcoming" onComplete={handleComplete} onPostpone={handlePostpone} onCancel={handleCancel} onSaveEdit={handleSaveEdit} />)}
            </View>
          )}

          {futureReminders.length > 0 && (
            <View style={s.section}>
              <Pressable style={s.sectionLabelRow} onPress={() => setShowFuture(!showFuture)}>
                <View style={[s.dot, { backgroundColor: '#9CA3AF' }]} />
                <Text style={[s.sectionLabel, { color: '#6B7280', flex: 1 }]}>更远</Text>
                <Text style={[s.sectionCount, { color: '#9CA3AF' }]}>({futureReminders.length})</Text>
                {showFuture ? <ChevronUp size={16} color="#9CA3AF" strokeWidth={2} /> : <ChevronDown size={16} color="#9CA3AF" strokeWidth={2} />}
              </Pressable>
              {showFuture && futureReminders.map(r => <ReminderCard key={r.id} item={r} priority="future" onComplete={handleComplete} onPostpone={handlePostpone} onCancel={handleCancel} onSaveEdit={handleSaveEdit} />)}
            </View>
          )}

          <View style={{ height: 24 }} />
        </ScrollView>
      )}

      {showEventsTab && activeTab === 'events' && <FamilyRecordsContent />}
    </SafeAreaView>
  );
}

function ReminderCard({ item, priority, onComplete, onPostpone, onCancel, onSaveEdit }: {
  item: ReminderItem; priority: Priority;
  onComplete: (id: string) => void; onPostpone: (id: string, days: number) => void;
  onCancel: (id: string) => void; onSaveEdit: (id: string, u: { title: string; description: string; event_date: string; remind_at: string }) => void;
}) {
  const [showPostpone, setShowPostpone] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [iosPicker, setIosPicker] = useState<null | 'date' | 'time'>(null);
  const editScrollMaxH = Math.min(420, Dimensions.get('window').height * 0.48);
  const [editTitle, setEditTitle] = useState(item.title);
  const translateX = useRef(new Animated.Value(0)).current;
  const DELETE_THRESHOLD = -72;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_: any, g: any) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_: any, g: any) => {
        if (g.dx < 0) translateX.setValue(Math.max(g.dx, DELETE_THRESHOLD));
      },
      onPanResponderRelease: (_: any, g: any) => {
        if (g.dx < DELETE_THRESHOLD / 2) {
          Animated.spring(translateX, { toValue: DELETE_THRESHOLD, useNativeDriver: true }).start();
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
        }
      },
    })
  ).current;
  const [editDescription, setEditDescription] = useState(item.description || '');
  const [editDate, setEditDate] = useState(() => {
    if (item.event_date && item.event_date.length >= 10)
      return getShanghaiYmdFromEventDateField(item.event_date) ?? item.event_date.slice(0, 10);
    return getShanghaiYmdFromIso(item.remind_at);
  });
  const [editTime, setEditTime] = useState(() => {
    const d = new Date(item.remind_at);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  });
  const color = typeColor[item.event_type] || '#8E8E93';
  const label = typeLabel[item.event_type] || '日常';
  const timeStr = formatDisplayTime(item);
  const isRecurring = !!item.recurring_rule;
  const recurringText =
    formatRecurringRuleLabelChinese(item.recurring_rule, item.recurring_days, item.event_date) ||
    (isRecurring ? '周期提醒' : '');

  const openDatePicker = () => {
    Keyboard.dismiss();
    const value = localDateFromYmdHm(editDate, editTime);
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value,
        mode: 'date',
        onChange: (ev, date) => {
          if (ev.type !== 'set' || !date) return;
          setEditDate(formatYmd(date));
        },
      });
    } else {
      setIosPicker('date');
    }
  };

  const openTimePicker = () => {
    Keyboard.dismiss();
    const value = localDateFromYmdHm(editDate, editTime);
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value,
        mode: 'time',
        is24Hour: true,
        onChange: (ev, date) => {
          if (ev.type !== 'set' || !date) return;
          setEditTime(formatHm(date));
        },
      });
    } else {
      setIosPicker('time');
    }
  };

  const handleSaveEdit = async () => {
    const newRemindAt = dateFromShanghaiWallClock(
      editDate,
      ...editTime.split(':').map(Number) as [number, number]
    ).toISOString();
    setIosPicker(null);
    setShowDetailModal(false);
    await onSaveEdit(item.id, {
      title: editTitle.trim(),
      description: editDescription.trim(),
      event_date: editDate,
      remind_at: newRemindAt,
    });
  };

  const cardStyle = () => { switch (priority) { case 'overdue': return s.cardOverdue; case 'today': return s.cardToday; case 'upcoming': return s.cardUpcoming; default: return s.cardFuture; } };
  const barColor = () => { switch (priority) { case 'overdue': return '#EF4444'; case 'today': return '#F59E0B'; case 'upcoming': return '#3B82F6'; default: return null; } };
  const titleColor = () => { switch (priority) { case 'overdue': return '#B91C1C'; case 'today': return '#92400E'; default: return '#1F1F1F'; } };
  const btnColor = () => { switch (priority) { case 'overdue': return '#DC2626'; case 'today': return '#F59E0B'; default: return colors.primary; } };
  const bc = barColor();

  const cardContent = (
    <View style={[s.card, cardStyle()]}>
      {bc && <View style={[s.leftBar, { backgroundColor: bc }]} />}
      <View style={{ paddingLeft: priority !== 'future' ? 12 : 0 }}>
        <Pressable onPress={() => setShowDetailModal(true)}>
          <View style={s.titleRow}>
            <Text style={[s.cardTitle, { color: titleColor(), flex: 1 }, priority === 'overdue' && { fontSize: 20 }, priority === 'today' && { fontSize: 18 }, priority === 'future' && { fontSize: 16, color: '#6B7280' }]} numberOfLines={2}>{item.title}</Text>
            <View style={[s.tag, { backgroundColor: color + '18', marginLeft: 8 }]}><Text style={[s.tagText, { color }]}>{label}</Text></View>
          </View>
          {item.description && (
            <Text style={[s.desc, priority === 'overdue' && { color: '#DC262680' }, priority === 'future' && { color: '#9CA3AF' }]} numberOfLines={2}>{item.description}</Text>
          )}
          <View style={s.metaRow}>
            {priority === 'overdue' ? (
              <View style={s.badgeOverdue}><AlertCircle size={11} color="#DC2626" strokeWidth={2.5} /><Text style={[s.badgeText, { color: '#DC2626' }]}>已过期</Text></View>
            ) : priority === 'today' ? (
              <View style={s.badgeToday}><Text style={[s.badgeText, { color: '#D97706' }]}>今天待办</Text></View>
            ) : (
              <View style={s.badgeFuture}><Text style={[s.badgeText, { color: '#8E8E93' }]}>待处理</Text></View>
            )}
            <View style={s.timeRow}>
              <Calendar size={13} color={priority === 'overdue' ? '#DC2626' : '#8E8E93'} strokeWidth={1.5} />
              <Text style={[s.timeText, priority === 'overdue' && { color: '#DC2626' }]}>{timeStr}</Text>
              {!isRecurring && formatDaysLeft(item.remind_at, item.event_date) && (
                <Text style={[s.timeText, { color: priority === 'overdue' ? '#DC2626' : '#8E8E93' }]}>· {formatDaysLeft(item.remind_at, item.event_date)}</Text>
              )}
            </View>
            {isRecurring && (
              <View style={s.recurringBadge}>
                <RefreshCw size={11} color={colors.primary} strokeWidth={2} />
                <Text style={s.recurringText}>
                  {recurringText}
                  {formatDaysLeft(item.remind_at, item.event_date) ? ` · ${formatDaysLeft(item.remind_at, item.event_date)}` : ''}
                  {(item.completed_occurrence_count ?? 0) > 0
                    ? ` · 已完成${item.completed_occurrence_count}次`
                    : ''}
                </Text>
              </View>
            )}
          </View>
        </Pressable>
        {priority !== 'future' && (
          <View style={s.actions}>
            <Pressable style={[s.btnComplete, { backgroundColor: btnColor() }]} onPress={() => onComplete(item.id)}>
              <Check size={14} color="#fff" strokeWidth={2.5} />
              <Text style={s.btnCompleteText}>完成</Text>
            </Pressable>
            <Pressable style={s.btnPostpone} onPress={() => setShowPostpone(true)}>
              <Clock size={14} color="#8E8E93" strokeWidth={2} />
              <Text style={s.btnPostponeText}>延期</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );

  return (
    <>
      <View style={s.reminderSwipeOuter}>
        <View style={s.reminderSwipeContainer}>
          {/* 底层删除按钮 */}
          <View style={[s.swipeDeleteTrack, { position: 'absolute', right: 0, top: 0, bottom: 0 }]}>
            <LinearGradient
              colors={deleteGradientForPriority(priority)}
              start={{ x: 1, y: 0.5 }}
              end={{ x: 0, y: 0.5 }}
              style={StyleSheet.absoluteFill}
            />
            <Pressable
              style={s.swipeDeletePressable}
              onPress={() => {
                onCancel(item.id);
                Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
              }}>
              <Trash2 size={20} color="#fff" strokeWidth={2} />
              <Text style={s.swipeDeleteLabel}>删除</Text>
            </Pressable>
          </View>
          {/* 滑动卡片 */}
          <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
            {cardContent}
          </Animated.View>
        </View>
      </View>
      <Modal visible={showPostpone} transparent animationType="fade">
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'flex-end' }} onPress={() => setShowPostpone(false)}>
          <Pressable onPress={e => e.stopPropagation()}>
            <View style={s.postponeSheet}>
              <View style={s.postponeHandle} />
              <Text style={s.postponeTitle}>推迟提醒</Text>
              {[{ label: '推迟1天', days: 1 }, { label: '推迟3天', days: 3 }, { label: '推迟1周', days: 7 }].map((opt, i) => (
                <Pressable key={opt.days} style={[s.postponeBtn, i < 2 && { borderBottomWidth: 0.5, borderBottomColor: 'rgba(31,31,31,0.06)' }]} onPress={() => { onPostpone(item.id, opt.days); setShowPostpone(false); }}>
                  <Text style={s.postponeBtnText}>{opt.label}</Text>
                </Pressable>
              ))}
              <Pressable style={[s.postponeBtn, { marginTop: 8, backgroundColor: '#F6F7F9', borderRadius: 14 }]} onPress={() => setShowPostpone(false)}>
                <Text style={[s.postponeBtnText, { color: '#8E8E93', textAlign: 'center' }]}>取消</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
      <Modal visible={showDetailModal} transparent animationType="slide">
        <KeyboardAvoidingView
          style={s.detailKeyboardRoot}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 12 : 0}>
          <View style={s.detailOverlay}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => {
                setIosPicker(null);
                setShowDetailModal(false);
              }}
            />
            <View style={s.detailSheet}>
              <View style={s.detailHandle} />
              <View style={s.detailHeader}>
                <Text style={s.detailTitle}>修改</Text>
                <Pressable
                  onPress={() => {
                    setIosPicker(null);
                    setShowDetailModal(false);
                  }}
                  style={s.detailCloseBtn}>
                  <X size={20} color="#8E8E93" strokeWidth={2} />
                </Pressable>
              </View>
              <ScrollView
                style={[s.detailForm, { maxHeight: editScrollMaxH }]}
                contentContainerStyle={s.detailFormContent}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator={false}>
                <View style={s.detailField}>
                  <Text style={s.detailLabel}>事项</Text>
                  <TextInput
                    style={s.detailInput}
                    value={editTitle}
                    onChangeText={setEditTitle}
                    placeholder="输入提醒事项"
                    placeholderTextColor="#8E8E93"
                  />
                </View>
                <View style={s.detailField}>
                  <Text style={s.detailLabel}>备注</Text>
                  <TextInput
                    style={[s.detailInput, s.detailTextArea]}
                    value={editDescription}
                    onChangeText={setEditDescription}
                    placeholder="添加备注（选填）"
                    placeholderTextColor="#8E8E93"
                    multiline
                    numberOfLines={3}
                  />
                </View>
                <View style={s.detailField}>
                  <Text style={s.detailLabel}>日期与时间</Text>
                  <View style={s.detailTimeRow}>
                    <Pressable style={[s.detailPickBtn, { flex: 1 }]} onPress={openDatePicker}>
                      <Calendar size={18} color={colors.primary} strokeWidth={2} />
                      <Text style={s.detailPickBtnText}>{editDate}</Text>
                    </Pressable>
                    <Pressable style={[s.detailPickBtn, { width: 112 }]} onPress={openTimePicker}>
                      <Clock size={18} color={colors.primary} strokeWidth={2} />
                      <Text style={s.detailPickBtnText}>{editTime}</Text>
                    </Pressable>
                  </View>
                  {Platform.OS === 'ios' && iosPicker ? (
                    <View style={s.iosPickerWrap}>
                      <DateTimePicker
                        value={localDateFromYmdHm(editDate, editTime)}
                        mode={iosPicker}
                        display="spinner"
                        locale="zh-CN"
                        onChange={(_, date) => {
                          if (!date) return;
                          if (iosPicker === 'date') setEditDate(formatYmd(date));
                          else setEditTime(formatHm(date));
                        }}
                      />
                      <Pressable style={s.iosPickerDone} onPress={() => setIosPicker(null)}>
                        <Text style={s.iosPickerDoneText}>完成</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              </ScrollView>
              <View style={s.detailFooter}>
                <Pressable
                  style={s.detailCancelBtn}
                  onPress={() => {
                    setIosPicker(null);
                    setShowDetailModal(false);
                  }}>
                  <Text style={s.detailCancelBtnText}>取消</Text>
                </Pressable>
                <Pressable style={s.detailSaveBtn} onPress={handleSaveEdit}>
                  <Text style={s.detailSaveBtnText}>保存</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F6F7F9' },
  header: { backgroundColor: 'rgba(255,255,255,0.95)', borderBottomWidth: 0.5, borderBottomColor: 'rgba(31,31,31,0.06)', paddingHorizontal: 24, paddingTop: 12, paddingBottom: 16 },
  headerTitle: { fontSize: 28, fontWeight: '500', color: '#1F1F1F', marginBottom: 16 },
  segmentRow: { flexDirection: 'row', backgroundColor: 'rgba(240,241,243,0.8)', borderRadius: 18, padding: 4, gap: 4 },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 14, alignItems: 'center' },
  segBtnActive: { backgroundColor: '#fff', shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  segBtnText: { fontSize: 14, color: '#8E8E93', fontWeight: '500' },
  segBtnTextActive: { color: '#1F1F1F' },
  listContent: { paddingHorizontal: 24, paddingTop: 16 },
  reminderSwipeOuter: { borderRadius: 20, overflow: 'hidden', marginBottom: 12 },
  reminderSwipeContainer: { overflow: 'hidden', borderRadius: 20 },
  swipeDeleteTrack: {
    width: REMINDER_SWIPE_DELETE_WIDTH,
    alignSelf: 'stretch',
    position: 'relative',
  },
  swipeDeletePressable: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
  },
  swipeDeleteLabel: { color: '#fff', fontSize: 12, fontWeight: '500' },
  section: { marginBottom: 24 },
  sectionLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  sectionLabel: { fontSize: 15, fontWeight: '500' },
  sectionCount: { fontSize: 13 },
  card: { backgroundColor: '#fff', borderRadius: 20, padding: 18, borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.06)', overflow: 'hidden' },
  cardOverdue: { backgroundColor: '#FFF5F5', borderColor: 'rgba(239,68,68,0.2)', shadowColor: '#EF4444', shadowOpacity: 0.08, shadowRadius: 8, elevation: 3 },
  cardToday: { backgroundColor: '#fff', borderColor: 'rgba(245,158,11,0.3)', shadowColor: '#F59E0B', shadowOpacity: 0.06, shadowRadius: 6, elevation: 2 },
  cardUpcoming: { backgroundColor: '#fff', borderColor: 'rgba(59,130,246,0.2)', shadowColor: '#000', shadowOpacity: 0.02, shadowRadius: 4, elevation: 1 },
  cardFuture: { backgroundColor: '#fff', borderColor: 'rgba(31,31,31,0.06)' },
  leftBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  cardTitle: { fontSize: 17, fontWeight: '500', letterSpacing: -0.3 },
  desc: { fontSize: 14, color: '#8E8E93', marginBottom: 12, lineHeight: 20 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 },
  tag: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  tagText: { fontSize: 12, fontWeight: '500' },
  badgeOverdue: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FEE2E2', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 0.5, borderColor: 'rgba(239,68,68,0.3)' },
  badgeToday: { backgroundColor: '#FEF3C7', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 0.5, borderColor: 'rgba(245,158,11,0.3)' },
  badgeFuture: { backgroundColor: '#F0F1F3', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  badgeText: { fontSize: 12, fontWeight: '500' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  timeText: { fontSize: 13, color: '#8E8E93' },
  recurringBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.primary + '12', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  recurringText: { fontSize: 11, color: colors.primary, fontWeight: '500' },
  actions: { flexDirection: 'row', gap: 8 },
  btnComplete: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 14, paddingVertical: 11, shadowOpacity: 0.2, shadowRadius: 8, elevation: 3 },
  btnCompleteText: { color: '#fff', fontSize: 14, fontWeight: '500' },
  btnPostpone: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#fff', borderRadius: 14, paddingVertical: 11, borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.12)' },
  btnPostponeText: { color: '#1F1F1F', fontSize: 14, fontWeight: '500' },
  postponeSheet: { backgroundColor: '#fff', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 40 },
  postponeHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(31,31,31,0.12)', alignSelf: 'center', marginBottom: 16 },
  postponeTitle: { fontSize: 16, fontWeight: '600', color: '#1F1F1F', marginBottom: 16 },
  postponeBtn: { paddingVertical: 14, paddingHorizontal: 4 },
  postponeBtnText: { fontSize: 15, color: '#1F1F1F' },
  detailKeyboardRoot: { flex: 1 },
  detailOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  detailSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: '88%',
    width: '100%',
    flexDirection: 'column',
  },
  detailHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(31,31,31,0.12)', alignSelf: 'center', marginTop: 12, marginBottom: 8 },
  detailHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingVertical: 16, borderBottomWidth: 0.5, borderBottomColor: 'rgba(31,31,31,0.06)' },
  detailTitle: { fontSize: 20, fontWeight: '500', color: '#1F1F1F' },
  detailCloseBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  detailForm: { width: '100%' },
  detailFormContent: { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 24, flexGrow: 1 },
  detailField: { marginBottom: 20 },
  detailLabel: { fontSize: 13, color: '#8E8E93', marginBottom: 8 },
  detailInput: { backgroundColor: 'rgba(240,241,243,0.6)', borderWidth: 0.5, borderColor: 'rgba(31,31,31,0.06)', borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12, fontSize: 16 },
  detailTextArea: { height: 80, textAlignVertical: 'top' },
  detailTimeRow: { flexDirection: 'row', gap: 8 },
  detailPickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(240,241,243,0.6)',
    borderWidth: 0.5,
    borderColor: 'rgba(31,31,31,0.06)',
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  detailPickBtnText: { fontSize: 16, color: '#1F1F1F', fontWeight: '500' },
  iosPickerWrap: { marginTop: 8, alignItems: 'stretch' },
  iosPickerDone: {
    alignSelf: 'center',
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
  },
  iosPickerDoneText: { fontSize: 15, fontWeight: '600', color: '#fff' },
  detailFooter: { flexDirection: 'row', gap: 12, paddingHorizontal: 24, paddingVertical: 20, paddingBottom: 36, borderTopWidth: 0.5, borderTopColor: 'rgba(31,31,31,0.06)' },
  detailCancelBtn: { flex: 1, paddingVertical: 14, borderRadius: 16, backgroundColor: 'rgba(240,241,243,0.8)', alignItems: 'center', justifyContent: 'center' },
  detailCancelBtnText: { fontSize: 16, fontWeight: '500', color: '#1F1F1F' },
  detailSaveBtn: { flex: 1, paddingVertical: 14, borderRadius: 16, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  detailSaveBtnText: { fontSize: 16, fontWeight: '500', color: '#fff' },
  empty: { alignItems: 'center', paddingTop: 60, gap: 10 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: 17, fontWeight: '500', color: '#1F1F1F' },
  emptyDesc: { fontSize: 14, color: '#8E8E93', textAlign: 'center', lineHeight: 20 },
});