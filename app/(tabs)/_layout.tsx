import { colors } from '@/constants/designTokens';
import { useFamilyAccess } from '@/contexts/FamilyAccessContext';
import { isWelcomePending, showRecordsTab } from '@/lib/familyAccess';
import { Redirect, Tabs, useFocusEffect } from 'expo-router';
import { BookOpen, MessageCircle, User } from 'lucide-react-native';
import React, { useCallback } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** 底部 Tab 固定内容区高度；总高度需加上系统导航条/手势条 inset（Android edge-to-edge 尤其重要） */
const TAB_BAR_CONTENT_HEIGHT = 54;
const TAB_BAR_PADDING_TOP = 10;
const TAB_BAR_PADDING_BOTTOM_EXTRA = 12;

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const { access, refresh } = useFamilyAccess();

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );

  const tabBarPaddingBottom = TAB_BAR_PADDING_BOTTOM_EXTRA + insets.bottom;
  const tabBarHeight =
    TAB_BAR_PADDING_TOP + TAB_BAR_CONTENT_HEIGHT + tabBarPaddingBottom;

  const recordsVisible = access === undefined ? true : showRecordsTab(access);

  if (access === undefined) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (isWelcomePending(access)) {
    return <Redirect href="/welcome-pending" />;
  }

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          backgroundColor: 'rgba(255,255,255,0.95)',
          borderTopColor: colors.border,
          height: tabBarHeight,
          paddingBottom: tabBarPaddingBottom,
          paddingTop: TAB_BAR_PADDING_TOP,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '500',
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: '聊天',
          tabBarIcon: ({ color, focused }) => (
            <MessageCircle size={22} color={color} strokeWidth={focused ? 2 : 1.5} />
          ),
        }}
      />
      <Tabs.Screen
        name="records"
        options={{
          title: '记录',
          href: recordsVisible ? undefined : null,
          tabBarIcon: ({ color, focused }) => (
            <BookOpen size={22} color={color} strokeWidth={focused ? 2 : 1.5} />
          ),
        }}
      />
      <Tabs.Screen
        name="me"
        options={{
          title: '我的',
          tabBarIcon: ({ color, focused }) => (
            <User size={22} color={color} strokeWidth={focused ? 2 : 1.5} />
          ),
        }}
      />
      <Tabs.Screen name="reminders" options={{ href: null }} />
      <Tabs.Screen name="documents" options={{ href: null }} />
    </Tabs>
  );
}