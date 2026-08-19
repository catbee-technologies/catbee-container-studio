import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const frontendDir = path.join(rootDir, 'frontend');

const rootPackagePath = path.join(rootDir, 'package.json');

const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8'));
const version = rootPackage.version;

const backendConstantsPath = path.join(rootDir, 'src/main/constants.ts');

const frontendEnvFiles = [
  path.join(frontendDir, 'src/environments/environment.ts'),
  path.join(frontendDir, 'src/environments/environment.dev.ts')
];

function updateFile(filePath, regex, replacement) {
  const file = fs.readFileSync(filePath, 'utf8');
  const updated = file.replace(regex, replacement);
  if (file === updated) {
    console.warn(`No version found in ${path.relative(rootDir, filePath)}`);
    return;
  }
  fs.writeFileSync(filePath, updated);
  console.log(`Updated ${path.relative(rootDir, filePath)} to ${version}`);
}

updateFile(
  backendConstantsPath,
  /export const APP_VERSION\s*=\s*['"][^'"]*['"]/,
  `export const APP_VERSION = '${version}'`
);

for (const filePath of frontendEnvFiles) {
  updateFile(filePath, /version:\s*['"][^'"]*['"]/, `version: '${version}'`);
}

const frontendPackagePath = path.join(frontendDir, 'package.json');
const frontendPackage = JSON.parse(fs.readFileSync(frontendPackagePath, 'utf8'));
frontendPackage.version = version;

fs.writeFileSync(frontendPackagePath, `${JSON.stringify(frontendPackage, null, 2)}\n`);

execFileSync(process.execPath, [process.env.npm_execpath, 'install', '--package-lock-only', '--ignore-scripts'], {
  cwd: frontendDir,
  stdio: 'inherit'
});
