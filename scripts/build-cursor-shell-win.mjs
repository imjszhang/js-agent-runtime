// Rebuild the checked-in Windows shell shim, or check that its source snapshot is current.
// Windows: node scripts/build-cursor-shell-win.mjs
// macOS/Linux with Docker: node scripts/build-cursor-shell-win.mjs --docker
// Any host, no compiler: node scripts/build-cursor-shell-win.mjs --check-source
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourcePath = path.join(root, 'src/cursor-shell-win.cs');
const outputPath = path.join(root, 'src/cursor-shell-win-exe.ts');
const dockerImage = 'mono:6.12';
const hash = value => createHash('sha256').update(value).digest('hex');
// Git can check out C# with CRLF on Windows. Hash and compile the same LF text everywhere.
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
const sourceHash = hash(source);
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !['--docker', '--check-source'].includes(args[0]))) {
  throw new Error('Usage: node scripts/build-cursor-shell-win.mjs [--docker | --check-source]');
}

function embedded() {
  const text = readFileSync(outputPath, 'utf8');
  const sourceSha = text.match(/export const CURSOR_SHELL_WIN_SOURCE_SHA256 = "([a-f0-9]{64})";/)?.[1];
  const exeSha = text.match(/export const CURSOR_SHELL_WIN_EXE_SHA256 = "([a-f0-9]{64})";/)?.[1];
  const encoded = text.match(/export const CURSOR_SHELL_WIN_EXE = Buffer\.from\(\s*((?:"[A-Za-z0-9+/=]+"\s*\+\s*)*"[A-Za-z0-9+/=]+")\s*,\s*"base64"\s*,?\s*\);/);
  assert.ok(encoded, 'Cannot read the generated Windows shim; rebuild it');
  const bytes = Buffer.from([...encoded[1].matchAll(/"([A-Za-z0-9+/=]+)"/g)].map(match => match[1]).join(''), 'base64');
  assert.equal(sourceSha, sourceHash, 'Windows shim source changed; rebuild src/cursor-shell-win-exe.ts');
  assert.equal(exeSha, hash(bytes), 'Windows shim binary hash does not match its generated metadata');
  return bytes;
}

if (args[0] === '--check-source') {
  const bytes = embedded();
  console.log(`Windows shim source snapshot and binary hash match (${bytes.length} bytes)`);
} else {
  if (process.platform !== 'win32' && args[0] !== '--docker') {
    throw new Error('Use --docker on macOS/Linux, or rebuild with the .NET Framework compiler on Windows');
  }
  const temp = mkdtempSync(path.join(tmpdir(), 'cursor-shell-build-'));
  try {
    writeFileSync(path.join(temp, 'cursor-shell-win.cs'), source);
    let compiler;
    if (args[0] === '--docker') {
      // Only this temporary source/output directory is mounted; no host credentials or repo are exposed.
      const dockerArgs = ['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp',
        '--mount', `type=bind,source=${temp},target=/work`, '--workdir', '/work', dockerImage];
      // The interpreter also works when Docker runs an amd64 image on Apple Silicon.
      const compilerArgs = ['mono', '--interpreter', '/usr/lib/mono/4.5/mcs.exe'];
      const version = execFileSync('docker', [...dockerArgs, ...compilerArgs, '--version'], { encoding: 'utf8', timeout: 180_000 }).trim();
      const imageId = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', dockerImage],
        { encoding: 'utf8', timeout: 30_000 }).trim();
      execFileSync('docker', [...dockerArgs, ...compilerArgs, '-noconfig', '-sdk:4.5', '-r:System.dll', '-r:System.Core.dll',
        '-optimize+', '-debug-', '-target:exe', '-out:cursor-shell.exe', 'cursor-shell-win.cs'],
      { stdio: 'inherit', timeout: 180_000 });
      compiler = `${version}; Docker ${dockerImage} (${imageId}); mono --interpreter mcs.exe -noconfig -sdk:4.5 -r:System.dll -r:System.Core.dll -optimize+ -debug- -target:exe`;
    } else {
      const frameworkRoot = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET');
      const framework = ['Framework64', 'Framework'].map(dir => path.join(frameworkRoot, dir, 'v4.0.30319'))
        .find(dir => existsSync(path.join(dir, 'csc.exe')));
      assert.ok(framework, 'The .NET Framework C# compiler was not found');
      execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/noconfig', '/target:exe', '/platform:anycpu',
        '/optimize+', '/debug-', `/r:${path.join(framework, 'System.dll')}`, `/r:${path.join(framework, 'System.Core.dll')}`,
        '/out:cursor-shell.exe', 'cursor-shell-win.cs'], { cwd: temp, stdio: 'inherit', timeout: 120_000 });
      compiler = '.NET Framework v4.0.30319 csc; /noconfig /target:exe /platform:anycpu /optimize+ /debug-';
    }
    const bytes = readFileSync(path.join(temp, 'cursor-shell.exe'));
    assert.equal(bytes.subarray(0, 2).toString('ascii'), 'MZ', 'Compiler did not produce a Windows executable');
    const chunks = bytes.toString('base64').match(/.{1,76}/g);
    const generated = [
      '// Generated by scripts/build-cursor-shell-win.mjs. Do not edit the embedded bytes.',
      '// Source SHA-256 uses UTF-8 with LF line endings. --check-source checks freshness, not reproducible compilation.',
      `// Compiler: ${compiler}`,
      `export const CURSOR_SHELL_WIN_SOURCE_SHA256 = "${sourceHash}";`,
      `export const CURSOR_SHELL_WIN_EXE_SHA256 = "${hash(bytes)}";`,
      'export const CURSOR_SHELL_WIN_EXE = Buffer.from(',
      chunks.map(chunk => `  "${chunk}"`).join(' +\n') + ',',
      '  "base64",',
      ');',
      '',
    ].join('\n');
    writeFileSync(outputPath, generated);
    embedded();
    console.log(`Generated src/cursor-shell-win-exe.ts (${bytes.length} bytes, source ${sourceHash})`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
