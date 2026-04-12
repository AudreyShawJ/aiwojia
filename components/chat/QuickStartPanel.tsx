import { QuickStartTile } from '@/components/chat/QuickStartTile';
import { useEffect, useRef, type RefObject } from 'react';
import { Animated, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';

const PRIMARY = '#5A6CFF';
const PAGE_BG = '#F6F7F9';
const CARD = '#FFFFFF';

export type QuickStartItem = {
  id: string;
  title: string;
  description: string;
  /** 点击后填入输入框的完整文案 */
  fillText: string;
};

export const DEFAULT_QUICK_START_ITEMS: QuickStartItem[] = [
  {
    id: 'child',
    title: '孩子成长',
    description: '记录进步与小惊喜，沉淀成长册',
    fillText:
      '孩子最近有个成长瞬间我想记下来',
  },
  {
    id: 'remind',
    title: '设置提醒',
    description: '还款、续费、复查…重要的小事',
    fillText:
      '帮我设一个提醒：每月 15 号前要还房贷，请提前一天提醒我。',
  },
  {
    id: 'bill',
    title: '记录账单',
    description: '最近花了什么钱，随时记账查账',
    fillText:
      '今天在超市买菜花了 120 元，算家庭日常支出，帮我记入账本。',
  },
  {
    id: 'health',
    title: '全家健康',
    description: '记录症状、医嘱、复查，不再凌乱和遗忘',
    fillText:
      '家里有人最近体检/看病有个结果我想记下来：医院与科室、医生建议、要不要复查或换药，以及大概什么时候复诊，我怕忘请帮我整理成一条可回看的话。',
  },
];

export type QuickStartPanelProps = {
  visible: boolean;
  items?: readonly QuickStartItem[];
  onPick: (text: string) => void;
  inputRef: RefObject<TextInput | null>;
};

export function QuickStartPanel({
  visible,
  items = DEFAULT_QUICK_START_ITEMS,
  onPick,
  inputRef,
}: QuickStartPanelProps) {
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const { width } = useWindowDimensions();
  const isWide = width >= 400;
  const columnPct: `${number}%` = isWide ? '48%' : '100%';

  useEffect(() => {
    if (visible) {
      opacity.setValue(1);
    }
  }, [visible, opacity]);

  if (!visible) return null;

  const runPick = (fillText: string) => {
    Animated.timing(opacity, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        onPick(fillText);
        opacity.setValue(1);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
        });
      }
    });
  };

  return (
    <Animated.View style={[styles.wrap, { opacity }]} pointerEvents="box-none">
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>你可以这样开始</Text>
        <View style={[styles.grid, isWide && styles.gridTwoCol]}>
          {items.map(item => (
            <QuickStartTile
              key={item.id}
              title={item.title}
              description={item.description}
              columnWidth={columnPct}
              onPress={() => runPick(item.fillText)}
            />
          ))}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    paddingTop: 4,
    backgroundColor: PAGE_BG,
  },
  card: {
    backgroundColor: CARD,
    borderRadius: 16,
    padding: 16,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: 'rgba(90, 108, 255, 0.08)',
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: PRIMARY,
    letterSpacing: 0.2,
  },
  grid: {
    gap: 12,
    flexDirection: 'column',
  },
  gridTwoCol: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 12,
    columnGap: 12,
  },
});
