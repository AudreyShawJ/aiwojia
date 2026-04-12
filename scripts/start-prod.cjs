/**
 * 本地连正式库：先把 .prod 写进 process.env，再启动 Expo，
 * 避免仅依赖 APP_ENV 时子进程（Metro）仍按 .env 打包的问题。
 */
const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.prod'), override: true });
process.env.APP_ENV = 'production';

const child = spawn('npx', ['expo', 'start', '--clear'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
