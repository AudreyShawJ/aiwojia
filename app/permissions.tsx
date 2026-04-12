import { colors } from '@/constants/designTokens';
import { useFamilyAccess } from '@/contexts/FamilyAccessContext';
import { isMissingAccessTierColumnError } from '@/lib/accessTierDb';
import { deriveAccessTierFromLegacyPerms, type AccessTier } from '@/lib/familyAccess';
import { supabase } from '@/lib/supabase';
import { useNavigation } from '@react-navigation/native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const FAMILY_CONFIRM_TITLE = '确认授予家庭权限';
const FAMILY_CONFIRM_MESSAGE =
  '授予「家庭权限」后，该账号将与其他家庭管理员共同维护同一套家庭信息（记录、资料、提醒等），可查看并参与管理本家庭在 App 内的内容。\n\n' +
  '若设备共用、账号外借或密码过于简单，可能导致家庭隐私被他人查看或改动。请确认对方可信、已了解上述风险，再授予权限。';

export default function PermissionsScreen() {
  const { refresh: refreshFamilyAccess } = useFamilyAccess();
  const router = useRouter();
  const navigation = useNavigation();
  const { memberId, memberName } = useLocalSearchParams<{
    memberId: string;
    memberName: string;
  }>();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedTier, setSelectedTier] = useState<AccessTier | null>(null);
  const [isCreatorTarget, setIsCreatorTarget] = useState(false);
  const [dbSupportsAccessTier, setDbSupportsAccessTier] = useState(true);

  const initial = useMemo(
    () => (memberName ? String(memberName)[0].toUpperCase() : '?'),
    [memberName]
  );

  const load = useCallback(async () => {
    if (!memberId) return;
    setLoading(true);
    try {
      const SEL_WITH =
        'family_id, access_tier, perm_ai_full, perm_ai_limited, perm_upload, perm_reminder, perm_view_files';
      const SEL_NO = 'family_id, perm_ai_full, perm_ai_limited, perm_upload, perm_reminder, perm_view_files';
      let rowRes = await supabase.from('users').select(SEL_WITH).eq('id', memberId).single();
      if (rowRes.error && isMissingAccessTierColumnError(rowRes.error)) {
        setDbSupportsAccessTier(false);
        rowRes = await supabase.from('users').select(SEL_NO).eq('id', memberId).single();
      } else {
        setDbSupportsAccessTier(true);
      }
      if (rowRes.error) throw rowRes.error;
      const row = rowRes.data;
      const fid = row?.family_id as string | null;
      let createdBy: string | null = null;
      if (fid) {
        const { data: fam } = await supabase
          .from('families')
          .select('created_by')
          .eq('id', fid)
          .maybeSingle();
        createdBy = (fam?.created_by as string | null) ?? null;
      }
      const creatorTarget = Boolean(createdBy && memberId === createdBy);
      setIsCreatorTarget(creatorTarget);
      if (creatorTarget) {
        setSelectedTier('family');
      } else {
        setSelectedTier(deriveAccessTierFromLegacyPerms(row || {}));
      }
    } catch (e: unknown) {
      console.error('读取权限失败:', e instanceof Error ? e.message : e);
    } finally {
      setLoading(false);
    }
  }, [memberId]);

  useEffect(() => {
    void load();
  }, [load]);

  const mustChooseBeforeLeave = !isCreatorTarget && selectedTier === null;

  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', e => {
      if (!mustChooseBeforeLeave) return;
      e.preventDefault();
      Alert.alert(
        '请先完成权限选择',
        '「家庭权限」与「辅助权限」必须且只能选择其一，请选好后保存或返回。',
        [{ text: '我知道了' }]
      );
    });
    return sub;
  }, [navigation, mustChooseBeforeLeave]);

  const goBack = () => {
    if (mustChooseBeforeLeave) {
      Alert.alert(
        '请先完成权限选择',
        '「家庭权限」与「辅助权限」必须且只能选择其一，请选好后保存或返回。',
        [{ text: '我知道了' }]
      );
      return;
    }
    router.back();
  };

  const persistTier = async (tier: AccessTier) => {
    if (!memberId || isCreatorTarget) return;
    setSaving(true);
    try {
      const payload =
        tier === 'family'
          ? {
              access_tier: 'family' as const,
              perm_ai_full: true,
              perm_ai_limited: false,
              perm_upload: true,
              perm_reminder: true,
              perm_view_files: true,
            }
          : {
              access_tier: 'auxiliary' as const,
              perm_ai_full: true,
              perm_ai_limited: false,
              /** 辅助账号仅在聊天中传图/文件/视频，不在「我的」中开放资料库等入口 */
              perm_upload: true,
              perm_reminder: true,
              perm_view_files: false,
            };
      const { access_tier: _ignoredAccessTier, ...permsOnly } = payload;
      let data: { id: string } | null = null;
      let error: { message?: string } | null = null;
      {
        const res = await supabase
          .from('users')
          .update(payload as never)
          .eq('id', memberId)
          .select('id')
          .maybeSingle();
        data = res.data;
        error = res.error;
      }
      if (error && isMissingAccessTierColumnError(error)) {
        setDbSupportsAccessTier(false);
        const res2 = await supabase
          .from('users')
          .update(permsOnly as never)
          .eq('id', memberId)
          .select('id')
          .maybeSingle();
        data = res2.data;
        error = res2.error;
      }
      if (error) throw error;
      if (!data) {
        throw new Error(
          '保存未生效：数据库未更新该行。若你是家庭创建者，请在 Supabase 执行迁移 `20250331_users_update_by_family_creator.sql`（为创建者开放修改同家庭成员 users 的 RLS）。'
        );
      }
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.id === memberId) await refreshFamilyAccess();
      Alert.alert('已保存', '权限设置已更新', [{ text: '好的', onPress: () => router.back() }]);
    } catch (e: unknown) {
      console.error('保存权限失败:', e instanceof Error ? e.message : e);
      Alert.alert('保存失败', e instanceof Error ? e.message : '请重试');
    } finally {
      setSaving(false);
    }
  };

  const onSavePress = () => {
    if (!memberId || isCreatorTarget) return;
    if (selectedTier === null) {
      Alert.alert('请选择权限', '「家庭权限」与「辅助权限」必须且只能选择其一。');
      return;
    }
    if (selectedTier === 'family') {
      Alert.alert(FAMILY_CONFIRM_TITLE, FAMILY_CONFIRM_MESSAGE, [
        { text: '暂不授予', style: 'cancel' },
        { text: '确认授予', style: 'default', onPress: () => void persistTier('family') },
      ]);
      return;
    }
    void persistTier('auxiliary');
  };

  const TierCard = ({
    tier,
    title,
    desc,
    icon,
  }: {
    tier: AccessTier;
    title: string;
    desc: string;
    icon: string;
  }) => {
    const on = selectedTier === tier;
    const disabled = isCreatorTarget;
    return (
      <Pressable
        style={[s.tierCard, on && s.tierCardOn, disabled && s.tierCardDisabled]}
        onPress={() => {
          if (disabled) return;
          setSelectedTier(tier);
        }}
        disabled={disabled}>
        <Text style={s.tierIcon}>{icon}</Text>
        <View style={s.tierTextWrap}>
          <Text style={s.tierTitle}>{title}</Text>
          <Text style={s.tierDesc}>{desc}</Text>
        </View>
        <View style={[s.radioOuter, on && s.radioOuterOn]}>
          {on ? <View style={s.radioInner} /> : null}
        </View>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <Pressable onPress={goBack} style={s.backBtn}>
          <Text style={s.backText}>‹ 返回</Text>
        </Pressable>
        <Text style={s.headerTitle}>设置权限</Text>
        <View style={s.backBtn} />
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <>
          <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
            <View style={s.memberCard}>
              <View style={s.memberAvatar}>
                <Text style={s.memberAvatarText}>{initial}</Text>
              </View>
              <View>
                <Text style={s.memberName}>{memberName || '成员'}</Text>
                <Text style={s.memberSub}>
                  {isCreatorTarget
                    ? '家庭创建者默认为家庭权限，无法由他人修改'
                    : '家庭权限与辅助权限必须且只能选择其一'}
                </Text>
              </View>
            </View>

            {!dbSupportsAccessTier ? (
              <Text style={s.dbWarn}>
               （开发者提示）数据库缺少 access_tier 列时，将仅写入传统权限字段；请在 Supabase 执行含 access_tier 的迁移后重试。
              </Text>
            ) : null}

            <Text style={s.sectionLabel}>功能权限（二选一）</Text>
            <TierCard
              tier="family"
              icon="🏠"
              title="家庭权限"
              desc="可与 AI 正常对话，维护家庭资料，接收并使用家庭提醒。"
            />
            <TierCard
              tier="auxiliary"
              icon="🛟"
              title="辅助权限"
              desc="适用于保姆等：仅通过聊天让 AI 帮忙记录或设置提醒，可发文字、图片、视频与文件；无法在 App 内查看其他家庭隐私。"
            />

            <Text style={s.hint}>
              选择「家庭权限」后，可使用 App 内与家庭相关的功能菜单。家庭创建者的权限不可由被邀请者更改。
            </Text>

            <View style={{ height: 24 }} />
          </ScrollView>

          {!isCreatorTarget ? (
            <View style={s.footer}>
              <Pressable
                style={[s.saveBtn, saving && { opacity: 0.6 }]}
                onPress={onSavePress}
                disabled={saving}>
                {saving ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Text style={s.saveBtnText}>保存权限</Text>
                )}
              </Pressable>
            </View>
          ) : null}
        </>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  backBtn: { width: 60 },
  backText: { fontSize: 17, color: colors.primary },
  headerTitle: { fontSize: 17, fontWeight: '500', color: colors.foreground },
  scroll: { padding: 24 },
  memberCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: 18,
    marginBottom: 24,
    borderWidth: 0.5,
    borderColor: colors.border,
  },
  memberAvatar: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberAvatarText: { fontSize: 20, fontWeight: '600', color: colors.primaryForeground },
  memberName: { fontSize: 18, fontWeight: '500', color: colors.foreground },
  memberSub: { fontSize: 13, color: colors.mutedForeground, marginTop: 2 },
  dbWarn: {
    fontSize: 12,
    color: '#B45309',
    backgroundColor: '#FFFBEB',
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
    lineHeight: 18,
    overflow: 'hidden',
  },
  sectionLabel: { fontSize: 13, color: colors.mutedForeground, marginBottom: 10 },
  tierCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  tierCardOn: { borderColor: colors.primary },
  tierCardDisabled: { opacity: 0.85 },
  tierIcon: { fontSize: 28, width: 40, textAlign: 'center' },
  tierTextWrap: { flex: 1 },
  tierTitle: { fontSize: 16, fontWeight: '600', color: colors.foreground },
  tierDesc: { fontSize: 12, color: colors.mutedForeground, marginTop: 4, lineHeight: 17 },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOuterOn: { borderColor: colors.primary },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.primary,
  },
  hint: {
    marginTop: 16,
    fontSize: 12,
    color: colors.mutedForeground,
    lineHeight: 18,
  },
  footer: {
    paddingHorizontal: 24,
    paddingBottom: 16,
    paddingTop: 10,
    borderTopWidth: 0.5,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  saveBtn: {
    backgroundColor: colors.primary,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    shadowColor: colors.primary,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  saveBtnText: { color: colors.primaryForeground, fontSize: 16, fontWeight: '500' },
});
