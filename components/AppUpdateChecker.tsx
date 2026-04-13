import { colors } from '@/constants/designTokens';
import { checkForUpdate, downloadAndInstallApk, type AppVersionRow } from '@/lib/appUpdate';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

/** AsyncStorage key：稍后再说后存放待更新版本信息，供【我的】页面读取红点 */
export const PENDING_UPDATE_KEY = 'pending_app_update';

export function AppUpdateChecker() {
  const [updateInfo, setUpdateInfo] = useState<AppVersionRow | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    checkForUpdate().then(async info => {
      if (!info) {
        // 已是最新版本，清除之前存的待更新信息
        await AsyncStorage.removeItem(PENDING_UPDATE_KEY);
        return;
      }
      // 如果已存为"稍后再说"的版本，弹窗也不再弹（让红点提醒）
      const stored = await AsyncStorage.getItem(PENDING_UPDATE_KEY);
      if (stored) {
        const pending = JSON.parse(stored) as AppVersionRow;
        // 若远端有更新的版本，更新存储并继续不弹
        if (info.version_code > pending.version_code) {
          await AsyncStorage.setItem(PENDING_UPDATE_KEY, JSON.stringify(info));
        }
        return;
      }
      setUpdateInfo(info);
    });
  }, []);

  if (!updateInfo) return null;

  const isForce = updateInfo.force_update;

  const handleUpdate = async () => {
    setDownloading(true);
    setProgress(0);
    try {
      await downloadAndInstallApk(updateInfo.download_url, ({ percent }) => {
        setProgress(percent);
      });
    } catch (e: unknown) {
      setDownloading(false);
      const msg = e instanceof Error ? e.message : '下载失败，请稍后重试';
      Alert.alert('更新失败', msg);
    }
  };

  const handleLater = async () => {
    if (isForce) return;
    // 存到 AsyncStorage，【我的】页显示红点
    await AsyncStorage.setItem(PENDING_UPDATE_KEY, JSON.stringify(updateInfo));
    setUpdateInfo(null);
  };

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={isForce ? undefined : handleLater}>
      <View style={s.overlay}>
        <View style={s.card}>
          <View style={s.header}>
            <Text style={s.emoji}>🎉</Text>
            <Text style={s.title}>发现新版本 {updateInfo.version_name}</Text>
            {isForce && (
              <View style={s.forceBadge}>
                <Text style={s.forceBadgeText}>需要更新</Text>
              </View>
            )}
          </View>

          {updateInfo.release_notes ? (
            <View style={s.notesWrap}>
              <Text style={s.notesTitle}>更新内容</Text>
              <Text style={s.notesBody}>{updateInfo.release_notes}</Text>
            </View>
          ) : null}

          {downloading ? (
            <View style={s.progressWrap}>
              <View style={s.progressBg}>
                <View style={[s.progressBar, { width: `${progress}%` }]} />
              </View>
              <Text style={s.progressText}>
                {progress < 100 ? `下载中 ${progress}%` : '准备安装…'}
              </Text>
            </View>
          ) : (
            <View style={s.btns}>
              {!isForce && (
                <Pressable
                  onPress={handleLater}
                  style={({ pressed }) => [s.btnLater, pressed && { opacity: 0.7 }]}>
                  <Text style={s.btnLaterText}>稍后再说</Text>
                </Pressable>
              )}
              <Pressable
                onPress={handleUpdate}
                style={({ pressed }) => [s.btnUpdate, pressed && { opacity: 0.88 }, isForce && { flex: 1 }]}>
                <Text style={s.btnUpdateText}>立即更新</Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const PRIMARY = colors.primary;

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  card: {
    width: '100%',
    backgroundColor: colors.card,
    borderRadius: 24,
    padding: 28,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  header: {
    alignItems: 'center',
    marginBottom: 20,
  },
  emoji: { fontSize: 40, marginBottom: 10 },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.foreground,
    textAlign: 'center',
  },
  forceBadge: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: 'rgba(255,80,80,0.12)',
  },
  forceBadgeText: { fontSize: 12, color: '#e03030', fontWeight: '600' },
  notesWrap: {
    backgroundColor: colors.muted,
    borderRadius: 14,
    padding: 16,
    marginBottom: 24,
  },
  notesTitle: {
    fontSize: 12,
    color: colors.mutedForeground,
    marginBottom: 8,
    fontWeight: '600',
  },
  notesBody: { fontSize: 14, color: colors.foreground, lineHeight: 22 },
  btns: { flexDirection: 'row', gap: 10 },
  btnLater: {
    flex: 1,
    height: 48,
    borderRadius: 14,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnLaterText: { fontSize: 15, color: colors.mutedForeground, fontWeight: '600' },
  btnUpdate: {
    flex: 1,
    height: 48,
    borderRadius: 14,
    backgroundColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: PRIMARY,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  btnUpdateText: { fontSize: 15, color: '#fff', fontWeight: '600' },
  progressWrap: { alignItems: 'center', gap: 10 },
  progressBg: {
    width: '100%',
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.muted,
    overflow: 'hidden',
  },
  progressBar: { height: '100%', borderRadius: 4, backgroundColor: PRIMARY },
  progressText: { fontSize: 13, color: colors.mutedForeground },
});
