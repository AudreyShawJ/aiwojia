const path = require('path');
const fs = require('fs');

/**
 * 环境文件选择（与 eas.json 里 profile 名称一致）：
 * - production  → .prod（正式 Supabase / API）
 * - 其它（preview、本地 expo start 等）→ .env（测试）
 *
 * 本地想连正式库调试：APP_ENV=production npm run start
 * 或：USE_PROD_ENV=1 npm run start
 *
 * EAS 云端构建时 .prod 通常不会上传（在 .gitignore 里），请在 Expo 网页给 production
 * 环境配置同名 EXPO_PUBLIC_* 变量；若已注入 process.env，则缺少 .prod 文件也不会覆盖。
 */
function pickEnvBasename() {
  const profile = process.env.EAS_BUILD_PROFILE || '';
  if (profile === 'production') return '.prod';
  if (process.env.APP_ENV === 'production') return '.prod';
  if (process.env.USE_PROD_ENV === '1') return '.prod';
  return '.env';
}

const root = __dirname;
const basename = pickEnvBasename();
const envPath = path.join(root, basename);

if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath, override: true });
  // 便于确认：正式/测试是否加载了对应文件（勿在日志里打印完整 key）
  console.log(
    `[app.config] 已加载 ${basename}，SUPABASE 主机：` +
      String(process.env.EXPO_PUBLIC_SUPABASE_URL || '(未设置)').replace(/^https?:\/\//, '').split('/')[0]
  );
} else if (basename === '.prod') {
  const hasSupabase = Boolean(process.env.EXPO_PUBLIC_SUPABASE_URL);
  if (!hasSupabase) {
    console.warn(
      `[app.config] 未找到 ${basename}，且未检测到 EXPO_PUBLIC_SUPABASE_URL。正式包请在 EAS「production」环境变量里配置，或在本机创建 .prod。`
    );
  }
} else {
  console.warn(`[app.config] 未找到 ${basename}，请从 .env.example 复制并填写。`);
}

module.exports = require('./app.json').expo;
