'use strict';
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const U = require('../util');
const { norm } = require('../formats');
const { killTree } = require('../proc');

const VIDEO_PROFILES = {
  mp4: { v: 'libx264', a: 'aac', pix: true, movflags: true },
  mov: { v: 'libx264', a: 'aac', pix: true, movflags: true },
  mkv: { v: 'libx264', a: 'aac', pix: true },
  flv: { v: 'libx264', a: 'aac', pix: true },
  avi: { v: 'mpeg4', a: 'libmp3lame', pix: true },
  wmv: { v: 'wmv2', a: 'wmav2' },
  webm: { v: 'libvpx-vp9', a: 'libopus', pix: true },
};

const AUDIO_PROFILES = {
  mp3: { args: ['-c:a', 'libmp3lame'], br: 192, ext: 'mp3' },
  wav: { args: ['-c:a', 'pcm_s16le'], lossless: true, ext: 'wav' },
  flac: { args: ['-c:a', 'flac'], lossless: true, ext: 'flac' },
  aac: { args: ['-c:a', 'aac', '-f', 'adts'], br: 192, ext: 'aac' },
  m4a: { args: ['-c:a', 'aac', '-movflags', '+faststart'], br: 192, ext: 'm4a' },
  ogg: { args: ['-c:a', 'libvorbis'], br: 160, ext: 'ogg' },
  opus: { args: ['-c:a', 'libopus'], br: 128, ext: 'opus' },
  wma: { args: ['-c:a', 'wmav2'], br: 192, ext: 'wma' },
  aiff: { args: ['-c:a', 'pcm_s16be'], lossless: true, ext: 'aiff' },
};

/* ------------------------------------------------------------------ probe */

function probe(file) {
  return new Promise((resolve, reject) => {
    try { if (!fs.statSync(file).isFile()) throw new Error(); } catch {
      reject(new Error('The media file could not be found. It may have been moved or deleted.'));
      return;
    }
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      if (err) reject(err); else resolve(value);
    };
    let child;
    try {
      child = execFile(U.resolveBin('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
        maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 30000,
      }, (err, stdout) => {
        if (err) {
          finish(new Error(err.killed
            ? 'Reading this media file took too long. It may be damaged.'
            : 'Could not read media information. The file may be damaged or unsupported.'));
          return;
        }
        try {
          const j = JSON.parse(stdout);
          const v = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
          const a = (j.streams || []).find((s) => s.codec_type === 'audio');
          let fps = 0;
          if (v && v.avg_frame_rate && v.avg_frame_rate.includes('/')) {
            const [n, d] = v.avg_frame_rate.split('/').map(Number);
            fps = d ? n / d : 0;
          }
          finish(null, {
            duration: parseFloat((j.format && j.format.duration) || (v && v.duration) || (a && a.duration) || 0) || 0,
            size: parseInt((j.format && j.format.size) || 0, 10) || U.fileSize(file),
            bitrate: parseInt((j.format && j.format.bit_rate) || 0, 10) || 0,
            hasVideo: !!v,
            hasAudio: !!a,
            width: v ? v.width : 0,
            height: v ? v.height : 0,
            fps: fps || 30,
            audioBitrate: a ? parseInt(a.bit_rate || 0, 10) : 0,
            vcodec: v && v.codec_name,
            acodec: a && a.codec_name,
          });
        } catch {
          finish(new Error('Could not read media information. The file may be damaged.'));
        }
      });
    } catch (e) {
      finish(new Error('The media engine could not start. Reinstall MorphEra to restore it.'));
      return;
    }
    child.on('error', () => finish(new Error('The media engine could not start. Reinstall MorphEra to restore it.')));
  });
}

/* ----------------------------------------------------------------- ffmpeg */

function ffmpegError(stderr, code) {
  const text = String(stderr || '').trim();
  if (/No such file or directory/i.test(text)) return 'The input file could not be opened. It may have been moved or deleted.';
  if (/Invalid data found|moov atom not found|corrupt/i.test(text)) return 'This media file could not be read. It may be damaged or incomplete.';
  if (/Unknown encoder|Encoder .* not found|Decoder .* not found/i.test(text)) return 'This format is not supported by the media engine in this build.';
  if (/Permission denied/i.test(text)) return 'MorphEra does not have permission to read the input or write the output.';
  if (/No space left/i.test(text)) return 'The disk is full. Free some space and try again.';
  if (/Output file .* already exists/i.test(text)) return 'The output file is in use. Close it and try again.';
  const tail = text.split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
  return tail ? tail.slice(0, 260) : `The media engine stopped unexpectedly (code ${code}).`;
}

function runFfmpeg(ctx, args, o = {}) {
  return new Promise((resolve, reject) => {
    U.checkAbort(ctx);
    const full = ['-hide_banner', '-loglevel', 'error', ...(o.noProgress ? [] : ['-nostats', '-progress', 'pipe:1']), ...args];
    let child;
    try {
      child = spawn(U.resolveBin('ffmpeg'), full, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      reject(new Error('The media engine could not start. Reinstall MorphEra to restore it.'));
      return;
    }

    let done = false;
    let err = '';
    let buf = '';
    let timer = null;
    const dur = Number(o.duration) || 0;
    const [p0, p1] = Array.isArray(o.range) ? o.range : [0, 1];

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (ctx && ctx.signal) { try { ctx.signal.removeEventListener('abort', onAbort); } catch { /* ignore */ } }
    };
    const finish = (e) => {
      if (done) return;
      done = true;
      cleanup();
      if (e) reject(e); else resolve();
    };
    const onAbort = () => { killTree(child); finish(new U.Cancelled()); };

    if (ctx && ctx.signal) {
      if (ctx.signal.aborted) { reject(new U.Cancelled()); return; }
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Long conversions get a generous, duration-aware ceiling; probing/frame
    // grabs get a short one. This prevents an orphaned encoder holding a job
    // slot forever without cutting off legitimate long videos.
    const timeoutMs = Number(o.timeoutMs) || (dur > 0
      ? Math.max(5 * 60 * 1000, Math.min(6 * 60 * 60 * 1000, dur * 1000 * 6))
      : 30 * 60 * 1000);
    timer = setTimeout(() => {
      killTree(child);
      finish(new Error('The media conversion took too long and was stopped. Try a smaller file or lower quality.'));
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith('out_time_us=') || line.startsWith('out_time_ms=')) {
          const us = parseInt(line.split('=')[1], 10);
          if (dur > 0 && Number.isFinite(us) && us > 0 && ctx && typeof ctx.progress === 'function') {
            const frac = Math.min(1, us / 1e6 / dur);
            ctx.progress(p0 + (p1 - p0) * frac);
          }
        }
      }
    });
    child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-8000); if (process.env.MORPH_DEBUG) process.stderr.write(d); });

    child.on('error', (e) => {
      finish(new Error(e && e.code === 'ENOENT'
        ? 'The media engine is missing. Reinstall MorphEra to restore it.'
        : 'The media engine could not start.'));
    });
    child.on('close', (code, signal) => {
      if (done) return;
      if (ctx && ctx.signal && ctx.signal.aborted) { finish(new U.Cancelled()); return; }
      if (code === 0) { finish(null); return; }
      finish(new Error(ffmpegError(err, signal ? `${signal}` : code)));
    });
  });
}

/* ---------------------------------------------------------------- builders */

function kbps(n) { return `${Math.max(8, Math.round(n))}k`; }

function trimArgs(trim, info) {
  const start = trim && trim.start > 0 ? trim.start : 0;
  let end = trim && trim.end > 0 ? trim.end : 0;
  if (info.duration && end > info.duration) end = 0;
  const total = info.duration || 0;
  const dur = (end || total) - start;
  const pre = start > 0 ? ['-ss', String(start)] : [];
  const post = end > 0 ? ['-t', String(Math.max(0.05, end - start))] : [];
  return { pre, post, dur: dur > 0 ? dur : total, start, end };
}

function audioFilter(opts) {
  const f = [];
  if (opts.volume != null && Math.round(opts.volume) !== 100) f.push(`volume=${(Math.max(0, opts.volume) / 100).toFixed(3)}`);
  return f;
}

function pickHeightForBitrate(info, videoKbps, wantedH) {
  const srcH = info.height || 720;
  const srcW = info.width || 1280;
  const fps = Math.min(info.fps || 30, 60);
  let h = wantedH && wantedH < srcH ? wantedH : srcH;
  const steps = [2160, 1440, 1080, 720, 480, 360, 240, 144].filter((x) => x <= h);
  if (!steps.includes(h)) steps.unshift(h);
  for (const cand of steps) {
    const w = (srcW / srcH) * cand;
    const bpp = (videoKbps * 1000) / (w * cand * fps);
    if (bpp >= 0.045 || cand === steps[steps.length - 1]) return cand;
  }
  return h;
}

async function encodeVideoOnce(ctx, p) {
  const { file, dest, to, info, opts, range, targetKbps } = p;
  const prof = VIDEO_PROFILES[to];
  const trim = trimArgs(opts.trim, info);
  const hasAudio = info.hasAudio && !opts.stripAudio;
  const args = ['-y', ...trim.pre, '-i', file, ...trim.post];
  const vf = [];
  let height = opts.height || 0;
  if (targetKbps) height = pickHeightForBitrate(info, targetKbps - 0, opts.height);
  if (height && info.height && height < info.height) vf.push(`scale=-2:${height}`);
  else vf.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  if (opts.fps && opts.fps < info.fps) vf.push(`fps=${opts.fps}`);
  args.push('-vf', vf.join(','), '-c:v', prof.v);
  if (prof.v === 'libx264') {
    args.push('-preset', opts.preset || 'veryfast');
    if (targetKbps) args.push('-b:v', kbps(targetKbps), '-maxrate', kbps(targetKbps * 1.2), '-bufsize', kbps(targetKbps * 2.4));
    else args.push('-crf', String(opts.crf || 23));
  } else if (prof.v === 'libvpx-vp9') {
    args.push('-row-mt', '1', '-deadline', 'good', '-cpu-used', '4');
    if (targetKbps) args.push('-b:v', kbps(targetKbps), '-maxrate', kbps(targetKbps * 1.2));
    else args.push('-crf', String(opts.crf ? opts.crf + 8 : 32), '-b:v', '0');
  } else if (prof.v === 'mpeg4') {
    if (targetKbps) args.push('-b:v', kbps(targetKbps)); else args.push('-q:v', String(opts.crf ? Math.max(2, Math.round((opts.crf - 10) / 3)) : 4));
  } else {
    args.push('-b:v', kbps(targetKbps || Math.max(1200, (info.bitrate || 3e6) / 1000 * 0.8)));
  }
  if (prof.pix) args.push('-pix_fmt', 'yuv420p');
  if (hasAudio) {
    const abr = opts.audioBitrate || (targetKbps ? 96 : 160);
    args.push('-c:a', prof.a, '-b:a', kbps(abr), '-ac', '2');
    const af = audioFilter(opts);
    if (af.length) args.push('-af', af.join(','));
  } else args.push('-an');
  if (prof.movflags) args.push('-movflags', '+faststart');
  args.push(dest);
  await runFfmpeg(ctx, args, { duration: trim.dur, range });
}

async function encodeAudioOnce(ctx, p) {
  const { file, dest, to, info, opts, range, bitrate } = p;
  const prof = AUDIO_PROFILES[to];
  const trim = trimArgs(opts.trim, info);
  const args = ['-y', ...trim.pre, '-i', file, ...trim.post, '-vn', ...prof.args];
  if (!prof.lossless) {
    const br = bitrate || opts.audioBitrate || prof.br;
    args.push('-b:a', kbps(br));
  }
  const af = audioFilter(opts);
  if (af.length) args.push('-af', af.join(','));
  if (to === 'mp3' || to === 'aac' || to === 'm4a') args.push('-ar', '44100');
  args.push(dest);
  await runFfmpeg(ctx, args, { duration: trim.dur, range });
}

async function encodeGif(ctx, p) {
  const { file, dest, info, opts } = p;
  const trim = trimArgs(opts.trim, info);
  const fps = Math.max(1, Math.min(30, opts.gifFps || opts.fps || 12));
  const width = opts.gifWidth || 480;
  const vf = `fps=${fps},scale='min(${width},iw)':-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`;
  await runFfmpeg(ctx, ['-y', ...trim.pre, '-i', file, ...trim.post, '-an', '-filter_complex', vf.replace(/,split/, ',split'), '-loop', '0', dest], { duration: trim.dur });
}

/* ---------------------------------------------------------------- convert */

async function convertMedia(ctx, params) {
  const { file } = params;
  const to = norm(params.to);
  const opts = params.opts || {};
  ctx.progress(0.02, 'Analyzing');
  const info = await probe(file);
  const isAudioTarget = !!AUDIO_PROFILES[to];
  const isVideoTarget = !!VIDEO_PROFILES[to];
  if (!isAudioTarget && !isVideoTarget && to !== 'gif') throw new Error(`Unsupported target format: ${to}`);
  if (isVideoTarget && !info.hasVideo) throw new Error('This file has no video to convert. Choose an audio format instead.');
  if (!info.hasVideo && !info.hasAudio) throw new Error('No audio or video found in this file.');
  if (to === 'gif' && !info.hasVideo) throw new Error('GIF needs a video source.');

  const sourceExt = norm(U.extOf(file));
  const suffix = sourceExt === to ? ' (converted)' : '';
  const dest = U.outPath(ctx, file, AUDIO_PROFILES[to] ? AUDIO_PROFILES[to].ext : to, { suffix: opts.suffix || suffix });
  const trim = trimArgs(opts.trim, info);
  const dur = trim.dur || info.duration || 1;
  const target = opts.targetBytes || 0;
  const limit = opts.maxBytes || 0;

  try {
    if (to === 'gif') {
      ctx.progress(0.05, 'Creating GIF');
      await encodeGif(ctx, { file, dest, info, opts });
    } else if (isAudioTarget) {
      const prof = AUDIO_PROFILES[to];
      let bitrate = 0;
      const wantsTarget = (target || 0) > 0 && !prof.lossless;
      if (wantsTarget) bitrate = Math.max(16, Math.min(320, (target * 8 * 0.97) / 1000 / dur));
      ctx.progress(0.05, 'Converting audio');
      await encodeAudioOnce(ctx, { file, dest, to, info, opts, range: [0.05, 0.95], bitrate });
      if (!wantsTarget && limit && U.fileSize(dest) > limit && !prof.lossless) {
        const br = Math.max(16, Math.min(320, (limit * 8 * 0.95) / 1000 / dur));
        await encodeAudioOnce(ctx, { file, dest, to, info, opts, range: [0.5, 0.95], bitrate: br });
      }
    } else {
      ctx.progress(0.05, 'Converting video');
      const hasAud = info.hasAudio && !opts.stripAudio;
      const plan = (bytes, factor) => {
        const totalKbps = (bytes * 8 * factor) / 1000 / dur;
        const wantA = opts.audioBitrate || 96;
        const aud = hasAud ? Math.max(16, Math.min(wantA, totalKbps * 0.25)) : 0;
        return { video: Math.max(20, totalKbps - aud), audio: aud };
      };
      const encode = (pl, range) => encodeVideoOnce(ctx, { file, dest, to, info, opts: { ...opts, audioBitrate: pl.audio || opts.audioBitrate }, range, targetKbps: pl.video });
      const squeeze = async (bytes, startRange) => {
        let f = 0.93;
        await encode(plan(bytes, f), startRange);
        for (let i = 0; i < 3 && U.fileSize(dest) > bytes * (target ? 1.02 : 1); i++) { f *= 0.85; await encode(plan(bytes, f), [0.5, 0.97]); }
      };
      if (target) {
        await squeeze(target, [0.05, 0.95]);
      } else {
        await encode({ video: 0, audio: 0 }, [0.05, 0.95]);
        if (limit && U.fileSize(dest) > limit) await squeeze(limit, [0.5, 0.97]);
      }
    }
  } catch (e) {
    U.rmQuiet(dest);
    throw e;
  }

  const size = U.fileSize(dest);
  if (!size) { U.rmQuiet(dest); throw new Error('The media engine did not produce an output file. Try different settings.'); }
  const wanted = target || limit;
  const note = wanted && size > wanted * 1.05 ? 'Could not reach the exact size without ruining the quality.' : undefined;
  ctx.progress(1, 'Done');
  return { outputs: [dest], note };
}

/* ------------------------------------------------------------------ merge */

async function mergeMedia(ctx, params) {
  const files = Array.isArray(params.files) ? params.files.filter((f) => typeof f === 'string' && f) : [];
  if (files.length < 2) throw new Error('Add at least two files to merge.');
  if (files.length > 60) throw new Error('Merge up to 60 clips at a time.');
  const to = norm(params.to || 'mp4');
  const infos = [];
  for (const f of files) {
    try { infos.push(await probe(f)); }
    catch (e) { throw new Error(`${f.split(/[\\/]/).pop()}: ${(e && e.message) || 'this clip could not be read.'}`); }
  }
  if (!infos.some((i) => i.hasVideo || i.hasAudio)) throw new Error('These files contain no audio or video.');
  const audioOnly = infos.every((i) => !i.hasVideo);
  const total = infos.reduce((a, i) => a + (i.duration || 0), 0) || 1;
  const dest = U.outPath(ctx, files[0], audioOnly ? (AUDIO_PROFILES[to] ? AUDIO_PROFILES[to].ext : 'mp3') : (VIDEO_PROFILES[to] ? to : 'mp4'), { base: 'Merged', suffix: '' });
  const args = ['-y'];
  files.forEach((f) => args.push('-i', f));
  const fc = [];
  let nextInput = files.length;
  const first = infos.find((i) => i.hasVideo);
  const W = first ? Math.max(2, Math.round((first.width || 1280) / 2) * 2) : 0;
  const H = first ? Math.max(2, Math.round((first.height || 720) / 2) * 2) : 0;
  const parts = [];
  infos.forEach((info, i) => {
    if (!audioOnly) {
      if (info.hasVideo) fc.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`);
      else fc.push(`color=c=black:s=${W}x${H}:d=${(info.duration || 1).toFixed(3)}:r=30,format=yuv420p[v${i}]`);
    }
    if (info.hasAudio) fc.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    else {
      args.push('-f', 'lavfi', '-t', String((info.duration || 1).toFixed(3)), '-i', 'anullsrc=r=44100:cl=stereo');
      fc.push(`[${nextInput}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      nextInput++;
    }
    parts.push(audioOnly ? `[a${i}]` : `[v${i}][a${i}]`);
  });
  fc.push(`${parts.join('')}concat=n=${files.length}:v=${audioOnly ? 0 : 1}:a=1${audioOnly ? '' : '[v]'}[a]`);
  args.push('-filter_complex', fc.join(';'));
  if (audioOnly) {
    const prof = AUDIO_PROFILES[to] || AUDIO_PROFILES.mp3;
    args.push('-map', '[a]', ...prof.args);
    if (!prof.lossless) args.push('-b:a', kbps(prof.br));
  } else {
    const vp = VIDEO_PROFILES[to] || VIDEO_PROFILES.mp4;
    args.push('-map', '[v]', '-map', '[a]', '-c:v', vp.v);
    if (vp.v === 'libx264') args.push('-preset', 'veryfast', '-crf', '23');
    else if (vp.v === 'libvpx-vp9') args.push('-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4');
    else if (vp.v === 'mpeg4') args.push('-q:v', '4');
    else args.push('-b:v', '2500k');
    args.push('-c:a', vp.a, '-b:a', '160k');
    if (vp.movflags) args.push('-movflags', '+faststart');
  }
  args.push(dest);
  ctx.progress(0.03, 'Merging');
  try {
    await runFfmpeg(ctx, args, { duration: total, range: [0.03, 0.98] });
  } catch (e) { U.rmQuiet(dest); throw e; }
  if (!U.fileSize(dest)) { U.rmQuiet(dest); throw new Error('The clips could not be merged. Make sure they all contain audio or video.'); }
  ctx.progress(1, 'Done');
  return { outputs: [dest] };
}

module.exports = { probe, runFfmpeg, convertMedia, mergeMedia, VIDEO_PROFILES, AUDIO_PROFILES };
