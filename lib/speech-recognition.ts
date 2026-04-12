import { isRunningInExpoGo } from 'expo';

let ExpoSpeechRecognitionModule: any = null;
let useSpeechRecognitionEvent: (event: string, cb: (e: any) => void) => void = () => {};

/** Expo Go 未内置该原生模块；独立 APK / Dev Client 中加载 */
if (!isRunningInExpoGo()) {
  try {
    const mod = require('expo-speech-recognition');
    ExpoSpeechRecognitionModule = mod.ExpoSpeechRecognitionModule;
    useSpeechRecognitionEvent = mod.useSpeechRecognitionEvent;
  } catch {
    // 预构建或配置异常时静默降级
  }
}

export { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent };
