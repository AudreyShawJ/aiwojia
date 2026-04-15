import { colors } from '@/constants/designTokens';
import { isMissingAccessTierColumnError } from '@/lib/accessTierDb';
import { profilePhoneFromAuthUser } from '@/lib/phoneAuth';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Step = 'name' | 'family';

export default function SetupScreen() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [mode, setMode] = useState<'create' | 'join'>('join');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const generateInviteCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  };

  const generateSecretKey = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let key = '';
    for (let i = 0; i < 12; i++) {
      key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
  };

  const saveName = () => {
    if (!name.trim()) {
      setError('请输入你的名字');
      return;
    }
    setError('');
    setStep('family');
  };

  const createFamily = async () => {
    if (!familyName.trim()) {
      setError('请输入家庭名称');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('未登录');

      const profilePhone = profilePhoneFromAuthUser(user);

      const inviteCode = generateInviteCode();
      const secretKey = generateSecretKey();

      // 创建家庭
      const { data: family, error: familyError } = await supabase
        .from('families')
        .insert({
          name: familyName.trim(),
          created_by: user.id,
          invite_code: inviteCode,
          secret_key: secretKey,
        })
        .select('id')
        .single();

      if (familyError) throw familyError;

      // 创建或更新用户
      const adminUpsertWithTier = {
        id: user.id,
        phone: profilePhone,
        name: name.trim(),
        family_id: family.id,
        role: 'admin',
        access_tier: 'family' as const,
        perm_ai_full: true,
        perm_ai_limited: false,
        perm_upload: true,
        perm_reminder: true,
        perm_view_files: true,
      };
      const adminUpsertNoTier = {
        id: adminUpsertWithTier.id,
        phone: adminUpsertWithTier.phone,
        name: adminUpsertWithTier.name,
        family_id: adminUpsertWithTier.family_id,
        role: adminUpsertWithTier.role,
        perm_ai_full: adminUpsertWithTier.perm_ai_full,
        perm_ai_limited: adminUpsertWithTier.perm_ai_limited,
        perm_upload: adminUpsertWithTier.perm_upload,
        perm_reminder: adminUpsertWithTier.perm_reminder,
        perm_view_files: adminUpsertWithTier.perm_view_files,
      };
      let { error: userError } = await supabase.from('users').upsert(adminUpsertWithTier);
      if (userError && isMissingAccessTierColumnError(userError)) {
        ({ error: userError } = await supabase.from('users').upsert(adminUpsertNoTier));
      }

      if (userError) throw userError;

      router.replace('/(tabs)');
    } catch (e: any) {
      setError(e?.message || '创建失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  const joinFamily = async () => {
    if (!inviteCode.trim()) {
      setError('请输入邀请码');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('未登录');

      const profilePhone = profilePhoneFromAuthUser(user);

      // 查找家庭（通过 RPC，RLS 启用后直接查 families 会因权限被拒）
      const { data: familyRows, error: familyError } = await supabase
        .rpc('get_family_by_invite_code', { p_code: inviteCode.trim() });

      const family = Array.isArray(familyRows) && familyRows.length > 0 ? familyRows[0] : null;

      if (familyError || !family) {
        setError('邀请码无效，请确认后重试');
        return;
      }

      // 加入家庭：默认无任何权限，待管理员在「家庭成员 → 权限」中配置
      const memberUpsertWithTier = {
        id: user.id,
        phone: profilePhone,
        name: name.trim(),
        family_id: family.id,
        role: 'member',
        access_tier: null as null,
        perm_ai_full: false,
        perm_ai_limited: false,
        perm_upload: false,
        perm_reminder: false,
        perm_view_files: false,
      };
      const memberUpsertNoTier = {
        id: memberUpsertWithTier.id,
        phone: memberUpsertWithTier.phone,
        name: memberUpsertWithTier.name,
        family_id: memberUpsertWithTier.family_id,
        role: memberUpsertWithTier.role,
        perm_ai_full: memberUpsertWithTier.perm_ai_full,
        perm_ai_limited: memberUpsertWithTier.perm_ai_limited,
        perm_upload: memberUpsertWithTier.perm_upload,
        perm_reminder: memberUpsertWithTier.perm_reminder,
        perm_view_files: memberUpsertWithTier.perm_view_files,
      };
      let { error: userError } = await supabase.from('users').upsert(memberUpsertWithTier);
      if (userError && isMissingAccessTierColumnError(userError)) {
        ({ error: userError } = await supabase.from('users').upsert(memberUpsertNoTier));
      }

      if (userError) throw userError;

      router.replace('/welcome-pending');
    } catch (e: any) {
      setError(e?.message || '加入失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}
          keyboardShouldPersistTaps="handled">
          <View style={styles.top}>
            <Text style={styles.title}>
              {step === 'name' ? '你叫什么名字？' : '你的家庭'}
            </Text>
            <Text style={styles.subtitle}>
              {step === 'name'
                ? '家人会用这个名字认识你'
                : '创建一个新家庭，或者加入已有的家庭'}
            </Text>
          </View>

          <View style={styles.card}>
            {step === 'name' ? (
              <>
                <TextInput
                  style={styles.input}
                  value={name}
                  onChangeText={setName}
                  placeholder="输入你的名字，比如：妈妈"
                  placeholderTextColor={colors.mutedForeground}
                  autoFocus
                />
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <Pressable
                  onPress={saveName}
                  style={({ pressed }) => [styles.btn, pressed && { opacity: 0.85 }]}>
                  <Text style={styles.btnText}>下一步</Text>
                </Pressable>
                <Pressable
                  onPress={async () => {
                    await supabase.auth.signOut();
                    router.replace('/login');
                  }}
                  style={styles.backBtn}>
                  <Text style={styles.backText}>返回</Text>
                </Pressable>
              </>
            ) : (
              <>
                {/* 模式切换 */}
                <View style={styles.modeRow}>
                  <Pressable
                    onPress={() => { setMode('join'); setError(''); }}
                    style={[styles.modeBtn, mode === 'join' && styles.modeBtnActive]}>
                    <Text style={[styles.modeBtnText, mode === 'join' && styles.modeBtnTextActive]}>
                      加入家庭
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => { setMode('create'); setError(''); }}
                    style={[styles.modeBtn, mode === 'create' && styles.modeBtnActive]}>
                    <Text style={[styles.modeBtnText, mode === 'create' && styles.modeBtnTextActive]}>
                      创建家庭
                    </Text>
                  </Pressable>
                </View>

                {mode === 'create' ? (
                  <>
                    <TextInput
                      style={styles.input}
                      value={familyName}
                      onChangeText={setFamilyName}
                      placeholder="家庭名称，比如：王家"
                      placeholderTextColor={colors.mutedForeground}
                      autoFocus
                    />
                    {error ? <Text style={styles.error}>{error}</Text> : null}
                    <Pressable
                      onPress={createFamily}
                      disabled={loading}
                      style={({ pressed }) => [
                        styles.btn,
                        pressed && { opacity: 0.85 },
                        loading && { opacity: 0.6 },
                      ]}>
                      {loading
                        ? <ActivityIndicator color="#fff" />
                        : <Text style={styles.btnText}>创建家庭</Text>}
                    </Pressable>
                  </>
                ) : (
                  <>
                    <TextInput
                      style={[styles.input, { letterSpacing: 4, fontSize: 20 }]}
                      value={inviteCode}
                      onChangeText={setInviteCode}
                      placeholder="输入6位邀请码"
                      placeholderTextColor={colors.mutedForeground}
                      autoCapitalize="characters"
                      maxLength={6}
                      autoFocus
                    />
                    {error ? <Text style={styles.error}>{error}</Text> : null}
                    <Pressable
                      onPress={joinFamily}
                      disabled={loading}
                      style={({ pressed }) => [
                        styles.btn,
                        pressed && { opacity: 0.85 },
                        loading && { opacity: 0.6 },
                      ]}>
                      {loading
                        ? <ActivityIndicator color="#fff" />
                        : <Text style={styles.btnText}>加入家庭</Text>}
                    </Pressable>
                  </>
                )}

                <Pressable
                  onPress={() => { setStep('name'); setError(''); }}
                  style={styles.backBtn}>
                  <Text style={styles.backText}>上一步</Text>
                </Pressable>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  top: { marginBottom: 32 },
  title: { fontSize: 28, fontWeight: '700', color: colors.foreground, marginBottom: 8 },
  subtitle: { fontSize: 15, color: colors.mutedForeground, lineHeight: 22 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: 24,
    shadowColor: 'rgba(31,31,31,0.08)',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 16,
    elevation: 3,
  },
  input: {
    height: 48,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 12,
    fontSize: 16,
    color: colors.foreground,
    backgroundColor: colors.card,
    marginBottom: 16,
  },
  error: { fontSize: 13, color: colors.destructive, marginBottom: 12 },
  btn: {
    height: 50,
    backgroundColor: colors.primary,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnText: { color: colors.primaryForeground, fontSize: 16, fontWeight: '600' },
  modeRow: {
    flexDirection: 'row',
    backgroundColor: colors.muted,
    borderRadius: 12,
    padding: 4,
    marginBottom: 20,
    gap: 4,
  },
  modeBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    alignItems: 'center',
  },
  modeBtnActive: { backgroundColor: colors.card },
  modeBtnText: { fontSize: 14, color: colors.mutedForeground, fontWeight: '500' },
  modeBtnTextActive: { color: colors.foreground, fontWeight: '600' },
  backBtn: { marginTop: 16, alignItems: 'center' },
  backText: { fontSize: 14, color: colors.mutedForeground },
});