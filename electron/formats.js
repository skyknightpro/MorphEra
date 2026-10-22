'use strict';
// Single source of truth for supported formats. The UI reads this through IPC.

const IMAGE_IN = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'ico', 'heic', 'heif', 'avif', 'svg'];
const VIDEO_IN = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp', 'ts'];
const AUDIO_IN = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff', 'aif'];
const DOC_IN = ['pdf', 'docx', 'doc', 'odt', 'rtf', 'txt', 'html', 'htm', 'xlsx', 'xls', 'ods', 'csv', 'pptx', 'ppt', 'odp'];

const IMAGE_OUT = ['jpg', 'png', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico', 'pdf'];
const VIDEO_OUT = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'gif'];
const AUDIO_OUT = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus'];
const VIDEO_TO_AUDIO = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus'];

const norm = (e) => {
  e = String(e || '').toLowerCase().replace(/^\./, '');
  if (e === 'jpeg') return 'jpg';
  if (e === 'tif') return 'tiff';
  if (e === 'heif') return 'heic';
  if (e === 'htm') return 'html';
  if (e === 'aif') return 'aiff';
  if (e === 'mpeg') return 'mpg';
  return e;
};

function categoryOf(ext) {
  ext = norm(ext);
  if (IMAGE_IN.map(norm).includes(ext)) return 'image';
  if (VIDEO_IN.map(norm).includes(ext)) return 'video';
  if (AUDIO_IN.map(norm).includes(ext)) return 'audio';
  if (DOC_IN.map(norm).includes(ext)) return 'document';
  return null;
}

// Conversions that require LibreOffice. The app blocks document work until it is installed.
const NEEDS_OFFICE = new Set([
  'doc>pdf', 'doc>docx', 'doc>txt', 'odt>pdf', 'odt>docx', 'odt>txt', 'rtf>pdf', 'rtf>docx', 'rtf>txt',
  'pptx>pdf', 'ppt>pdf', 'odp>pdf', 'pptx>png', 'pptx>jpg', 'html>docx', 'ods>pdf', 'ods>csv', 'ods>xlsx', 'xls>pdf',
]);

function targetsFor(ext) {
  ext = norm(ext);
  const cat = categoryOf(ext);
  let list = [];
  switch (cat) {
    case 'image':
      list = IMAGE_OUT.filter((t) => t !== ext);
      if (ext === 'gif') list = list.concat(['mp4', 'webm']);
      break;
    case 'video':
      list = VIDEO_OUT.filter((t) => t !== ext).concat(VIDEO_TO_AUDIO);
      break;
    case 'audio':
      list = AUDIO_OUT.filter((t) => t !== ext);
      break;
    case 'document':
      switch (ext) {
        case 'pdf': list = ['docx', 'txt', 'html', 'png', 'jpg']; break;
        case 'docx': list = ['pdf', 'txt', 'html']; break;
        case 'doc': case 'odt': case 'rtf': list = ['pdf', 'docx', 'txt']; break;
        case 'txt': list = ['pdf', 'docx', 'html']; break;
        case 'html': list = ['pdf', 'txt', 'docx']; break;
        case 'xlsx': case 'xls': case 'ods': list = ['csv', 'pdf', 'html'].concat(ext === 'xlsx' ? [] : ['xlsx']); break;
        case 'csv': list = ['xlsx', 'pdf', 'html']; break;
        case 'pptx': case 'ppt': case 'odp': list = ['pdf', 'png', 'jpg']; break;
        default: list = ['pdf'];
      }
      break;
    default:
      list = [];
  }
  return list.map((t) => ({ ext: t, office: NEEDS_OFFICE.has(`${ext}>${t}`) }));
}

// Most common first (used for the smart suggestion chips).
const SUGGEST = {
  jpg: ['png', 'webp', 'pdf'], png: ['jpg', 'webp', 'pdf'], webp: ['jpg', 'png', 'pdf'], heic: ['jpg', 'png', 'pdf'],
  avif: ['jpg', 'png', 'webp'], bmp: ['png', 'jpg', 'webp'], tiff: ['jpg', 'png', 'pdf'], gif: ['mp4', 'png', 'webp'],
  ico: ['png', 'jpg', 'webp'], svg: ['png', 'jpg', 'pdf'],
  mp4: ['mp3', 'mkv', 'webm', 'gif'], mkv: ['mp4', 'mp3', 'webm'], avi: ['mp4', 'mkv', 'mp3'], mov: ['mp4', 'mp3', 'gif'],
  webm: ['mp4', 'mp3', 'gif'], flv: ['mp4', 'mp3'], wmv: ['mp4', 'mp3'], m4v: ['mp4', 'mp3'], mpg: ['mp4', 'mp3'], '3gp': ['mp4', 'mp3'], ts: ['mp4', 'mkv'],
  mp3: ['wav', 'm4a', 'ogg', 'flac'], wav: ['mp3', 'flac', 'm4a'], flac: ['mp3', 'wav', 'm4a'], aac: ['mp3', 'wav'], ogg: ['mp3', 'wav'],
  m4a: ['mp3', 'wav', 'flac'], wma: ['mp3', 'wav'], opus: ['mp3', 'wav'], aiff: ['mp3', 'wav', 'flac'],
  pdf: ['docx', 'jpg', 'txt'], docx: ['pdf', 'txt', 'html'], doc: ['pdf', 'docx'], odt: ['pdf', 'docx'], rtf: ['pdf', 'docx'],
  txt: ['pdf', 'docx'], html: ['pdf', 'txt'], xlsx: ['csv', 'pdf'], xls: ['xlsx', 'csv', 'pdf'], ods: ['xlsx', 'csv', 'pdf'],
  csv: ['xlsx', 'pdf'], pptx: ['pdf', 'jpg'], ppt: ['pdf', 'jpg'], odp: ['pdf'],
};

const MIME = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml',
  bmp: 'image/bmp', ico: 'image/x-icon', tiff: 'image/tiff', pdf: 'application/pdf',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg',
};

const PRESETS = {
  whatsapp: {
    id: 'whatsapp', label: 'WhatsApp', blurb: 'Small, fast to send. Photos ≤ 1600px, video 720p under 15 MB.',
    image: { to: 'jpg', maxEdge: 1600, quality: 80, maxBytes: 500 * 1024 },
    video: { to: 'mp4', height: 720, crf: 28, audioBitrate: 96, maxBytes: 15 * 1024 * 1024 },
    audio: { to: 'mp3', audioBitrate: 128 },
    pdf: { maxBytes: 15 * 1024 * 1024 },
  },
  email: {
    id: 'email', label: 'Email', blurb: 'Light attachments. Photos ≤ 1280px, PDFs and video squeezed under typical limits.',
    image: { to: 'jpg', maxEdge: 1280, quality: 75, maxBytes: 300 * 1024 },
    video: { to: 'mp4', height: 720, crf: 30, audioBitrate: 96, maxBytes: 20 * 1024 * 1024 },
    audio: { to: 'mp3', audioBitrate: 128 },
    pdf: { maxBytes: 5 * 1024 * 1024 },
  },
  youtube: {
    id: 'youtube', label: 'YouTube', blurb: 'H.264 + AAC MP4 up to 1080p, high quality, ready to upload.',
    image: { to: 'jpg', width: 1280, height: 720, fit: 'cover', quality: 90, maxBytes: 2 * 1024 * 1024 },
    video: { to: 'mp4', height: 1080, crf: 18, audioBitrate: 192 },
    audio: { to: 'mp3', audioBitrate: 320 },
  },
  print: {
    id: 'print', label: 'Print', blurb: 'Lossless 300 DPI images and print-ready PDFs.',
    image: { to: 'png', quality: 100, density: 300 },
    video: null,
    audio: null,
  },
};

module.exports = { norm, categoryOf, targetsFor, SUGGEST, MIME, PRESETS, IMAGE_IN, VIDEO_IN, AUDIO_IN, DOC_IN, NEEDS_OFFICE };
