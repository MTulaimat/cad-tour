// Locate (or download) the official KTX-Software `ktx` CLI into the gitignored tools/ folder.
//
// Resolution order:
//   1. $KTX_BIN (path to a ktx / ktx.exe you already have)
//   2. tools/ktx-<version>/bin/ktx(.exe) from a previous run
//   3. `ktx` on PATH, if its version matches
//   4. download the KTX-Software release from GitHub and extract the bin/ folder:
//        Windows: the NSIS installer is unpacked with 7-Zip (7z on PATH or in Program Files),
//                 nothing is installed and no registry keys are written
//        Linux:   the .tar.bz2 is unpacked with tar
//        macOS:   only a .pkg is published; install it (or `brew install ktx-software`) and
//                 set KTX_BIN, or put ktx on PATH
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { downloadFile } from './net.mjs';

export const KTX_VERSION = '4.4.2';

function ktxVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = /v?(\d+\.\d+\.\d+)/.exec(r.stdout + r.stderr);
  return m ? m[1] : null;
}

function find7z() {
  const candidates = ['7z', '7za'];
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(path.join(base, '7-Zip', '7z.exe'));
  }
  for (const c of candidates) {
    const r = spawnSync(c, ['i'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

/** @param {string} root repo root @returns {Promise<string>} path to the ktx executable */
export async function ensureKtx(root) {
  if (process.env.KTX_BIN) {
    if (!ktxVersion(process.env.KTX_BIN)) throw new Error(`KTX_BIN=${process.env.KTX_BIN} does not run`);
    return process.env.KTX_BIN;
  }
  const exe = process.platform === 'win32' ? 'ktx.exe' : 'ktx';
  const toolDir = path.join(root, 'tools', `ktx-${KTX_VERSION}`);
  const local = path.join(toolDir, 'bin', exe);
  if (existsSync(local) && ktxVersion(local)) return local;
  if (ktxVersion('ktx') === KTX_VERSION) return 'ktx';

  const base = `https://github.com/KhronosGroup/KTX-Software/releases/download/v${KTX_VERSION}`;
  const dlDir = path.join(root, 'tools', `ktx-${KTX_VERSION}-download`);
  await fs.mkdir(dlDir, { recursive: true });
  await fs.mkdir(toolDir, { recursive: true });

  if (process.platform === 'win32') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const name = `KTX-Software-${KTX_VERSION}-Windows-${arch}.exe`;
    const file = path.join(dlDir, name);
    console.log(`Downloading ${name} ...`);
    await downloadFile(`${base}/${name}`, file);
    const sevenZip = find7z();
    if (!sevenZip) {
      throw new Error(
        `7-Zip is needed to unpack ${name} without installing it. Install 7-Zip, or install ` +
          `KTX-Software ${KTX_VERSION} yourself and set KTX_BIN to its bin\\ktx.exe.`,
      );
    }
    const r = spawnSync(sevenZip, ['x', '-y', `-o${toolDir}`, file, 'bin\\*'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`7-Zip failed: ${r.stderr || r.stdout}`);
  } else if (process.platform === 'linux') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    const name = `KTX-Software-${KTX_VERSION}-Linux-${arch}.tar.bz2`;
    const file = path.join(dlDir, name);
    console.log(`Downloading ${name} ...`);
    await downloadFile(`${base}/${name}`, file);
    const r = spawnSync('tar', ['-xjf', file, '-C', toolDir, '--strip-components=1'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tar failed: ${r.stderr || r.stdout}`);
    // The tarball keeps libktx next to bin/ under lib/; ktx finds it through its RPATH.
  } else {
    throw new Error(
      `No portable KTX-Software build for ${process.platform}. Install KTX-Software ${KTX_VERSION} ` +
        `(https://github.com/KhronosGroup/KTX-Software/releases or brew install ktx-software) and set KTX_BIN.`,
    );
  }
  if (!existsSync(local) || !ktxVersion(local)) throw new Error(`ktx not found at ${local} after extraction`);
  return local;
}
