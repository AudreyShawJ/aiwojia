import * as FileSystem from 'expo-file-system/legacy';

/**
 * 将文件 URI 读取为 base64 字符串。
 * 兼容 content:// 等 URI：在 Expo Go 下 readAsStringAsync 对相册 URI 可能返回空，
 * 先 copyAsync 到缓存再读取。
 * @param uri 文件 URI（支持 file://、content:// 等）
 * @param fileName 可选，用于推断扩展名（如 content URI 无扩展名时）
 */
export async function readFileAsBase64(uri: string, fileName?: string): Promise<string> {
  const extFromUri = uri.split('.').pop()?.split('?')[0]?.toLowerCase();
  const extFromName = fileName?.split('.').pop()?.toLowerCase();
  const ext = extFromUri || extFromName || 'bin';
  const tempPath = `${FileSystem.cacheDirectory}upload_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  try {
    await FileSystem.copyAsync({ from: uri, to: tempPath });
    const base64 = await FileSystem.readAsStringAsync(tempPath, {
      encoding: 'base64' as any,
    });
    if (!base64 || base64.length === 0) {
      throw new Error('文件内容为空');
    }
    return base64;
  } finally {
    await FileSystem.deleteAsync(tempPath, { idempotent: true }).catch(() => {});
  }
}

export function decodeBase64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
