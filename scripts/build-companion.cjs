const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32') process.exit(0);

const root = path.join(__dirname, '..');
const compiler = ['Framework64', 'Framework']
  .map(folder => path.join(process.env.WINDIR, 'Microsoft.NET', folder, 'v4.0.30319', 'csc.exe'))
  .find(file => fs.existsSync(file));
if (!compiler) throw new Error('Windows .NET Framework C# compiler was not found.');

const source = path.join(root, 'src', 'windows-companion.cs');
const output = path.join(root, 'dist', 'Map Live Companion.exe');
if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) process.exit(0);
fs.mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync(compiler, ['/nologo', '/target:winexe', '/optimize+', '/out:' + output,
  '/reference:System.Windows.Forms.dll', source], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
