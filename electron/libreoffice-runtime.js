'use strict';

/**
 * LibreOffice process lifecycle.
 *
 * All LibreOffice work started by MorphEra goes through this module:
 *
 *  - every run gets a fresh, private `UserInstallation` profile;
 *  - every process is headless and cannot restore documents or show a wizard;
 *  - child trees are tracked and terminated on timeout, cancel or app exit;
 *  - stale processes left by an earlier crash are removed only when they use
 *    one of MorphEra's private profiles. A user's own LibreOffice windows are
 *    never touched.
 *
 * A private profile also means user extensions and user configuration cannot
 * influence conversions, which is the reliable equivalent of LibreOffice's
 * build-time `--disable-extensions` option (there is no documented runtime
 * switch with that name).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { killTree } = require('./proc');

const IS_WIN = process.platform === 'win32';
const PROFILE_ROOT = path.join(os.tmpdir(), 'MorphEra', 'lo-runtime');
const PROFILE_MARKER = /morphera[\\/]lo-(?:runtime|profile)/i;
const active = new Set();
const profiles = new Set();
let lastStaleCleanup = 0;

function powershellEnv() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  return {
    ...process.env,
    PSModulePath: [
      path.join(root, 'system32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      path.join(programFiles, 'WindowsPowerShell', 'Modules'),
    ].join(';'),
  };
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* caller will fail later */ }
}

/** Create an isolated LibreOffice profile for one operation. */
function createProfile() {
  ensureDir(PROFILE_ROOT);
  const dir = path.join(
    PROFILE_ROOT,
    `lo-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
  );
  ensureDir(dir);
  profiles.add(dir);
  return dir;
}

/** Best-effort removal; LibreOffice can hold profile files for a moment. */
function cleanupProfile(dir, attempt = 0) {
  if (!dir) return;
  profiles.delete(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    if (attempt < 3) {
      const timer = setTimeout(() => cleanupProfile(dir, attempt + 1), 250 * (attempt + 1));
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
  }
}

function cleanupInactiveProfiles() {
  let entries = [];
  try { entries = fs.readdirSync(PROFILE_ROOT); } catch { entries = []; }
  for (const name of entries) {
    if (!/^lo-/i.test(name)) continue;
    const dir = path.join(PROFILE_ROOT, name);
    if (profiles.has(dir)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still locked */ }
  }
  // Older MorphEra builds used `%TEMP%\MorphEra\lo-profile-*`. Once their
  // processes have been removed above, these orphaned folders can go too.
  try {
    const parent = path.dirname(PROFILE_ROOT);
    for (const name of fs.readdirSync(parent)) {
      if (!/^lo-profile-/i.test(name)) continue;
      try { fs.rmSync(path.join(parent, name), { recursive: true, force: true }); } catch { /* still locked */ }
    }
  } catch { /* ignore */ }
}

/**
 * Arguments shared by verification and conversions. `-env:` must appear
 * before the action arguments so the private profile is used for the whole
 * process, including first-start setup.
 */
function baseArgs(profile) {
  // LibreOffice's documented spelling is `--nofirststartwizard` (there is no
  // runtime flag with a hyphen between every word). A fresh private profile
  // also means no user extensions can load; `--disable-extensions` is a build
  // option in LibreOffice, not a start parameter.
  return [
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    '--headless',
    '--nologo',
    '--nodefault',
    '--norestore',
    '--nolockcheck',
    '--nofirststartwizard',
  ];
}

/**
 * Spawn a tracked LibreOffice process. The caller owns stdio and timeouts.
 * `args` are appended after the mandatory headless profile arguments.
 */
function spawnOffice(bin, profile, args, options = {}) {
  const child = spawn(bin, [...baseArgs(profile), ...(args || [])], {
    windowsHide: true,
    ...options,
    env: {
      ...process.env,
      // Force headless rendering. This prevents splash windows and display
      // access on machines where a desktop session is unavailable.
      SAL_USE_VCLPLUGIN: 'svp',
      ...(options.env || {}),
    },
  });
  active.add(child);
  const forget = () => active.delete(child);
  child.once('exit', forget);
  child.once('error', forget);
  return child;
}

/** Kill all child trees started by this process. */
function killTrackedSync() {
  for (const child of active) {
    try {
      if (IS_WIN) {
        if (child.pid) {
          execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true, timeout: 5000, stdio: 'ignore',
          });
        }
      } else {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    } catch { /* already exited */ }
  }
  active.clear();
}

function excludedPids(exclude) {
  return [...new Set([...exclude, ...active].filter((pid) => Number.isInteger(pid) && pid > 0))];
}

function parseWmicValueOutput(text) {
  const out = [];
  let current = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (current.ProcessId) { out.push(current); current = {}; }
      continue;
    }
    const at = line.indexOf('=');
    if (at < 0) continue;
    current[line.slice(0, at)] = line.slice(at + 1);
  }
  if (current.ProcessId) out.push(current);
  return out;
}

function wmicArgs() {
  return ['process', 'where', "name='soffice.exe' or name='soffice.bin'", 'get', 'ProcessId,CommandLine', '/value'];
}

/** Return matching Morphera-owned processes, or null when wmic is unavailable. */
function scanWindows(exclude) {
  return new Promise((resolve) => {
    execFile('wmic.exe', wmicArgs(), {
      timeout: 6000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8',
    }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const skip = new Set(excludedPids(exclude));
      const found = [];
      for (const item of parseWmicValueOutput(stdout)) {
        const pid = Number(item.ProcessId);
        if (!Number.isInteger(pid) || pid <= 0 || skip.has(pid)) continue;
        if (PROFILE_MARKER.test(String(item.CommandLine || ''))) found.push(pid);
      }
      resolve(found);
    });
  });
}

function scanWindowsSync(exclude) {
  try {
    const stdout = execFileSync('wmic.exe', wmicArgs(), {
      timeout: 6000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
    });
    const skip = new Set(excludedPids(exclude));
    const found = [];
    for (const item of parseWmicValueOutput(stdout)) {
      const pid = Number(item.ProcessId);
      if (!Number.isInteger(pid) || pid <= 0 || skip.has(pid)) continue;
      if (PROFILE_MARKER.test(String(item.CommandLine || ''))) found.push(pid);
    }
    return found;
  } catch {
    return null;
  }
}

function killPid(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true, timeout: 5000, stdio: 'ignore',
    }, () => resolve());
  });
}

function staleWindowsScript(exclude) {
  const skip = excludedPids(exclude).join(',');
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$skip = @(${skip})`,
    "$procs = Get-CimInstance Win32_Process -Filter \"Name = 'soffice.exe' OR Name = 'soffice.bin'\"",
    'foreach ($p in $procs) {',
    '  if ($skip -contains [int]$p.ProcessId) { continue }',
    '  $line = [string]$p.CommandLine',
    '  if ($line -match \'(?i)morphera[\\\\/]lo-\') {',
    '    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue',
    '  }',
    '}',
  ].join('\n');
}

function staleUnix(exclude) {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=,args='], {
      encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) { resolve(0); return; }
      const skip = new Set(excludedPids(exclude));
      let count = 0;
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s+(.+)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        if (pid === process.pid || skip.has(pid)) continue;
        if (!PROFILE_MARKER.test(m[2])) continue;
        try { process.kill(pid, 'SIGKILL'); count++; } catch { /* already gone */ }
      }
      resolve(count);
    });
  });
}

/**
 * Remove orphaned Morphera LibreOffice processes. User-installed LibreOffice
 * processes are never matched because their command line has no MorphEra
 * private profile path.
 */
async function killStale(opts = {}) {
  // Never sweep while MorphEra has a tracked conversion/verification running.
  // LibreOffice spawns soffice.bin children that we do not track individually;
  // killing by profile marker at this point could terminate a valid job. The
  // parent is tracked and `shutdownSync` force-kills its whole tree on exit.
  if (active.size > 0) return 0;
  const now = Date.now();
  if (!opts.force && now - lastStaleCleanup < 1200) return 0;
  lastStaleCleanup = now;

  if (IS_WIN) {
    const found = await scanWindows(opts.excludePids || []);
    if (found && found.length) await Promise.all(found.map(killPid));
    if (found === null) {
      // wmic is absent on some hardened/new Windows images. Fall back to CIM.
      await new Promise((resolve) => {
        execFile('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          staleWindowsScript(opts.excludePids || []),
        ], {
          timeout: opts.timeout || 15000,
          windowsHide: true,
          maxBuffer: 64 * 1024,
          stdio: ['ignore', 'ignore', 'ignore'],
          env: powershellEnv(),
        }, () => resolve());
      });
    }
  } else {
    await staleUnix(opts.excludePids || []);
  }
  cleanupInactiveProfiles();
  return 0;
}

/** Synchronous shutdown used from Electron's `before-quit` handler. */
function shutdownSync() {
  killTrackedSync();
  if (IS_WIN) {
    const found = scanWindowsSync([]);
    if (found && found.length) {
      for (const pid of found) {
        try {
          execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
            windowsHide: true, timeout: 5000, stdio: 'ignore',
          });
        } catch { /* already gone */ }
      }
    }
    if (found === null) {
      try {
        execFileSync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          staleWindowsScript([]),
        ], {
          timeout: 15000, windowsHide: true, stdio: 'ignore', env: powershellEnv(),
        });
      } catch { /* best effort */ }
    }
  } else {
    try {
      const out = execFileSync('ps', ['-eo', 'pid=,args='], {
        encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
      });
      for (const line of String(out || '').split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s+(.+)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        if (pid === process.pid || !PROFILE_MARKER.test(m[2])) continue;
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    } catch { /* best effort */ }
  }
  for (const dir of [...profiles]) cleanupProfile(dir);
  cleanupInactiveProfiles();
}

/**
 * Run a short command such as `--version` with a hard timeout.
 * Resolves with `{ code, stdout, stderr, timedOut }`; spawn errors are returned
 * as `{ error }` so detection can show a useful message instead of throwing.
 */
function runCaptured(bin, args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const profile = createProfile();
    let child = null;
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let timer = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanupProfile(profile);
      resolve(value);
    };

    try {
      child = spawnOffice(bin, profile, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      cleanupProfile(profile);
      resolve({ error: e });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finish({ timedOut: true, code: null, stdout, stderr });
    }, Math.max(250, timeoutMs));
    if (timer && typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', (d) => { stdout = (stdout + d.toString()).slice(-64 * 1024); });
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-64 * 1024); });
    child.on('error', (e) => finish({ error: e }));
    child.on('close', (code) => {
      if (!timedOut) finish({ code, stdout, stderr, timedOut: false });
    });
  });
}

module.exports = {
  createProfile,
  cleanupProfile,
  spawnOffice,
  baseArgs,
  killStale,
  killTrackedSync,
  shutdownSync,
  runCaptured,
  profileRoot: PROFILE_ROOT,
};
