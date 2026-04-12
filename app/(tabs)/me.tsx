import { LegalDocumentModal, type LegalDocKind } from '@/components/LegalDocumentModal';
import { PENDING_UPDATE_KEY } from '@/components/AppUpdateChecker';
import { colors } from '@/constants/designTokens';
import { useFamilyAccess } from '@/contexts/FamilyAccessContext';
import { showFamilyFilesMenu } from '@/lib/familyAccess';
import { downloadAndInstallApk, type AppVersionRow } from '@/lib/appUpdate';
import { supabase } from '@/lib/supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as LocalAuthentication from 'expo-local-authentication';
import { useFocusEffect, useRouter } from 'expo-router';
import { Camera, ChevronRight, Copy, FileText, Folder, LogOut, RefreshCw, Users } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

function hintForLocalAuthError(
  err2: LocalAuthentication.LocalAuthenticationError | string | undefined,
): string {
  return err2 === 'not_enrolled'
    ? Platform.OS === 'android'
      ? '请先在系统设置中设置锁屏密码'
      : '请先在系统设置中设置面容、指纹或锁屏密码'
    : err2 === 'passcode_not_set'
      ? '请先在系统中设置锁屏密码'
      : err2 === 'not_available'
        ? '当前设备无法进行本地验证'
        : err2 === 'lockout'
          ? '尝试次数过多，请稍后在系统设置中解锁后再试'
          : '验证未通过，请重试';
}

/** 生物识别（面容/指纹），失败不 fallback 到密码 */
async function authenticateWithBiometric(): Promise<
  | { ok: true }
  | { ok: false; cancelled: boolean; hint?: string }
> {
  const promptMessage = '验证身份以查看家庭资料';
  const cancelLabel = '取消';

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel,
    disableDeviceFallback: true,
  });

  if (result.success) return { ok: true };

  const err = result.error as LocalAuthentication.LocalAuthenticationError | 'missing_usage_description' | undefined;
  if (err === 'user_cancel' || err === 'system_cancel' || err === 'app_cancel') {
    return { ok: false, cancelled: true };
  }
  if (err === 'missing_usage_description') {
    // Expo Go / 未预构建包缺少 NSFaceIDUsageDescription，降级为允许密码的单次调用
    const patched = await LocalAuthentication.authenticateAsync({ promptMessage, cancelLabel, disableDeviceFallback: false });
    if (patched.success) return { ok: true };
    const e2 = patched.error;
    if (e2 === 'user_cancel' || e2 === 'system_cancel' || e2 === 'app_cancel') return { ok: false, cancelled: true };
    return { ok: false, cancelled: false, hint: hintForLocalAuthError(e2) };
  }
  return { ok: false, cancelled: false, hint: hintForLocalAuthError(err) };
}

/** 直接走设备密码，跳过生物识别 */
async function authenticateWithPasscode(): Promise<
  | { ok: true }
  | { ok: false; cancelled: boolean; hint?: string }
> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: '请输入设备密码以查看家庭资料',
    cancelLabel: '取消',
    disableDeviceFallback: false,
  });

  if (result.success) return { ok: true };

  const err = result.error;
  if (err === 'user_cancel' || err === 'system_cancel' || err === 'app_cancel') {
    return { ok: false, cancelled: true };
  }
  return { ok: false, cancelled: false, hint: hintForLocalAuthError(err) };
}

export default function MeScreen() {
  const router = useRouter();
  const { access } = useFamilyAccess();
  /** 仅「辅助权限」隐藏家庭相关菜单；家庭权限可使用全部入口 */
  const hideFamilyBlock = access?.accessTier === 'auxiliary';
  const showFamilyFilesEntry = showFamilyFilesMenu(access ?? null);
  const [userName, setUserName] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const [familyName, setFamilyName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [role, setRole] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [showFilesModal, setShowFilesModal] = useState(false);
  const [authHint, setAuthHint] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricLabel, setBiometricLabel] = useState('面容 / 指纹验证');
  const [legalDoc, setLegalDoc] = useState<LegalDocKind | null>(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [editName, setEditName] = useState('');
  const [editAvatarUri, setEditAvatarUri] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<AppVersionRow | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateProgress, setUpdateProgress] = useState(0);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        setUserId(user.id);

        const { data: userData } = await supabase
          .from('users')
          .select('name, role, family_id, avatar_url')
          .eq('id', user.id)
          .single();

        setUserName(userData?.name || user.email?.split('@')[0] || '用户');
        setRole(userData?.role === 'admin' ? '管理员' : '成员');
        setAvatarUrl(userData?.avatar_url || null);

        if (userData?.family_id) {
          const { data: familyData } = await supabase
            .from('families')
            .select('name, invite_code')
            .eq('id', userData.family_id)
            .single();
          setFamilyName(familyData?.name || '我的家庭');
          setInviteCode(familyData?.invite_code || '');
        }

        // 检查是否有待更新版本（稍后再说后存在 AsyncStorage）
        if (Platform.OS === 'android') {
          const stored = await AsyncStorage.getItem(PENDING_UPDATE_KEY);
          setPendingUpdate(stored ? JSON.parse(stored) as AppVersionRow : null);
        }
      })();
    }, [])
  );

  const handleCopy = async () => {
    await Clipboard.setStringAsync(inviteCode);
    Alert.alert('已复制', '邀请码已复制到剪贴板');
  };

  const handleLogout = () => {
    Alert.alert('退出登录', '确认退出？', [
      { text: '取消', style: 'cancel' },
      {
        text: '退出', style: 'destructive', onPress: async () => {
          await supabase.auth.signOut();
          router.replace('/login');
        }
      },
    ]);
  };

  const handlePickAvatar = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('需要相册权限', '请在系统设置中允许访问相册');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setEditAvatarUri(result.assets[0].uri);
    }
  };

  const handleSaveProfile = async () => {
    if (!editName.trim()) {
      Alert.alert('提示', '名字不能为空');
      return;
    }
    setProfileSaving(true);
    try {
      if (!userId) throw new Error('未登录');
      const uid = userId;
      let newAvatarUrl = avatarUrl;

      if (editAvatarUri) {
        const ext = editAvatarUri.split('.').pop()?.toLowerCase() || 'jpg';
        const path = `avatars/${uid}/avatar.${ext}`;
        const base64 = await FileSystem.readAsStringAsync(editAvatarUri, { encoding: 'base64' });
        const byteArray = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const { error: upErr } = await supabase.storage
          .from('avatars')
          .upload(path, byteArray, { contentType: `image/${ext}`, upsert: true });
        if (upErr) throw upErr;
        const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(path);
        newAvatarUrl = `${urlData.publicUrl}?t=${Date.now()}`;
      }

      const { error: updateErr } = await supabase
        .from('users')
        .update({ name: editName.trim(), ...(newAvatarUrl !== avatarUrl ? { avatar_url: newAvatarUrl } : {}) })
        .eq('id', uid);
      if (updateErr) throw updateErr;

      setUserName(editName.trim());
      if (newAvatarUrl !== avatarUrl) setAvatarUrl(newAvatarUrl);
      setShowProfileModal(false);
      setEditAvatarUri(null);
    } catch (e: any) {
      Alert.alert('保存失败', e?.message || '请稍后重试');
    } finally {
      setProfileSaving(false);
    }
  };

  const initials = userName ? userName[0].toUpperCase() : '我';

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView contentContainerStyle={s.scroll}>

        {/* 顶部标题 */}
        <View style={s.header}>
          <Text style={s.headerTitle}>我的</Text>
        </View>

        {/* 用户卡片 */}
        <Pressable
          style={({ pressed }) => [s.userCard, pressed && { opacity: 0.85 }]}
          onPress={() => { setEditName(userName); setEditAvatarUri(null); setShowProfileModal(true); }}>
          <View style={s.avatar}>
            {avatarUrl
              ? <Image source={{ uri: avatarUrl }} style={s.avatarImg} />
              : <Text style={s.avatarText}>{initials}</Text>
            }
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.userName}>{userName}</Text>
            <Text style={s.userMeta}>{familyName} · {role}</Text>
          </View>
          <ChevronRight size={18} color="rgba(31,31,31,0.2)" strokeWidth={1.5} />
        </Pressable>

        {/* 家庭分组（辅助权限：隐藏；家庭权限：展示） */}
        {!hideFamilyBlock ? (
          <>
            <Text style={s.groupLabel}>家庭</Text>
            <View style={s.group}>
              <MenuItem
                icon={Users}
                label="家庭成员"
                onPress={() => router.push('/family-members')}
              />
              {showFamilyFilesEntry ? (
                <MenuItem
                  icon={Folder}
                  label="家庭资料"
                  onPress={async () => {
                    // 检测设备生物识别能力，决定是否显示面容/指纹按钮
                    const [hasHw, enrolled, types] = await Promise.all([
                      LocalAuthentication.hasHardwareAsync(),
                      LocalAuthentication.isEnrolledAsync(),
                      LocalAuthentication.supportedAuthenticationTypesAsync(),
                    ]);
                    const available = hasHw && enrolled;
                    setBiometricAvailable(available);
                    if (available) {
                      const hasFace = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
                      setBiometricLabel(hasFace ? '面容验证' : '指纹验证');
                    }
                    setAuthHint('');
                    setShowFilesModal(true);
                  }}
                />
              ) : null}
              <MenuItem
                icon={FileText}
                label="家庭记录"
                onPress={() => router.push('/event-records' as any)}
                isLast
              />
            </View>
          </>
        ) : null}

        {/* 邀请码 */}
        {inviteCode && !hideFamilyBlock ? (
          <View style={s.inviteCard}>
            <View>
              <Text style={s.inviteLabel}>邀请码</Text>
              <Text style={s.inviteCode}>{inviteCode}</Text>
              <Text style={s.inviteDesc}>分享邀请码，邀请家人加入</Text>
            </View>
            <Pressable style={s.copyBtn} onPress={handleCopy}>
              <Copy size={18} color={colors.primary} strokeWidth={1.5} />
            </Pressable>
          </View>
        ) : null}

        {/* 版本更新 */}
        {Platform.OS === 'android' ? (
          <>
            <Text style={s.groupLabel}>应用</Text>
            <View style={s.group}>
              <MenuItem
                icon={RefreshCw}
                label="版本更新"
                badge={!!pendingUpdate}
                onPress={() => setShowUpdateModal(true)}
                isLast
              />
            </View>
          </>
        ) : null}

        {/* 隐私说明 */}
        <View style={s.privacyCard}>
          <Text style={s.privacyTitle}>🔐 你的数据只属于你</Text>
          <Text style={s.privacyDesc}>
            所有记录加密存储，不用于模型训练，不会分享给第三方。你可以随时导出或删除全部数据。
          </Text>
        </View>

        <View style={s.legalLinksWrap}>
          <Text style={s.legalLinks}>
            <Text style={s.legalLink} onPress={() => setLegalDoc('terms')}>
              《用户服务协议》
            </Text>
            <Text style={s.legalSep}> 与 </Text>
            <Text style={s.legalLink} onPress={() => setLegalDoc('privacy')}>
              《隐私政策》
            </Text>
          </Text>
        </View>

        {/* 退出登录 */}
        <Pressable style={s.logoutBtn} onPress={handleLogout}>
          <LogOut size={18} color={colors.destructive} strokeWidth={1.5} />
          <Text style={s.logoutText}>退出登录</Text>
        </Pressable>

        <View style={{ height: 32 }} />
      </ScrollView>

      <LegalDocumentModal open={legalDoc} onClose={() => setLegalDoc(null)} />
      <Modal visible={showFilesModal} transparent animationType="fade" onRequestClose={() => { setShowFilesModal(false); setAuthHint(''); }}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 32 }} onPress={() => { if (!verifying) { setShowFilesModal(false); setAuthHint(''); } }}>
          <View style={{ backgroundColor: colors.card, borderRadius: 24, padding: 28, width: '100%', alignItems: 'center' }}>
            <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: `${colors.primary}26`, alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Text style={{ fontSize: 28 }}>🔐</Text>
            </View>
            <Text style={{ fontSize: 18, fontWeight: '600', color: colors.foreground, marginBottom: 6 }}>验证身份</Text>
            <Text style={{ fontSize: 14, color: colors.mutedForeground, textAlign: 'center', marginBottom: 16, lineHeight: 20 }}>
              查看家庭资料需要验证身份
            </Text>
            {authHint ? (
              <Text style={{ fontSize: 13, color: colors.destructive, textAlign: 'center', marginBottom: 12 }}>{authHint}</Text>
            ) : null}
            {biometricAvailable ? (
              <Pressable
                style={{ width: '100%', height: 50, borderRadius: 14, backgroundColor: verifying ? colors.mutedForeground : colors.primary, alignItems: 'center', justifyContent: 'center', marginBottom: 10 }}
                onPress={async () => {
                  if (verifying) return;
                  setAuthHint('');
                  setVerifying(true);
                  try {
                    const result = await authenticateWithBiometric();
                    if (result.ok) {
                      setShowFilesModal(false);
                      router.push('/family-files' as any);
                    } else if (!result.cancelled && result.hint) {
                      setAuthHint(result.hint);
                    }
                  } catch {
                    Alert.alert('无法使用生物识别', '请尝试使用密码验证。');
                  } finally {
                    setVerifying(false);
                  }
                }}
                disabled={verifying}>
                {verifying
                  ? <ActivityIndicator size="small" color={colors.primaryForeground} />
                  : <Text style={{ fontSize: 16, fontWeight: '500', color: colors.primaryForeground }}>{biometricLabel}</Text>
                }
              </Pressable>
            ) : null}
            <Pressable
              style={{ width: '100%', height: 50, borderRadius: 14, backgroundColor: biometricAvailable ? colors.muted : (verifying ? colors.mutedForeground : colors.primary), alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}
              onPress={async () => {
                if (verifying) return;
                setAuthHint('');
                if (Platform.OS === 'web') {
                  Alert.alert('请在手机 App 中打开', '家庭资料需在 iOS / Android 应用内通过系统验证后访问。');
                  return;
                }
                setVerifying(true);
                try {
                  const result = await authenticateWithPasscode();
                  if (result.ok) {
                    setShowFilesModal(false);
                    router.push('/family-files' as any);
                  } else if (!result.cancelled && result.hint) {
                    setAuthHint(result.hint);
                  }
                } catch {
                  Alert.alert('无法使用本地验证', '若在安装或预览环境中遇到此提示，请在真机的「家厘」App 中重试。');
                } finally {
                  setVerifying(false);
                }
              }}
              disabled={verifying}>
              {verifying
                ? <ActivityIndicator size="small" color={biometricAvailable ? colors.foreground : colors.primaryForeground} />
                : <Text style={{ fontSize: 16, fontWeight: '500', color: biometricAvailable ? colors.mutedForeground : colors.primaryForeground }}>使用密码验证</Text>
              }
            </Pressable>
            <Pressable onPress={() => { setShowFilesModal(false); setAuthHint(''); }}>
              <Text style={{ fontSize: 14, color: colors.mutedForeground }}>取消</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
      <Modal visible={showProfileModal} transparent animationType="slide">
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' }} onPress={() => { if (!profileSaving) { setShowProfileModal(false); setEditAvatarUri(null); } }} />
        <View style={{ backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 28, paddingBottom: 40 }}>
          <Text style={{ fontSize: 17, fontWeight: '600', color: colors.foreground, marginBottom: 24, textAlign: 'center' }}>编辑个人信息</Text>

          {/* 头像 */}
          <Pressable style={{ alignSelf: 'center', marginBottom: 24 }} onPress={handlePickAvatar}>
            <View style={[s.avatar, { width: 80, height: 80, borderRadius: 24 }]}>
              {editAvatarUri
                ? <Image source={{ uri: editAvatarUri }} style={[s.avatarImg, { width: 80, height: 80, borderRadius: 24 }]} />
                : avatarUrl
                  ? <Image source={{ uri: avatarUrl }} style={[s.avatarImg, { width: 80, height: 80, borderRadius: 24 }]} />
                  : <Text style={[s.avatarText, { fontSize: 28 }]}>{initials}</Text>
              }
            </View>
            <View style={{ position: 'absolute', bottom: -4, right: -4, width: 26, height: 26, borderRadius: 13, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
              <Camera size={14} color={colors.primaryForeground} strokeWidth={2} />
            </View>
          </Pressable>

          {/* 用户名 */}
          <Text style={{ fontSize: 13, color: colors.mutedForeground, marginBottom: 6 }}>名字</Text>
          <TextInput
            style={{ height: 48, borderWidth: 1, borderColor: colors.hairline, borderRadius: 12, paddingHorizontal: 14, fontSize: 16, color: colors.foreground, backgroundColor: colors.card, marginBottom: 24 }}
            value={editName}
            onChangeText={setEditName}
            placeholder="输入你的名字"
            placeholderTextColor={colors.mutedForeground}
            maxLength={20}
          />

          <Pressable
            style={{ height: 50, borderRadius: 14, backgroundColor: profileSaving ? colors.mutedForeground : colors.primary, alignItems: 'center', justifyContent: 'center' }}
            onPress={handleSaveProfile}
            disabled={profileSaving}>
            {profileSaving
              ? <ActivityIndicator size="small" color={colors.primaryForeground} />
              : <Text style={{ fontSize: 16, fontWeight: '600', color: colors.primaryForeground }}>保存</Text>
            }
          </Pressable>
        </View>
      </Modal>
      {/* 版本更新弹窗 */}
      <Modal visible={showUpdateModal && !!pendingUpdate} transparent animationType="fade">
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 }}>
          <View style={{ width: '100%', backgroundColor: colors.card, borderRadius: 24, padding: 28 }}>
            <View style={{ alignItems: 'center', marginBottom: 20 }}>
              <Text style={{ fontSize: 40, marginBottom: 10 }}>🎉</Text>
              <Text style={{ fontSize: 18, fontWeight: '700', color: colors.foreground }}>
                发现新版本 {pendingUpdate?.version_name}
              </Text>
            </View>
            {pendingUpdate?.release_notes ? (
              <View style={{ backgroundColor: colors.muted, borderRadius: 14, padding: 16, marginBottom: 24 }}>
                <Text style={{ fontSize: 12, color: colors.mutedForeground, marginBottom: 8, fontWeight: '600' }}>更新内容</Text>
                <Text style={{ fontSize: 14, color: colors.foreground, lineHeight: 22 }}>{pendingUpdate.release_notes}</Text>
              </View>
            ) : null}
            {updateDownloading ? (
              <View style={{ alignItems: 'center', gap: 10 }}>
                <View style={{ width: '100%', height: 8, borderRadius: 4, backgroundColor: colors.muted, overflow: 'hidden' }}>
                  <View style={{ height: '100%', borderRadius: 4, backgroundColor: colors.primary, width: `${updateProgress}%` }} />
                </View>
                <Text style={{ fontSize: 13, color: colors.mutedForeground }}>
                  {updateProgress < 100 ? `下载中 ${updateProgress}%` : '准备安装…'}
                </Text>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Pressable
                  onPress={() => setShowUpdateModal(false)}
                  style={({ pressed }) => [{ flex: 1, height: 48, borderRadius: 14, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' }, pressed && { opacity: 0.7 }]}>
                  <Text style={{ fontSize: 15, color: colors.mutedForeground, fontWeight: '600' }}>稍后</Text>
                </Pressable>
                <Pressable
                  onPress={async () => {
                    if (!pendingUpdate) return;
                    setUpdateDownloading(true);
                    setUpdateProgress(0);
                    try {
                      await downloadAndInstallApk(pendingUpdate.download_url, ({ percent }) => setUpdateProgress(percent));
                      // 安装触发后清除红点
                      await AsyncStorage.removeItem(PENDING_UPDATE_KEY);
                      setPendingUpdate(null);
                      setShowUpdateModal(false);
                    } catch (e: unknown) {
                      const msg = e instanceof Error ? e.message : '下载失败，请稍后重试';
                      Alert.alert('更新失败', msg);
                    } finally {
                      setUpdateDownloading(false);
                    }
                  }}
                  style={({ pressed }) => [{ flex: 1, height: 48, borderRadius: 14, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }, pressed && { opacity: 0.88 }]}>
                  <Text style={{ fontSize: 15, color: '#fff', fontWeight: '600' }}>立即更新</Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function MenuItem({ icon: Icon, label, onPress, isLast, badge }: {
  icon: any;
  label: string;
  onPress?: () => void;
  isLast?: boolean;
  badge?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [s.menuItem, !isLast && s.menuItemBorder, pressed && { backgroundColor: colors.muted }]}
      onPress={onPress}>
      <Icon size={20} color={colors.mutedForeground} strokeWidth={1.5} />
      <Text style={s.menuLabel}>{label}</Text>
      {badge && (
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#e03030', marginRight: 6 }} />
      )}
      <ChevronRight size={18} color="rgba(31,31,31,0.2)" strokeWidth={1.5} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scroll: { paddingBottom: 32 },
  header: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 20,
  },
  headerTitle: { fontSize: 28, fontWeight: '500', color: colors.foreground },
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    backgroundColor: colors.card,
    marginHorizontal: 24,
    marginTop: 20,
    borderRadius: 20,
    padding: 20,
    borderWidth: 0.5,
    borderColor: colors.border,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImg: { width: 56, height: 56, borderRadius: 18 },
  avatarText: { fontSize: 22, fontWeight: '500', color: colors.primaryForeground },
  userName: { fontSize: 20, fontWeight: '500', color: colors.foreground },
  userMeta: { fontSize: 14, color: colors.mutedForeground, marginTop: 2 },
  groupLabel: {
    fontSize: 13,
    color: colors.mutedForeground,
    marginLeft: 28,
    marginTop: 24,
    marginBottom: 8,
  },
  group: {
    backgroundColor: colors.card,
    marginHorizontal: 24,
    borderRadius: 20,
    borderWidth: 0.5,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  menuItemBorder: {
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
  },
  menuLabel: { flex: 1, fontSize: 15, color: colors.foreground },
  inviteCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.card,
    marginHorizontal: 24,
    marginTop: 24,
    borderRadius: 20,
    padding: 20,
    borderWidth: 0.5,
    borderColor: colors.border,
  },
  inviteLabel: { fontSize: 12, color: colors.mutedForeground, marginBottom: 4 },
  inviteCode: { fontSize: 24, fontWeight: '500', color: colors.foreground, letterSpacing: 3 },
  inviteDesc: { fontSize: 13, color: colors.mutedForeground, marginTop: 4 },
  copyBtn: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: `${colors.primary}18`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacyCard: {
    backgroundColor: colors.card,
    marginHorizontal: 24,
    marginTop: 16,
    borderRadius: 20,
    padding: 20,
    borderWidth: 0.5,
    borderColor: colors.border,
  },
  privacyTitle: { fontSize: 15, fontWeight: '500', color: colors.foreground, marginBottom: 8 },
  privacyDesc: { fontSize: 13, color: colors.mutedForeground, lineHeight: 20 },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.card,
    marginHorizontal: 24,
    marginTop: 20,
    borderRadius: 20,
    padding: 16,
    borderWidth: 0.5,
    borderColor: colors.border,
  },
  logoutText: { fontSize: 15, color: colors.destructive, fontWeight: '500' },
  legalLinksWrap: {
    marginTop: 20,
    marginBottom: 4,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  legalLinks: {
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 20,
  },
  /** 低饱和、可点文案（不加粗、无下划线） */
  legalLink: {
    color: 'rgba(90, 108, 255, 0.45)',
    fontWeight: '400',
  },
  legalSep: {
    fontSize: 13,
    color: 'rgba(142, 142, 147, 0.85)',
    fontWeight: '400',
  },
});