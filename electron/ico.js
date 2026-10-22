'use strict';
// Minimal ICO writer: PNG-compressed entries (supported by Windows Vista and later).
function encodeICO(pngs, sizes) {
  const n = pngs.length;
  const head = Buffer.alloc(6 + 16 * n);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(n, 4);
  let offset = head.length;
  pngs.forEach((png, i) => {
    const s = sizes[i];
    const o = 6 + 16 * i;
    head[o] = s >= 256 ? 0 : s; head[o + 1] = s >= 256 ? 0 : s; head[o + 2] = 0; head[o + 3] = 0;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(png.length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs]);
}
module.exports = { encodeICO };
