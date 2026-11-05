import { spawn } from 'node:child_process';

const api = spawn('npx', ['tsx', 'packages/server/src/cli.ts'], { stdio: 'inherit' });
const web = spawn('npm', ['run', 'dev', '-w', '@ours/web'], { stdio: 'inherit' });

function stop() {
  api.kill('SIGTERM');
  web.kill('SIGTERM');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.on('exit', (code) => {
  if (code) {
    web.kill('SIGTERM');
    process.exit(code);
  }
});
