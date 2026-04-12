import { Logo13Icon } from '@/components/Logo13Icon';
import { brand, colors } from '@/constants/designTokens';
import { isWelcomePending, loadFamilyAccess } from '@/lib/familyAccess';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
} from 'react-native';

export default function IndexScreen() {
  const router = useRouter();
  const [splashDone, setSplashDone] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // 启动页进入动画
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 800,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 600,
        delay: 200,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    ]).start();

    // 底部三点跳动
    const bounce = (anim: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.timing(anim, {
            toValue: -6,
            duration: 400,
            delay,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: 0,
            duration: 400,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
    };
    const a1 = bounce(dot1, 0);
    const a2 = bounce(dot2, 120);
    const a3 = bounce(dot3, 240);
    a1.start();
    a2.start();
    a3.start();
    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
    };
  }, [fadeAnim, slideAnim, dot1, dot2, dot3]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSplashDone(true);
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!splashDone) return;

    const check = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();

        if (!session) {
          router.replace('/login');
          return;
        }

        const access = await loadFamilyAccess();
        if (!access?.familyId) {
          router.replace('/setup');
          return;
        }
        if (isWelcomePending(access)) {
          router.replace('/welcome-pending');
          return;
        }
        router.replace('/(tabs)');
      } catch {
        router.replace('/login');
      }
    };

    check();
  }, [splashDone, router]);

  return (
    <View style={s.container}>
      {/* 背景装饰 - 渐变光晕 */}
      <View style={s.glow} />

      {/* 主内容 */}
      <Animated.View
        style={[
          s.content,
          {
            opacity: fadeAnim,
            transform: [{ translateY: slideAnim }],
          },
        ]}>
        {/* Logo 区域（Figma Logo13 彩色） */}
        <View style={s.logoWrap}>
          <View style={s.logoMark}>
            <Logo13Icon size={104} gradientIdSuffix="splash" />
          </View>
        </View>

        {/* 应用名称 */}
        <View style={s.titleWrap}>
          <Text style={s.title}>{brand.productName}</Text>
          <Text style={s.subtitle}>{brand.splashTagline}</Text>
        </View>

        {/* 加载指示器 - 三个点 */}
        <View style={s.dots}>
          <Animated.View style={[s.dot, { transform: [{ translateY: dot1 }] }]} />
          <Animated.View style={[s.dot, { transform: [{ translateY: dot2 }] }]} />
          <Animated.View style={[s.dot, { transform: [{ translateY: dot3 }] }]} />
        </View>
      </Animated.View>

      
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    top: '20%',
    width: 400,
    height: 400,
    borderRadius: 200,
    backgroundColor: 'rgba(124, 139, 255, 0.18)',
  },
  content: {
    alignItems: 'center',
    gap: 32,
    zIndex: 10,
  },
  logoWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoMark: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleWrap: {
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 32,
    fontWeight: '500',
    color: colors.foreground,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 14,
    color: colors.mutedForeground,
    letterSpacing: 0.5,
  },
  dots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  footer: {
    position: 'absolute',
    bottom: 48,
  },
  footerText: {
    fontSize: 11,
    color: colors.mutedForeground,
    letterSpacing: 1,
  },
});
