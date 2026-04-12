import { FamilyAccessProvider } from '@/contexts/FamilyAccessContext';
import { scheduleAllReminders } from '@/lib/notifications';
import { AppUpdateChecker } from '@/components/AppUpdateChecker';
import { Slot } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus, LogBox, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// Supabase Auth 在网络不稳定时后台刷新 token 超时，是正常的瞬态网络错误，
// 生产包不会红屏，开发模式下屏蔽避免干扰调试。
LogBox.ignoreLogs([
  'AuthRetryableFetchError',
  'Network request timed out',
]);

export default function RootLayout() {
  const schedulePromiseRef = useRef<Promise<void> | null>(null);
  const lastScheduleAtRef = useRef<number>(0);

  const scheduleAllRemindersDebounced = () => {
    const now = Date.now();
    // 防止短时间重复触发：会导致 cancelAll + 多次 schedule，卡 JS 线程
    if (schedulePromiseRef.current) return schedulePromiseRef.current;
    if (now - lastScheduleAtRef.current < 15000) return Promise.resolve();

    lastScheduleAtRef.current = now;
    schedulePromiseRef.current = scheduleAllReminders().finally(() => {
      schedulePromiseRef.current = null;
    });
    return schedulePromiseRef.current;
  };

  useEffect(() => {
    // App 启动时注册通知
    console.log('准备注册通知...');
    scheduleAllRemindersDebounced().then(() => console.log('通知注册完成'));

    // App 从后台切回前台时重新注册
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        scheduleAllRemindersDebounced();
      }
    });

    return () => subscription.remove();
  }, []);

  return (
    <View style={{ flex: 1 }}>
      <SafeAreaProvider>
        <FamilyAccessProvider>
          <Slot />
          <AppUpdateChecker />
        </FamilyAccessProvider>
      </SafeAreaProvider>
    </View>
  );
}