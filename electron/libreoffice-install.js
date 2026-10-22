'use strict';

/**
 * LibreOffice automatic installer for Windows.
 *
 * The flow is deliberately conservative:
 *
 *  1. Resolve the newest official stable release from the Document Foundation
 *     mirror and locate the correct MSI for the operating system architecture.
 *  2. Download it with byte-level progress, following mirror redirects.
 *  3. Reject HTML pages, truncated files, non-MSI files and installers whose
 *     Authenticode signature is not valid and not published by The Document
 *     Foundation.
 *  4. If a previous LibreOffice product was selected for clean reinstall,
 *     uninstall those MSI product codes.
 *  5. Run one elevated, silent MSI installation. Windows shows the normal UAC
 *     consent prompt; the installer itself never opens a wizard.
 *
 * Only Windows has an automatic installation path. macOS and Linux use the
 * official download page because their package formats and privilege models
 * differ.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { Transform, pipeline } = require('stream');

const IS_WIN = process.platform === 'win32';
const STABLE_ROOT = 'https://download.documentfoundation.org/libreoffice/stable/';
const MIN_MSI_BYTES = 80 * 1024 * 1024;
const INSTALL_HEADROOM = 1500 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 20 * 60 * 1000;
const USER_AGENT = 'MorphEra/1.0.0 (Windows)';
const MSI_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const LOG_DIR = path.join(os.tmpdir(), 'MorphEra', 'lo-install-logs');

/**
 * Windows PowerShell inherits PSModulePath when MorphEra is launched from a
 * PowerShell 7 session. That can make Windows PowerShell 5.1 try to load
 * incompatible PowerShell 7 modules (notably Microsoft.PowerShell.Security).
 * Give it the standard Windows module path instead.
 */
function powershellEnv(extra = {}) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  return {
    ...process.env,
    PSModulePath: [
      path.join(root, 'system32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      path.join(programFiles, 'WindowsPowerShell', 'Modules'),
    ].join(';'),
    ...extra,
  };
}

let activeToken = null;
let latestCache = null;

/* ------------------------------------------------------------------ errors */

function cancelledError(message = 'LibreOffice installation was cancelled.') {
  const err = new Error(message);
  err.code = 'MORPH_CANCELLED';
  return err;
}

function isCancelled(err) {
  return !!(err && (err.code === 'MORPH_CANCELLED' || err.name === 'AbortError'));
}

/* -------------------------------------------------------------- networking */

function networkMessage(err) {
  const text = String((err && err.message) || err || '');
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return 'Could not reach the LibreOffice download server. Check your internet connection and try again.';
  if (/ETIMEDOUT|timeout|timed out/i.test(text)) return 'The download server took too long to respond. Check your internet connection and try again.';
  if (/ECONNRESET|EPIPE|socket hang up|aborted|premature close/i.test(text)) return 'The download connection closed before the installer finished downloading. Check your internet connection and try again.';
  if (/CERT|TLS|SSL/i.test(text)) return 'The secure connection to the LibreOffice download server could not be verified. Check your system date and network settings, then try again.';
  return text || 'The LibreOffice download failed.';
}

/**
 * GET a URL, following redirects. The resolved response stream is left open
 * for the caller. `token.req` is kept current so cancellation can destroy the
 * active socket even after a redirect.
 */
function requestStream(target, opts = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    const token = opts.token || null;
    if (token && token.cancelled) { reject(cancelledError()); return; }
    if (depth > 8) { reject(new Error('The LibreOffice download redirected too many times.')); return; }

    let parsed;
    try { parsed = new URL(target); } catch { reject(new Error('The LibreOffice download address is invalid.')); return; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error('The LibreOffice download used an unsupported address.'));
      return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    let req;
    let done = false;
    const timer = setTimeout(() => {
      try { req.destroy(new Error('The download server did not respond in time.')); } catch { /* ignore */ }
    }, opts.connectTimeout || 30000);

    const fail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(token && token.cancelled ? cancelledError() : err);
    };

    try {
      req = lib.get(parsed, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/octet-stream,application/x-msi,*/*;q=0.8',
          'Accept-Encoding': 'identity',
          ...(opts.headers || {}),
        },
      }, (res) => {
        if (done) { try { res.resume(); } catch { /* ignore */ } return; }
        const status = Number(res.statusCode || 0);
        if ([301, 302, 303, 307, 308].includes(status)) {
          done = true;
          clearTimeout(timer);
          try { res.resume(); } catch { /* ignore */ }
          const location = res.headers && res.headers.location;
          if (!location) { reject(new Error('The LibreOffice download server sent an incomplete redirect.')); return; }
          let next;
          try { next = new URL(location, parsed).href; } catch { reject(new Error('The LibreOffice download redirect was invalid.')); return; }
          resolve(requestStream(next, opts, depth + 1));
          return;
        }
        done = true;
        clearTimeout(timer);
        if (token) token.req = req;
        resolve({ res, url: parsed, req });
      });
    } catch (e) {
      fail(new Error(networkMessage(e)));
      return;
    }

    if (token) token.req = req;
    req.on('error', (e) => fail(new Error(networkMessage(e))));
    req.setTimeout(opts.idleTimeout || 60000, () => {
      try { req.destroy(new Error('The download stalled. Check your internet connection and try again.')); } catch { /* ignore */ }
    });
  });
}

async function readTextResponse(res, maxBytes = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      total += Buffer.byteLength(chunk);
      if (total > maxBytes) {
        try { res.destroy(); } catch { /* ignore */ }
        reject(new Error('The download server returned an unexpectedly large response.'));
        return;
      }
      text += chunk;
    });
    res.on('end', () => resolve(text));
    res.on('error', (e) => reject(new Error(networkMessage(e))));
  });
}

async function fetchText(url, opts = {}) {
  try {
    const { res } = await requestStream(url, {
      token: opts.token,
      connectTimeout: opts.connectTimeout || 20000,
      idleTimeout: opts.idleTimeout || 30000,
    });
    const status = Number(res.statusCode || 0);
    if (status !== 200) {
      try { res.resume(); } catch { /* ignore */ }
      throw new Error(`The LibreOffice download server returned HTTP ${status}.`);
    }
    const text = await readTextResponse(res, opts.maxBytes);
    if (opts.token && opts.token.cancelled) throw cancelledError();
    return text;
  } catch (e) {
    if (opts.token && opts.token.cancelled) throw cancelledError();
    throw e;
  }
}

/* -------------------------------------------------------------- versioning */

function versionParts(value) {
  return String(value || '').split('.').map((part) => Number(part) || 0);
}

function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

/** Parse the numeric release folders from the official stable mirror index. */
function parseStableVersions(html) {
  const found = new Set();
  const re = /href="(?:\.\/)?(\d+\.\d+\.\d+)\/"/g;
  let match;
  while ((match = re.exec(String(html || '')))) found.add(match[1]);
  return [...found].filter((v) => v.split('.').every((n) => /^\d+$/.test(n))).sort(compareVersions).reverse();
}

function architectureInfo() {
  // LibreOffice calls the 64-bit Windows build x86_64 / x86-64, and the
  // 32-bit build x86. Electron's bundled Node uses ia32 for a 32-bit app.
  if (process.arch === 'ia32') return { folder: 'x86', tag: 'x86' };
  return { folder: 'x86_64', tag: 'x86-64' };
}

function installerName(version, arch) {
  return `LibreOffice_${version}_Win_${arch.tag}.msi`;
}

async function latestStable(opts = {}) {
  if (latestCache && Date.now() - latestCache.at < 30 * 60 * 1000) return latestCache.info;
  const html = await fetchText(STABLE_ROOT, { token: opts.token });
  const versions = parseStableVersions(html);
  if (!versions.length) throw new Error('Could not determine the latest LibreOffice version. Download it manually from libreoffice.org.');

  const arch = architectureInfo();
  for (const version of versions.slice(0, 8)) {
    const listingUrl = `${STABLE_ROOT}${version}/win/${arch.folder}/`;
    try {
      const listing = await fetchText(listingUrl, { token: opts.token });
      const name = installerName(version, arch);
      if (!listing.includes(name)) continue;
      const info = { version, url: listingUrl + name, filename: name, arch: arch.folder, listingUrl };
      latestCache = { at: Date.now(), info };
      return info;
    } catch (e) {
      if (isCancelled(e)) throw e;
      // A release can exist for Linux before Windows packages appear. Try the
      // next newest stable release instead of failing the whole flow.
    }
  }
  throw new Error('LibreOffice is available, but no Windows installer was found on the official mirror. Download it manually from libreoffice.org.');
}

/* ------------------------------------------------------------------- files */

async function freeBytes(dir) {
  try {
    const stats = await fsp.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/**
 * Remove installer folders left behind by a crash or forced app exit. Recent
 * folders are kept: an elevated msiexec started by a previous MorphEra process
 * may still be reading its MSI even though the UI has gone away.
 */
async function cleanupStaleDownloads() {
  const parent = path.join(os.tmpdir(), 'MorphEra');
  let names = [];
  try { names = await fsp.readdir(parent); } catch { return; }
  const cutoff = Date.now() - 60 * 60 * 1000;
  await Promise.all(names
    .filter((name) => /^lo-installer-/i.test(name))
    .map(async (name) => {
      const dir = path.join(parent, name);
      try {
        const stat = await fsp.stat(dir);
        if (stat.mtimeMs > cutoff) return;
      } catch { return; }
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }));
}

function formatGB(bytes) {
  return `${(Number(bytes || 0) / (1024 ** 3)).toFixed(1)} GB`;
}

function isMsiHeader(header) {
  return Buffer.isBuffer(header) && header.length >= 8 && header.subarray(0, 8).equals(MSI_MAGIC);
}

/**
 * Download a file to `dest` and verify its byte count. Progress is reported as
 * raw byte counts; the caller maps that to the UI's overall percentage.
 */
async function downloadFile(url, dest, opts = {}) {
  const token = opts.token || null;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  try { await fsp.rm(part, { force: true }); } catch { /* ignore */ }

  const { res, url: finalUrl } = await requestStream(url, {
    token,
    connectTimeout: 30000,
    idleTimeout: 60000,
  });

  const status = Number(res.statusCode || 0);
  if (status !== 200) {
    try { res.resume(); } catch { /* ignore */ }
    throw new Error(`The LibreOffice installer download returned HTTP ${status}.`);
  }

  const contentType = String((res.headers && res.headers['content-type']) || '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    try { res.destroy(); } catch { /* ignore */ }
    throw new Error('The download server returned a web page instead of the LibreOffice installer. Try again later.');
  }
  const encoding = String((res.headers && res.headers['content-encoding']) || '').toLowerCase();
  if (encoding && encoding !== 'identity') {
    try { res.destroy(); } catch { /* ignore */ }
    throw new Error('The download server used an unsupported compressed response.');
  }

  const total = Number(res.headers && res.headers['content-length']) || 0;
  if (total && opts.minBytes && total < opts.minBytes) {
    try { res.destroy(); } catch { /* ignore */ }
    throw new Error('The LibreOffice installer download was unexpectedly small.');
  }
  if (total && opts.availableBytes != null && opts.availableBytes < total + (opts.reserveBytes || 0)) {
    try { res.destroy(); } catch { /* ignore */ }
    throw new Error(
      `Not enough free disk space. The installer needs ${formatGB(total)} plus about ${formatGB(opts.reserveBytes || 0)} free. ` +
      'Free some space on the drive and try again.',
    );
  }

  let received = 0;
  let lastReport = 0;
  const progress = (force) => {
    if (typeof opts.onProgress !== 'function') return;
    const now = Date.now();
    if (!force && now - lastReport < 220) return;
    lastReport = now;
    try { opts.onProgress({ received, total: total || null }); } catch { /* UI may be gone */ }
  };

  const overallTimer = setTimeout(() => {
    try { if (token && token.req) token.req.destroy(new Error('The LibreOffice download took too long. Check your internet connection and try again.')); } catch { /* ignore */ }
  }, opts.timeout || DOWNLOAD_TIMEOUT);

  try {
    await new Promise((resolve, reject) => {
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          if (token && token.cancelled) { cb(cancelledError()); return; }
          received += chunk.length;
          progress(false);
          cb(null, chunk);
        },
      });
      const out = fs.createWriteStream(part, { flags: 'wx' });
      pipeline(res, meter, out, (err) => {
        if (err) reject(token && token.cancelled ? cancelledError() : new Error(networkMessage(err)));
        else resolve();
      });
    });
    progress(true);

    if (!received) throw new Error('The LibreOffice installer download was empty.');
    if (total && received !== total) {
      throw new Error(`The LibreOffice installer download was incomplete (${formatGB(received)} of ${formatGB(total)}). Check your connection and try again.`);
    }
    if (opts.minBytes && received < opts.minBytes) {
      throw new Error('The LibreOffice installer download was unexpectedly small.');
    }

    try { await fsp.rm(dest, { force: true }); } catch { /* ignore */ }
    await fsp.rename(part, dest);
    return { bytes: received, total: total || received, url: finalUrl.href };
  } finally {
    clearTimeout(overallTimer);
    try { if (fs.existsSync(part)) await fsp.rm(part, { force: true }); } catch { /* ignore */ }
  }
}

/** Check the real file header so an HTML page or random file cannot be run. */
async function validateMsiHeader(file, minBytes = MIN_MSI_BYTES) {
  let stat;
  try { stat = await fsp.stat(file); } catch { throw new Error('The downloaded LibreOffice installer is missing.'); }
  if (!stat.isFile() || stat.size < minBytes) {
    throw new Error('The downloaded LibreOffice installer is incomplete or damaged.');
  }
  const handle = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(8);
    const read = await handle.read(head, 0, 8, 0);
    if (read.bytesRead < 8 || !isMsiHeader(head)) {
      throw new Error('The downloaded file is not a valid Windows installer. Try the download again.');
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return stat.size;
}

/* --------------------------------------------------------- authenticode */

async function verifyAuthenticode(file) {
  if (!IS_WIN) throw new Error('Installer signature verification is only available on Windows.');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop',
    '$sig = Get-AuthenticodeSignature -LiteralPath $env:MORPH_MSI_PATH',
    '[pscustomobject]@{',
    '  Status = [string]$sig.Status',
    '  Subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "" }',
    '  Thumbprint = if ($sig.SignerCertificate) { $sig.SignerCertificate.Thumbprint } else { "" }',
    '} | ConvertTo-Json -Compress',
  ].join('\n');

  const output = await new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], {
      timeout: 90000,
      windowsHide: true,
      maxBuffer: 128 * 1024,
      env: powershellEnv({ MORPH_MSI_PATH: file }),
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message || '').replace(/\s+/g, ' ').trim().slice(-300);
        reject(new Error(`Could not verify the installer signature. ${detail}`.trim()));
        return;
      }
      resolve(String(stdout || ''));
    });
  });

  let parsed = null;
  for (const line of output.split(/\r?\n/)) {
    const text = line.replace(/^\uFEFF/, '').trim();
    if (!text.startsWith('{')) continue;
    try { parsed = JSON.parse(text); break; } catch { /* keep looking */ }
  }
  if (!parsed) throw new Error('Could not read the LibreOffice installer signature.');

  const status = String(parsed.Status || '');
  const subject = String(parsed.Subject || '');
  if (status !== 'Valid') {
    throw new Error(`The LibreOffice installer signature is not valid (${status || 'unknown'}). Download it again from libreoffice.org.`);
  }
  if (!/document foundation/i.test(subject)) {
    throw new Error('The downloaded installer is not signed by The Document Foundation. It was rejected for safety.');
  }
  return { status, subject, thumbprint: parsed.Thumbprint || '' };
}

async function validateInstaller(file, opts = {}) {
  const size = await validateMsiHeader(file, opts.minBytes || MIN_MSI_BYTES);
  if (opts.skipSignature) return { size, signature: null };
  const signature = await verifyAuthenticode(file);
  return { size, signature };
}

/* --------------------------------------------------------- uninstall info */

function normalizeUninstallEntries(value) {
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item) continue;
    const name = String(item.name || item.DisplayName || '').trim();
    if (!/^LibreOffice/i.test(name)) continue;
    const rawCode = String(item.code || item.PSChildName || '');
    const uninstall = String(item.uninstall || item.UninstallString || '');
    const guid = (rawCode.match(/\{[0-9a-f-]{36}\}/i) || uninstall.match(/\{[0-9a-f-]{36}\}/i) || [])[0];
    const code = guid ? guid.toUpperCase() : '';
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({
      name,
      version: String(item.version || item.DisplayVersion || '').trim(),
      code,
    });
  }
  // Help packs and SDKs depend on the main product; remove those first so the
  // main MSI uninstall does not fail with a dependency error.
  const rank = (entry) => (/help|sdk/i.test(entry.name) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

/**
 * Parse `reg query ... /s` output. It is dramatically faster than launching
 * PowerShell, which matters because this runs before the reinstall prompt.
 */
function parseRegUninstall(text) {
  const out = [];
  let current = null;
  const flush = () => {
    if (current && current.name) out.push(current);
    current = null;
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const key = line.match(/^HKEY_[^\\]+\\.+\\Uninstall\\([^\\]+)$/i);
    if (key) {
      flush();
      current = { code: key[1], name: '', version: '', uninstall: '' };
      continue;
    }
    if (!current) continue;
    const value = line.match(/^(DisplayName|DisplayVersion|UninstallString)\s+REG_[A-Z0-9_]+\s+(.*)$/i);
    if (!value) continue;
    const keyName = value[1].toLowerCase();
    if (keyName === 'displayname') current.name = value[2].trim();
    else if (keyName === 'displayversion') current.version = value[2].trim();
    else if (keyName === 'uninstallstring') current.uninstall = value[2].trim();
  }
  flush();
  return out;
}

async function regUninstallEntries() {
  const roots = [
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const parts = await Promise.all(roots.map((root) => new Promise((resolve) => {
    execFile('reg.exe', ['query', root, '/s'], {
      timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
    }, (err, stdout) => {
      // A missing WOW6432Node key returns a non-zero code; other roots still
      // produce useful results.
      resolve(err && !stdout ? null : String(stdout || ''));
    });
  })));
  if (parts.every((part) => part == null)) return null;
  return parts.filter(Boolean).map(parseRegUninstall).flat();
}

async function uninstallEntries() {
  if (!IS_WIN) return [];
  const fast = await regUninstallEntries();
  if (fast) return normalizeUninstallEntries(fast);

  // Fallback for unusual Windows images where reg.exe is unavailable.
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$roots = @(',
    "  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    ')',
    '$items = Get-ItemProperty $roots | Where-Object { $_.DisplayName -and $_.DisplayName -match \'^LibreOffice\' } | ForEach-Object {',
    '  [pscustomobject]@{',
    '    name = [string]$_.DisplayName',
    '    version = [string]$_.DisplayVersion',
    '    code = [string]$_.PSChildName',
    '    uninstall = [string]$_.UninstallString',
    '  }',
    '}',
    'if ($items) { $items | ConvertTo-Json -Compress }',
  ].join('\n');

  const output = await new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], {
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: powershellEnv(),
    }, (err, stdout) => {
      if (err && !stdout) { reject(new Error(`Could not inspect installed LibreOffice products. ${err.message}`)); return; }
      resolve(String(stdout || ''));
    });
  });

  const text = output.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const start = text.search(/[\[{]/);
  if (start < 0) return [];
  try {
    return normalizeUninstallEntries(JSON.parse(text.slice(start)));
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------- elevated */

function psQuote(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function buildInstallScript({ msiPath, codes, installLog, resultPath }) {
  const codeList = (codes || []).filter(Boolean).map((code) => psQuote(code)).join(', ');
  const uninstallLog = `${installLog}.uninstall.log`;
  return [
    "$ErrorActionPreference = 'Stop'",
    '$ErrorActionPreference = "Stop"',
    '$result = [ordered]@{ ok = $false; installCode = $null; error = $null; steps = @() }',
    `$resultPath = ${psQuote(resultPath)}`,
    'function Save-Result {',
    '  try { $result | ConvertTo-Json -Compress -Depth 4 | Set-Content -LiteralPath $resultPath -Encoding UTF8 } catch { }',
    '}',
    'try {',
    '  $msiexec = Join-Path $env:SystemRoot "System32\\msiexec.exe"',
    `  $msi = ${psQuote(msiPath)}`,
    `  $installLog = ${psQuote(installLog)}`,
    `  $uninstallLog = ${psQuote(uninstallLog)}`,
    `  $codes = @(${codeList})`,
    '  foreach ($code in $codes) {',
    '    $p = Start-Process -FilePath $msiexec -ArgumentList @("/x", $code, "/qn", "/norestart", "/l*v", "`"$uninstallLog`"") -Wait -PassThru -WindowStyle Hidden',
    '    $result.steps += [ordered]@{ action = "uninstall"; code = $code; exitCode = $p.ExitCode }',
    '    if ($p.ExitCode -notin @(0, 1605, 3010, 1641)) {',
    '      $result.error = "The existing LibreOffice installation could not be removed (msiexec exit code $($p.ExitCode))."',
    '      Save-Result',
    '      exit 20',
    '    }',
    '  }',
    '  $p = Start-Process -FilePath $msiexec -ArgumentList @("/i", "`"$msi`"", "/qn", "/norestart", "/l*v", "`"$installLog`"") -Wait -PassThru -WindowStyle Hidden',
    '  $result.installCode = $p.ExitCode',
    '  $result.ok = ($p.ExitCode -in @(0, 3010, 1641))',
    '  if (-not $result.ok) { $result.error = "Windows Installer exited with code $($p.ExitCode)." }',
    '  Save-Result',
    '  exit $p.ExitCode',
    '} catch {',
    '  $result.error = $_.Exception.Message',
    '  Save-Result',
    '  exit 30',
    '}',
  ].join('\r\n');
}

function runElevated(innerScript, opts = {}) {
  const encoded = Buffer.from(innerScript, 'utf16le').toString('base64');
  const outer = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand','${encoded}') -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
    '  exit $p.ExitCode',
    '} catch {',
    '  exit 1223',
    '}',
  ].join('\n');

  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', outer,
    ], {
      timeout: opts.timeout || 20 * 60 * 1000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
      env: powershellEnv(),
    }, (err, _stdout, stderr) => {
      if (err) {
        if (err.killed) {
          reject(new Error('LibreOffice installation is taking longer than expected. Check Windows Installer, then try again.'));
          return;
        }
        if (typeof err.code === 'number') { resolve({ code: err.code, stderr: String(stderr || '') }); return; }
        reject(new Error(`Could not start the LibreOffice installer. ${String(stderr || err.message || '').trim()}`.trim()));
        return;
      }
      resolve({ code: 0, stderr: '' });
    });
  });
}

function msiExitMessage(code, extra) {
  const n = Number(code);
  if (extra) return extra;
  if (n === 1223 || n === 1602) return 'Installation was cancelled at the Windows administrator prompt.';
  if (n === 1618) return 'Another Windows Installer operation is already running. Wait for it to finish, then try again.';
  if (n === 1619 || n === 1620) return 'The downloaded installer could not be opened. Download it again.';
  if (n === 1625) return 'Windows policy blocked the installation. Ask your administrator to allow LibreOffice.';
  if (n === 1638) return 'Another version of LibreOffice is already installed. Choose the clean-reinstall option or remove it manually.';
  if (n === 1603) return 'Windows Installer could not install LibreOffice. Check that you have permission to install software and enough free disk space, then try again.';
  if (n === 3010 || n === 1641) return '';
  return `Windows Installer could not install LibreOffice (exit code ${n || 'unknown'}).`;
}

function readResult(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- orchestration */

async function install(opts = {}) {
  if (!IS_WIN) throw new Error('Automatic LibreOffice installation is available on Windows only.');
  if (activeToken) {
    const err = new Error('LibreOffice is already being installed.');
    err.code = 'MORPH_BUSY';
    throw err;
  }

  const token = { cancelled: false, cancellable: true, req: null };
  activeToken = token;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  let lastProgress = 0;
  let tmpDir = '';
  const emit = (payload, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgress < 180) return;
    lastProgress = now;
    try { onProgress({ ...payload, at: now }); } catch { /* renderer may have closed */ }
  };

  try {
    await fsp.mkdir(LOG_DIR, { recursive: true });
    await cleanupStaleDownloads();
    emit({ stage: 'preparing', percent: 1, message: 'Preparing the LibreOffice installer…', cancellable: true }, true);

    const info = await latestStable({ token });
    if (token.cancelled) throw cancelledError();
    emit({
      stage: 'resolving',
      percent: 3,
      message: `Found LibreOffice ${info.version} for ${info.arch === 'x86' ? 'Windows 32-bit' : 'Windows 64-bit'}.`,
      cancellable: true,
      version: info.version,
    }, true);

    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'MorphEra', 'lo-installer-'));
    const msi = path.join(tmpDir, info.filename);
    const available = await freeBytes(tmpDir);
    if (available != null && available < 1024 * 1024 * 1024) {
      throw new Error(`Not enough free disk space (${formatGB(available)} available). LibreOffice needs about 2 GB free on the system drive. Free some space and try again.`);
    }

    let download = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (token.cancelled) throw cancelledError();
      if (attempt) {
        emit({ stage: 'download', percent: 5, message: 'Download interrupted. Retrying from the official mirror…', cancellable: true }, true);
        await new Promise((r) => setTimeout(r, 1200));
      }
      try {
        download = await downloadFile(info.url, msi, {
          token,
          minBytes: MIN_MSI_BYTES,
          availableBytes: available,
          reserveBytes: INSTALL_HEADROOM,
          onProgress: ({ received, total }) => {
            const pct = total ? Math.min(70, 5 + (received / total) * 65) : 5;
            emit({
              stage: 'download',
              percent: pct,
              message: total ? `Downloading LibreOffice ${info.version}…` : `Downloading LibreOffice ${info.version}…`,
              received,
              total: total || null,
              cancellable: true,
              version: info.version,
            });
          },
        });
        break;
      } catch (e) {
        lastError = e;
        if (isCancelled(e) || /HTTP 404|HTTP 403|not a valid Windows installer|signature/i.test(String(e.message || ''))) throw e;
      }
    }
    if (!download) throw lastError || new Error('The LibreOffice installer could not be downloaded.');

    emit({ stage: 'verify', percent: 72, message: 'Verifying the official installer signature…', cancellable: true }, true);
    try {
      await validateInstaller(msi);
    } catch (e) {
      // Never keep a rejected installer around.
      try { await fsp.rm(msi, { force: true }); } catch { /* ignore */ }
      throw e;
    }

    if (token.cancelled) throw cancelledError();
    token.cancellable = false;

    const codes = (Array.isArray(opts.uninstallCodes) ? opts.uninstallCodes : [])
      .map(String)
      .filter((code) => /^\{[0-9a-f-]{36}\}$/i.test(code));
    if (codes.length) {
      emit({ stage: 'uninstall', percent: 76, message: 'Removing the previous LibreOffice installation…', cancellable: false }, true);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const installLog = path.join(LOG_DIR, `install-${stamp}.log`);
    const resultPath = path.join(tmpDir, 'install-result.json');
    const script = buildInstallScript({
      msiPath: msi,
      codes,
      installLog,
      resultPath,
    });

    emit({
      stage: 'install',
      percent: codes.length ? 82 : 78,
      message: 'Installing LibreOffice silently. Approve the Windows administrator prompt if it appears…',
      cancellable: false,
      version: info.version,
    }, true);

    const elevated = await runElevated(script);
    const result = readResult(resultPath);
    const code = result && result.installCode != null ? Number(result.installCode) : Number(elevated.code);
    if (code === 1223 || code === 1602) {
      throw cancelledError('Installation was cancelled at the Windows administrator prompt.');
    }
    if (!(code === 0 || code === 3010 || code === 1641) || (result && result.ok === false)) {
      const message = msiExitMessage(code, result && result.error);
      throw new Error(`${message}${msiExitMessage(code) ? ` The Windows Installer log is at ${installLog}.` : ''}`);
    }

    emit({
      stage: 'complete',
      percent: 100,
      message: code === 3010 || code === 1641 ? 'LibreOffice was installed. Windows recommends a restart.' : 'LibreOffice was installed successfully.',
      cancellable: false,
      version: info.version,
    }, true);
    return {
      version: info.version,
      filename: info.filename,
      bytes: download.bytes,
      uninstalled: codes.length,
      rebootRequired: code === 3010 || code === 1641,
      logPath: installLog,
    };
  } catch (e) {
    if (isCancelled(e)) {
      emit({ stage: 'cancelled', percent: 0, message: 'LibreOffice installation was cancelled.', cancellable: false, error: null }, true);
    } else {
      emit({ stage: 'error', percent: 0, message: String(e && e.message || 'LibreOffice could not be installed.'), cancellable: false, error: String(e && e.message || '') }, true);
    }
    throw e;
  } finally {
    activeToken = null;
    if (tmpDir) {
      try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch { /* logs outside this folder remain */ }
    }
  }
}

function cancel() {
  if (!activeToken || !activeToken.cancellable || activeToken.cancelled) return false;
  activeToken.cancelled = true;
  try {
    if (activeToken.req) activeToken.req.destroy(cancelledError());
  } catch { /* ignore */ }
  return true;
}

function busy() {
  return !!activeToken;
}

module.exports = {
  install,
  cancel,
  busy,
  latestStable,
  uninstallEntries,
  normalizeUninstallEntries,
  parseRegUninstall,
  parseStableVersions,
  compareVersions,
  architectureInfo,
  downloadFile,
  validateMsiHeader,
  validateInstaller,
  isMsiHeader,
  freeBytes,
  cleanupStaleDownloads,
  buildInstallScript,
  msiExitMessage,
  isCancelled,
  LOG_DIR,
};
