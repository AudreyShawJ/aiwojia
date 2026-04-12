import { Logo13Icon } from '@/components/Logo13Icon';
import { colors } from '@/constants/designTokens';
import { useFamilyAccess } from '@/contexts/FamilyAccessContext';
import { isWelcomePending, loadFamilyAccess } from '@/lib/familyAccess';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Heart } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const PRIMARY = colors.primary;
const ACCENT = colors.accent;

export default function WelcomePendingScreen() {
  const router = useRouter();
  const { refresh } = useFamilyAccess();
  const [familyName, setFamilyName] = useState('你的家庭');
  const [adminName, setAdminName] = useState('管理员');
  const [refreshing, setRefreshing] = useState(false);

  const heroScale = useRef(new Animated.Value(0.88)).current;
  const heroOpacity = useRef(new Animated.Value(0)).current;
  const textY = useRef(new Animated.Value(16)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const cardY = useRef(new Animated.Value(24)).current;
  const cardOpacity = useRef(new Animated.Value(0)).current;
  const footerOpacity = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;
  const heartPulse = useRef(new Animated.Value(1)).current;

  const runEnter = useCallback(() => {
    Animated.parallel([
      Animated.timing(heroOpacity, { toValue: 1, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(heroScale, { toValue: 1, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.sequence([
        Animated.delay(160),
        Animated.parallel([
          Animated.timing(textOpacity, { toValue: 1, duration: 480, useNativeDriver: true }),
          Animated.timing(textY, { toValue: 0, duration: 480, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        ]),
      ]),
      Animated.sequence([
        Animated.delay(260),
        Animated.parallel([
          Animated.timing(cardOpacity, { toValue: 1, duration: 480, useNativeDriver: true }),
          Animated.timing(cardY, { toValue: 0, duration: 480, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        ]),
      ]),
      Animated.sequence([
        Animated.delay(400),
        Animated.timing(footerOpacity, { toValue: 1, duration: 360, useNativeDriver: true }),
      ]),
    ]).start();
  }, [heroOpacity, heroScale, textOpacity, textY, cardOpacity, cardY, footerOpacity]);

  useEffect(() => {
    runEnter();
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.12, duration: 1750, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 1750, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    loop.start();
    const hLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(heartPulse, { toValue: 1.08, duration: 1000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(heartPulse, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    hLoop.start();
    return () => {
      loop.stop();
      hLoop.stop();
    };
  }, [runEnter, pulse, heartPulse]);

  const hydrate = useCallback(async () => {
    const data = await loadFamilyAccess();
    if (!data?.familyId) {
      router.replace('/login');
      return false;
    }
    if (!isWelcomePending(data)) {
      router.replace('/(tabs)');
      return false;
    }
    setFamilyName(data.familyName?.trim() || '你的家庭');
    setAdminName(data.adminDisplayName?.trim() || '管理员');
    return true;
  }, [router]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
      await hydrate();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <View style={styles.root}>
      {/* 整屏浅色底，避免「光圈拦腰斩」仅盖住上半屏的割裂感 */}
      <LinearGradient
        colors={['#FFFFFF', '#FAFBFD', '#F5F7FB', '#FFFFFF']}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={[`${PRIMARY}0D`, `${PRIMARY}05`, 'transparent']}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.55 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PRIMARY} />
          }
          showsVerticalScrollIndicator={false}>
          <View style={styles.centerBlock}>
            <Animated.View
              style={{
                opacity: heroOpacity,
                transform: [{ scale: heroScale }],
                marginBottom: 40,
                alignItems: 'center',
              }}>
              <View style={styles.iconWrap}>
                <Animated.View
                  style={[
                    styles.glowBlob,
                    {
                      transform: [{ scale: pulse }],
                      opacity: pulse.interpolate({
                        inputRange: [1, 1.12],
                        outputRange: [0.22, 0.38],
                      }),
                    },
                  ]}
                />
                <LinearGradient
                  colors={[PRIMARY, ACCENT]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.iconCard}>
                  <Logo13Icon size={75} variant="white" gradientIdSuffix="welcome-pending" />
                </LinearGradient>
              </View>
            </Animated.View>

            <Animated.View style={{ opacity: textOpacity, transform: [{ translateY: textY }], marginBottom: 36 }}>
              <Text style={styles.h1}>欢迎回家</Text>
              <Text style={styles.sub}>你已成功加入「{familyName}」</Text>
            </Animated.View>

            <Animated.View
              style={{
                opacity: cardOpacity,
                transform: [{ translateY: cardY }],
                width: '100%',
                maxWidth: 400,
              }}>
              <View style={styles.card}>
                <Animated.View style={{ transform: [{ scale: heartPulse }] }}>
                  <Heart size={44} color="#FF6B6B" fill="#FF6B6B" strokeWidth={1.8} />
                </Animated.View>
                <Text style={styles.cardH2}>就差一步了</Text>
                <Text style={styles.cardP}>
                  请「<Text style={styles.cardEm}>{adminName}</Text>」为你设置权限
                </Text>
                <Text style={styles.cardHint}>很快就能开启家庭之旅啦</Text>
              </View>
            </Animated.View>
          </View>

          <Animated.Text style={[styles.footer, { opacity: footerOpacity }]}>
            把家的点滴·慢慢变成可用的记忆
          </Animated.Text>

        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FFFFFF' },
  safe: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingBottom: 28,
  },
  centerBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 520,
    paddingTop: 16,
  },
  iconWrap: {
    width: 160,
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glowBlob: {
    position: 'absolute',
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: PRIMARY,
  },
  iconCard: {
    width: 100,
    height: 100,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: PRIMARY,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 12,
  },
  h1: {
    fontSize: 34,
    fontWeight: '600',
    color: colors.foreground,
    textAlign: 'center',
    letterSpacing: -0.5,
    marginBottom: 14,
  },
  sub: {
    fontSize: 17,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 24,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(31,31,31,0.06)',
    paddingHorizontal: 28,
    paddingVertical: 36,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.06,
    shadowRadius: 20,
    elevation: 4,
    gap: 12,
  },
  cardH2: { fontSize: 22, fontWeight: '600', color: colors.foreground, marginTop: 4 },
  cardP: {
    fontSize: 17,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 26,
  },
  cardEm: { color: colors.foreground, fontWeight: '600' },
  cardHint: { fontSize: 15, color: 'rgba(142,142,147,0.75)', marginTop: 4, textAlign: 'center' },
  footer: {
    textAlign: 'center',
    fontSize: 13,
    color: 'rgba(142,142,147,0.55)',
    marginTop: 8,
  },
});
