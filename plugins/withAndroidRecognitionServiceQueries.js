/**
 * Android 11+ 包可见性：声明对系统语音识别服务接口的查询。
 * 不绑定具体包名时，可发现华为/小米/OPPO/vivo 等任意实现 RecognitionService 的系统组件，
 * 作为 expo-speech-recognition 按包名列举的补充。
 *
 * @see https://developer.android.com/training/package-visibility/declaring
 */
const { withAndroidManifest } = require('expo/config-plugins');

const RECOGNITION_SERVICE_ACTION = 'android.speech.RecognitionService';

function hasStandaloneRecognitionServiceQuery(queries) {
  if (!Array.isArray(queries)) return false;
  return queries.some((q) => {
    if (q.package?.length) return false;
    return q.intent?.some((intent) =>
      intent.action?.some((a) => a.$?.['android:name'] === RECOGNITION_SERVICE_ACTION)
    );
  });
}

function withAndroidRecognitionServiceQueries(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.queries = manifest.queries || [];
    if (!hasStandaloneRecognitionServiceQuery(manifest.queries)) {
      manifest.queries.push({
        intent: [
          {
            action: [{ $: { 'android:name': RECOGNITION_SERVICE_ACTION } }],
          },
        ],
      });
    }
    return cfg;
  });
}

module.exports = function withPlugin(config) {
  return withAndroidRecognitionServiceQueries(config);
};
