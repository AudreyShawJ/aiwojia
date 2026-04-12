/**
 * 阿里云一句话语音识别（通过 Edge Function 保护密钥）
 *
 * 使用 expo-av 录音 → base64 → POST 至 supabase edge function aliyun-asr
 */

import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from './supabase';

export type AsrState =
  | { status: 'idle' }
  | { status: 'recording'; stop: () => Promise<string | null> }
  | { status: 'transcribing' }
  | { status: 'done'; text: string }
  | { status: 'error'; message: string };

const RECORDING_OPTIONS: Audio.RecordingOptions = {
  android: {
    extension: '.aac',
    outputFormat: Audio.AndroidOutputFormat.AAC_ADTS,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 64000,
  },
  ios: {
    extension: '.wav',
    outputFormat: Audio.IOSOutputFormat.LINEARPCM,
    audioQuality: Audio.IOSAudioQuality.HIGH,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 256000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/wav',
    bitsPerSecond: 256000,
  },
};

/**
 * 请求麦克风权限。返回 true 表示已授权。
 */
export async function requestMicPermission(): Promise<boolean> {
  const { granted } = await Audio.requestPermissionsAsync();
  return granted;
}

/**
 * 开始录音。返回 stop 函数，调用后返回识别文本（或 null 表示失败）。
 * 录音自动限制在 60 秒。
 */
export async function startRecording(
  onStateChange: (s: AsrState) => void,
): Promise<{ stop: () => Promise<string | null> } | null> {
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });

    const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS);

    let stopped = false;

    const stop = async (): Promise<string | null> => {
      if (stopped) return null;
      stopped = true;
      try {
        await recording.stopAndUnloadAsync();
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      } catch {
        // ignore unload errors
      }

      const uri = recording.getURI();
      if (!uri) {
        onStateChange({ status: 'error', message: '录音文件不存在' });
        return null;
      }

      onStateChange({ status: 'transcribing' });

      try {
        // Read as base64
        const base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });

        // Detect format from extension
        const ext = uri.split('.').pop()?.toLowerCase() ?? 'wav';
        const format = ext === 'aac' ? 'aac' : ext === 'm4a' ? 'aac' : 'wav';

        // Call edge function
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;

        const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
        const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

        const res = await fetch(`${supabaseUrl}/functions/v1/aliyun-asr`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${token ?? supabaseAnonKey}`,
          },
          body: JSON.stringify({ audio: base64, format, sampleRate: 16000 }),
        });

        const json = await res.json() as { text?: string; error?: string };
        if (json.error) {
          onStateChange({ status: 'error', message: json.error });
          return null;
        }

        const text = json.text ?? '';
        onStateChange({ status: 'done', text });
        return text;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        onStateChange({ status: 'error', message: msg });
        return null;
      } finally {
        // Clean up temp file
        try {
          await FileSystem.deleteAsync(uri, { idempotent: true });
        } catch {}
      }
    };

    // Auto-stop after 60s
    const autoStop = setTimeout(() => stop(), 60_000);
    const wrappedStop = async (): Promise<string | null> => {
      clearTimeout(autoStop);
      return stop();
    };

    onStateChange({ status: 'recording', stop: wrappedStop });
    return { stop: wrappedStop };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    onStateChange({ status: 'error', message: msg });
    return null;
  }
}
