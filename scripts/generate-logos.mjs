import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = path.resolve(__dirname, '..');

const ICONS_DIR = path.join(PROJECT_DIR, 'assets', 'icons');

const RAW_ICON = path.join(ICONS_DIR, 'raw.png');

const WINDOWS_DIR = path.join(ICONS_DIR, 'windows');
const MACOS_DIR = path.join(ICONS_DIR, 'macos');
const LINUX_DIR = path.join(ICONS_DIR, 'linux');

const WINDOWS_ICON = path.join(WINDOWS_DIR, 'catbee-icon.ico');
const MACOS_ICON = path.join(MACOS_DIR, 'catbee-icon.icns');
const LINUX_ICON = path.join(LINUX_DIR, 'catbee-icon.png');

const PYTHON = process.platform === 'win32' ? 'py' : 'python3';

function checkCommand(command, args = []) {
  try {
    execFileSync(command, args, {
      stdio: 'ignore',
      cwd: PROJECT_DIR,
    });

    return true;
  } catch {
    return false;
  }
}

function checkDependencies() {
  console.log('Checking dependencies...\n');

  // Python
  if (!checkCommand(PYTHON, ['--version'])) {
    console.error('❌ Python is not installed or is not available in PATH.\n');

    if (process.platform === 'win32') {
      console.error(
        'Install Python from:\n' +
        'https://www.python.org/downloads/\n'
      );
    } else if (process.platform === 'darwin') {
      console.error(
        'Install Python with Homebrew:\n' +
        'brew install python\n'
      );
    } else {
      console.error(
        'Install Python using your system package manager.\n'
      );
    }

    process.exit(1);
  }

  console.log('✓ Python found');

  // Pillow
  if (!checkCommand(PYTHON, ['-c', 'from PIL import Image'])) {
    console.error('\n❌ Python package "Pillow" is not installed.');
    console.error('\nInstall it with:');
    console.error(`  ${PYTHON} -m pip install Pillow\n`);
    process.exit(1);
  }

  console.log('✓ Pillow found');

  // icnsutil
  if (!checkCommand(PYTHON, ['-m', 'icnsutil', '--help'])) {
    console.error('\n❌ Python package "icnsutil" is not installed.');
    console.error('\nInstall it with:');
    console.error(`  ${PYTHON} -m pip install icnsutil\n`);
    process.exit(1);
  }

  console.log('✓ icnsutil found');

  console.log('\nAll dependencies are installed.\n');
}

function runPython(code) {
  execFileSync(PYTHON, ['-c', code], {
    stdio: 'inherit',
    cwd: PROJECT_DIR,
  });
}

function runPythonModule(module, args) {
  execFileSync(PYTHON, ['-m', module, ...args], {
    stdio: 'inherit',
    cwd: PROJECT_DIR,
  });
}

function ensureDirectories() {
  fs.mkdirSync(WINDOWS_DIR, { recursive: true });
  fs.mkdirSync(MACOS_DIR, { recursive: true });
  fs.mkdirSync(LINUX_DIR, { recursive: true });
}

function ensureRawIcon() {
  if (!fs.existsSync(RAW_ICON)) {
    throw new Error(`Missing source icon: ${RAW_ICON}`);
  }
}

function generateWindowsIcon() {
  console.log('Generating Windows ICO...');

  runPython(`
    from PIL import Image
    image = Image.open(r"${RAW_ICON}").convert("RGBA")
    image.save(r"${WINDOWS_ICON}", format="ICO",
    sizes=[
      (16, 16),
      (24, 24),
      (32, 32),
      (48, 48),
      (64, 64),
      (128, 128),
      (256, 256),
    ])`);
}

function verifyWindowsIcon() {
  console.log('Verifying Windows ICO...');

  runPython(`
    from PIL import Image
    image = Image.open(r"${WINDOWS_ICON}")
    print("ICO sizes:", sorted(image.ico.sizes()))
  `);
}

function generateMacOSIconSet() {
  console.log('Generating macOS iconset...');

  runPython(`
    from PIL import Image
    image = Image.open(r"${RAW_ICON}").convert("RGBA")
    sizes = [
      (16, 16, "icon_16x16.png"),
      (32, 32, "icon_16x16@2x.png"),
      (32, 32, "icon_32x32.png"),
      (64, 64, "icon_32x32@2x.png"),
      (128, 128, "icon_128x128.png"),
      (256, 256, "icon_128x128@2x.png"),
      (256, 256, "icon_256x256.png"),
      (512, 512, "icon_256x256@2x.png"),
      (512, 512, "icon_512x512.png"),
      (1024, 1024, "icon_512x512@2x.png")
    ]
    for width, height, filename in sizes:
        output = r"${MACOS_DIR}" + "/" + filename

        image.resize(
            (width, height),
            Image.Resampling.LANCZOS
        ).save(output)
  `);
}

function composeMacOSIcon() {
  console.log('Composing macOS ICNS...');

  const files = [
    'icon_16x16.png',
    'icon_16x16@2x.png',
    'icon_32x32.png',
    'icon_32x32@2x.png',
    'icon_128x128.png',
    'icon_128x128@2x.png',
    'icon_256x256.png',
    'icon_256x256@2x.png',
    'icon_512x512.png',
    'icon_512x512@2x.png',
  ];

  runPythonModule('icnsutil', [
    'compose',
    '-f',
    MACOS_ICON,
    ...files.map((file) => path.join(MACOS_DIR, file)),
  ]);
}

function verifyMacOSIcon() {
  console.log('Verifying macOS ICNS...');

  runPythonModule('icnsutil', [
    'info',
    MACOS_ICON,
  ]);
}

function cleanupMacOS() {
  console.log('Cleaning up macOS temporary PNGs...');

  for (const file of fs.readdirSync(MACOS_DIR)) {
    if (file.endsWith('.png')) {
      fs.rmSync(path.join(MACOS_DIR, file), {
        force: true,
      });
    }
  }
}

function generateLinuxIcon() {
  console.log('Generating Linux PNG...');

  runPython(`
    from PIL import Image
    image = Image.open(r"${RAW_ICON}").convert("RGBA")
    image.resize((512, 512), Image.Resampling.LANCZOS).save(r"${LINUX_ICON}")
  `);
}

function main() {
  console.log('Generating CatBee icons...\n');
  console.log(`Base: ${ICONS_DIR}\n`);

  checkDependencies();

  ensureDirectories();
  ensureRawIcon();

  // Windows
  generateWindowsIcon();
  verifyWindowsIcon();

  // macOS
  generateMacOSIconSet();
  composeMacOSIcon();
  verifyMacOSIcon();
  cleanupMacOS();

  // Linux
  generateLinuxIcon();

  console.log('\nDone!');
  console.log(`Windows: ${path.relative(PROJECT_DIR, WINDOWS_ICON)}`);
  console.log(`macOS:   ${path.relative(PROJECT_DIR, MACOS_ICON)}`);
  console.log(`Linux:   ${path.relative(PROJECT_DIR, LINUX_ICON)}`);
}

try {
  main();
} catch (error) {
  console.error('\n❌ Icon generation failed.');
  console.error(error.message);
  process.exit(1);
}