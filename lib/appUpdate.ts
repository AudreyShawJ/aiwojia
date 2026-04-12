/**
 * APP 更新检查 + 下载安装（Android Only）
 *
 * 流程：
 * 1. 调蒲公英 check API 查最新版本
 * 2. 与本地 versionCode 比较
 * 3. 有新版本时返回版本信息，由调用方展示弹窗
 * 4. 用 expo-file-system 下载 APK 到本地
 * 5. 调 expo-intent-launcher 触发系统安装器
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Application from 'expo-application';
import { Platform } from 'react-native';

const PGYER_API_KEY = '25ef98e486a8caf85a75f2aebb6709d0';
const PGYER_APP_KEY = '886d79ee0d07eeb05f413167679b6f25';

export type AppVersionRow = {
  version_name: string;
  version_code: number;
  download_url: string;
  release_notes: string;
  force_update: boolean;
};

/**
 * 检查是否有新版本。
 * 返回新版本信息，或 null（无更新 / 非 Android / 出错）
 */
export async function checkForUpdate(): Promise<AppVersionRow | null> {
  if (Platform.OS !== 'android') return null;

  try {
    const localVersionCode = parseInt(Application.nativeBuildVersion ?? '1', 10);

    const res = await fetch(
      `https://www.pgyer.com/apiv2/app/check?_api_key=${PGYER_API_KEY}&appKey=${PGYER_APP_KEY}&buildVersion=${localVersionCode}`,
      { method: 'GET' }
    );
    const json = await res.json();

    // code=1247: 已是最新版本
    if (!json || json.code === 1247 || json.code !== 0) return null;

    const data = json.data;
    const remoteVersionCode = parseInt(data.buildBuildVersion ?? '0', 10);

    if (remoteVersionCode <= localVersionCode) return null;

    return {
      version_name: data.buildVersion ?? '',
      version_code: remoteVersionCode,
      download_url: data.downloadURL ?? '',
      release_notes: data.buildUpdateDescription ?? '',
      force_update: false,
    };
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

  const contentUri = await FileSystem.getContentUriAsync(result.uri);

  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    flags: 1,
    type: 'application/vnd.android.package-archive',
  });
}
