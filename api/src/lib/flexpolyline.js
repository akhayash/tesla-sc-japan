// Decoder for HERE flexible polyline (https://github.com/heremaps/flexible-polyline, MIT).
const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const DECODE = new Map([...TABLE].map((c, i) => [c, i]));

function* varints(str) {
  let value = 0;
  let mult = 1;
  for (const ch of str) {
    const v = DECODE.get(ch);
    if (v === undefined) throw new Error(`invalid polyline char ${ch}`);
    value += (v & 0x1f) * mult;
    if (v & 0x20) {
      mult *= 32;
    } else {
      yield value;
      value = 0;
      mult = 1;
    }
  }
  if (mult !== 1) throw new Error('truncated polyline');
}

const signed = (v) => (v % 2 === 1 ? -(v + 1) / 2 : v / 2);

/** Returns [[lat, lng], ...] (third dimension, if any, is dropped). */
export function decodeFlexPolyline(str) {
  const it = varints(str);
  const version = it.next().value;
  if (version !== 1) throw new Error(`unsupported polyline version ${version}`);
  const header = it.next().value;
  const factor = 10 ** (header & 15);
  const thirdDim = (header >> 4) & 7;
  const out = [];
  let lat = 0;
  let lng = 0;
  for (;;) {
    const a = it.next();
    if (a.done) break;
    lat += signed(a.value);
    lng += signed(it.next().value);
    if (thirdDim) it.next();
    out.push([lat / factor, lng / factor]);
  }
  return out;
}
