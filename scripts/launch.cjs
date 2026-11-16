const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const hasOzoneOverride = args.some(arg => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='));
const preferX11 = process.platform === 'linux' && process.env.DISPLAY && !hasOzoneOverride;
const switches = preferX11 ? ['--ozone-platform=x11'] : [];

const child = spawn(electron, [...switches, root, ...args], { cwd: root, stdio: 'inherit' });
child.on('error', error => {
  console.error('Map Live:', error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
});
