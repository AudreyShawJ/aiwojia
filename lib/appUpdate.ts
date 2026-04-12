/**
 * APP 更新检查 + 下载安装（Android Only）
 *
 * 流程：
 * 1. 从 Supabase app_versions 表查最新版本
 * 2. 与本地 Constants.expoConfig.version 比较
 * 3. 有新版本时返回版本信息，由调用方展示弹窗
 * 4. 用户确认后，用 expo-file-system 下载 APK 到本地
 * 5. 调 expo-intent-launcher 触发系统安装器
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';

export type AppVersionRow = {
  version_name: string;
  version_code: number;
  download_url: string;
  release_notes: string;
  force_update: boolean;
};

/** 把 "1.2.3" 转成整数 10203 方便比较（支持最多 3 段） */
function versionNameToCode(v: string): number {
  const parts = v.split('.').map(Number);
  return (parts[0] ?? 0) * 10000 + (parts[1] ?? 0) * 100 + (parts[2] ?? 0);
}

/**
 * 检查是否有新版本。
 * 返回新版本信息，或 null（无更新 / 非 Android / 出错）
 */
export async function checkForUpdate(): Promise<AppVersionRow | null> {
  if (Platform.OS !== 'android') return null;

  try {
    const { data, error } = await supabase
      .from('app_versions')
      .select('version_name, version_code, download_url, release_notes, force_update')
      .eq('platform', 'android')
      .order('version_code', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;

    const localVersionName = Constants.expoConfig?.version ?? '1.0.0';
    const localCode = versionNameToCode(localVersionName);
    const remoteCode = data.version_code;

    if (remoteCode <= localCode) return null;

    return data as AppVersionRow;
  } catch {
    return null;
  }
}

export type DownloadProgress = {
  /** 0-100 */
  percent: number;
};

/**
 * 下载 APK 并触发系统安装器。
 * @param downloadUrl  APK 直链
 * @param onProgress   下载进度回调
 */
export async function downloadAndInstallApk(
  downloadUrl: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const destUri = FileSystem.cacheDirectory + 'update.apk';

  // 删除旧的临时包（如有）
  try {
    await FileSystem.deleteAsync(destUri, { idempotent: true });
  } catch {}

  const downloadResumable = FileSystem.createDownloadResumable(
    downloadUrl,
    destUri,
    {},
    ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      if (onProgress && totalBytesExpectedToWrite > 0) {
        onProgress({
          percent: Math.round((totalBytesWritten / totalBytesExpectedToWrite) * 100),
        });
      }
    },
  );

  const result = await downloadResumable.downloadAsync();
  if (!result?.uri) throw new Error('APK 下载失败');

  // 获取 content URI（Android 7+ 需要通过 FileProvider）
  const contentUri = await FileSystem.getContentUriAsync(result.uri);

  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    flags: 1,          // FLAG_GRANT_READ_URI_PERMISSION
    type: 'application/vnd.android.package-archive',
  });
}
