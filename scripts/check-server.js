const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = [];
function walk(dir) {
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full);
    else if (full.endsWith('.js')) files.push(full);
  }
}
walk(path.join(root, 'src'));
walk(path.join(root, 'scripts'));
let failed = false;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed = true;
    console.error(`Syntax failed: ${path.relative(root, file)}`);
    console.error(r.stderr || r.stdout);
  }
}
if (failed) process.exit(1);
console.log(`Server syntax check passed: ${files.length} JS files.`);
