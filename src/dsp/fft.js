// Radix-2 FFT (complex) and an n-point real FFT built on an n/2-point complex FFT.
//
// Performance notes (JS has no SIMD; loads/stores and multiplies dominate):
// * The first two DIT stages are fused into twiddle-free radix-4 butterflies.
// * Remaining stages run as radix-2^2 passes (two stages per sweep over memory) using
//   3 complex multiplies per 4 points (w, w^2, w^3) instead of 4. Twiddles for each pass
//   are precomputed contiguously ([w1r, w1i, w2r, w2i, w3r, w3i] per j), no strided reads.
// * RealFFT writes its packed input directly in bit-reversed order (no permutation pass)
//   and folds the inverse 1/n scaling into its pre-processing.
// Everything runs in Float64: a forward+inverse round trip is exact to ~1e-15.

function isPow2(n) {
  return Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0;
}

/**
 * Complex radix-2 FFT of size n (power of two), in place on Float64Array re/im.
 * Forward uses e^{-2πikn/N} (no scaling); inverse is scaled by 1/n.
 */
export class FFT {
  /** @param {number} n power of two >= 1 */
  constructor(n) {
    if (!isPow2(n)) throw new Error(`FFT size must be a power of two, got ${n}`);
    this.n = n;
    let bits = 0;
    while ((1 << bits) < n) bits++;
    const rev = new Int32Array(n); // Int32 (not Uint32): V8 indexes faster with int32 values
    for (let i = 1; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
    this.rev = rev;
    // Pass plan after the fused radix-4 first stage (sizes 2 and 4).
    // If the number of remaining radix-2 stages is odd, one plain radix-2 stage (half=4)
    // runs first; then radix-2^2 passes with half = h, 4h, 16h, ...
    let remaining = Math.max(0, bits - 2);
    this.oddStage = n >= 8 && (remaining & 1) === 1;
    const tw8 = new Float64Array(8);
    for (let j = 0; j < 4; j++) {
      tw8[2 * j] = Math.cos((Math.PI * j) / 4);
      tw8[2 * j + 1] = -Math.sin((Math.PI * j) / 4);
    }
    this.tw8 = tw8;
    const passes = [];
    let half = this.oddStage ? 8 : 4;
    for (; half < n; half <<= 2) {
      // Pass combines stage (half) and stage (2·half). With w = e^{-iπj/(2·half)}:
      // stage-1 twiddle = w^2, stage-2 twiddles = w and -i·w → apply w^2 to x1, w to x2,
      // w^3 to x3 (x1..x3 in bit-reversed DIT order).
      const tw = new Float64Array(6 * half);
      for (let j = 0; j < half; j++) {
        const a = (Math.PI * j) / (2 * half);
        tw[6 * j] = Math.cos(2 * a);
        tw[6 * j + 1] = -Math.sin(2 * a);
        tw[6 * j + 2] = Math.cos(a);
        tw[6 * j + 3] = -Math.sin(a);
        tw[6 * j + 4] = Math.cos(3 * a);
        tw[6 * j + 5] = -Math.sin(3 * a);
      }
      passes.push({ half, tw });
    }
    this.passes = passes;
  }

  /**
   * In-place forward transform.
   * @param {Float64Array} re
   * @param {Float64Array} im
   */
  forward(re, im) {
    this._permute(re, im);
    this._butterflies(re, im);
  }

  /**
   * In-place inverse transform, scaled by 1/n.
   * IFFT(z) = swap(FFT(swap(z))) / n, so the forward kernel is reused.
   * @param {Float64Array} re
   * @param {Float64Array} im
   */
  inverse(re, im) {
    this._permute(im, re);
    this._butterflies(im, re);
    const n = this.n;
    const s = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }

  _permute(re, im) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
  }

  /** Butterflies on bit-reversed input. */
  _butterflies(re, im) {
    const n = this.n;
    if (n === 1) return;
    if (n === 2) {
      const ar = re[0], ai = im[0], br = re[1], bi = im[1];
      re[0] = ar + br; im[0] = ai + bi;
      re[1] = ar - br; im[1] = ai - bi;
      return;
    }
    // Fused stages 1+2 (sizes 2 and 4): twiddles are 1 and -i.
    for (let i = 0; i < n; i += 4) {
      const r0 = re[i], i0 = im[i], r1 = re[i + 1], i1 = im[i + 1];
      const r2 = re[i + 2], i2 = im[i + 2], r3 = re[i + 3], i3 = im[i + 3];
      const ar = r0 + r1, ai = i0 + i1, br = r0 - r1, bi = i0 - i1;
      const cr = r2 + r3, ci = i2 + i3, dr = r2 - r3, di = i2 - i3;
      re[i] = ar + cr; im[i] = ai + ci;
      re[i + 2] = ar - cr; im[i + 2] = ai - ci;
      re[i + 1] = br + di; im[i + 1] = bi - dr;
      re[i + 3] = br - di; im[i + 3] = bi + dr;
    }
    if (this.oddStage) {
      const tw = this.tw8;
      for (let start = 0; start < n; start += 8) {
        for (let j = 0; j < 4; j++) {
          const a = start + j;
          const b = a + 4;
          const wr = tw[2 * j], wi = tw[2 * j + 1];
          const xr = re[b], xi = im[b];
          const tr = xr * wr - xi * wi;
          const ti = xr * wi + xi * wr;
          const ur = re[a], ui = im[a];
          re[a] = ur + tr; im[a] = ui + ti;
          re[b] = ur - tr; im[b] = ui - ti;
        }
      }
    }
    const passes = this.passes;
    for (let p = 0; p < passes.length; p++) {
      const half = passes[p].half;
      const tw = passes[p].tw;
      const size = half << 2;
      for (let start = 0; start < n; start += size) {
        for (let j = 0, t = 0; j < half; j++, t += 6) {
          const i0 = start + j, i1 = i0 + half, i2 = i1 + half, i3 = i2 + half;
          const w1r = tw[t], w1i = tw[t + 1], w2r = tw[t + 2], w2i = tw[t + 3];
          const w3r = tw[t + 4], w3i = tw[t + 5];
          let xr = re[i1], xi = im[i1];
          const br = xr * w1r - xi * w1i, bi = xr * w1i + xi * w1r;
          xr = re[i2]; xi = im[i2];
          const cr = xr * w2r - xi * w2i, ci = xr * w2i + xi * w2r;
          xr = re[i3]; xi = im[i3];
          const dr = xr * w3r - xi * w3i, di = xr * w3i + xi * w3r;
          const ar = re[i0], ai = im[i0];
          const s0r = ar + br, s0i = ai + bi, s1r = ar - br, s1i = ai - bi;
          const t0r = cr + dr, t0i = ci + di, t1r = cr - dr, t1i = ci - di;
          re[i0] = s0r + t0r; im[i0] = s0i + t0i;
          re[i2] = s0r - t0r; im[i2] = s0i - t0i;
          // s1 - i·t1 and s1 + i·t1
          re[i1] = s1r + t1i; im[i1] = s1i - t1r;
          re[i3] = s1r - t1i; im[i3] = s1i + t1r;
        }
      }
    }
  }
}

/**
 * n-point real FFT computed with one n/2-point complex FFT (even/odd packing).
 * Spectrum layout: bins 0..n/2 (n/2 + 1 values), unscaled forward, 1/n-scaled inverse,
 * so inverse(forward(x)) reproduces x (≈1e-15).
 */
export class RealFFT {
  /** @param {number} n power of two >= 2 */
  constructor(n) {
    if (!isPow2(n) || n < 2) throw new Error(`RealFFT size must be a power of two >= 2, got ${n}`);
    this.n = n;
    const m = n >> 1;
    this.m = m;
    this.fft = new FFT(m);
    this.rev = this.fft.rev;
    this.zr = new Float64Array(m);
    this.zi = new Float64Array(m);
    const h = (m >> 1) + 1;
    this.cs = new Float64Array(h);
    this.sn = new Float64Array(h);
    for (let k = 0; k < h; k++) {
      const a = (2 * Math.PI * k) / n;
      this.cs[k] = Math.cos(a);
      this.sn[k] = Math.sin(a);
    }
  }

  /**
   * @param {Float64Array|Float32Array} input length n
   * @param {Float64Array} outRe length >= n/2 + 1
   * @param {Float64Array} outIm length >= n/2 + 1
   */
  forward(input, outRe, outIm) {
    const m = this.m, zr = this.zr, zi = this.zi, rev = this.rev;
    for (let k = 0, j = 0; k < m; k++, j += 2) {
      const r = rev[k];
      zr[r] = input[j];
      zi[r] = input[j + 1];
    }
    this.fft._butterflies(zr, zi);
    const cs = this.cs, sn = this.sn;
    outRe[0] = zr[0] + zi[0];
    outIm[0] = 0;
    outRe[m] = zr[0] - zi[0];
    outIm[m] = 0;
    const hm = m >> 1;
    for (let k = 1; k <= hm; k++) {
      const mk = m - k;
      const a = zr[k], b = zi[k], c = zr[mk], d = zi[mk];
      // E = (Z[k] + conj Z[m-k])/2, O = (Z[k] - conj Z[m-k])/(2i), X[k] = E + W^k·O
      const er = 0.5 * (a + c), ei = 0.5 * (b - d);
      const or = 0.5 * (b + d), oi = 0.5 * (c - a);
      const co = cs[k], si = sn[k];
      const tr = or * co + oi * si;
      const ti = oi * co - or * si;
      outRe[k] = er + tr;
      outIm[k] = ei + ti;
      outRe[mk] = er - tr;
      outIm[mk] = ti - ei;
    }
  }

  /**
   * @param {Float64Array} inRe bins 0..n/2 (imag of DC/Nyquist ignored)
   * @param {Float64Array} inIm
   * @param {Float64Array|Float32Array} output length n
   */
  inverse(inRe, inIm, output) {
    const m = this.m, zr = this.zr, zi = this.zi, rev = this.rev;
    const cs = this.cs, sn = this.sn;
    const h = 0.5 / m; // folds the 1/m inverse scaling into the 1/2 of the unpacking
    const x0 = inRe[0], xm = inRe[m];
    zr[0] = h * (x0 + xm);
    zi[0] = h * (x0 - xm);
    const hm = m >> 1;
    for (let k = 1; k <= hm; k++) {
      const mk = m - k;
      const a = inRe[k], b = inIm[k], c = inRe[mk], d = inIm[mk];
      const er = h * (a + c), ei = h * (b - d);
      const dr = a - c, di = b + d;
      const co = cs[k], si = sn[k];
      const or = h * (dr * co - di * si);
      const oi = h * (dr * si + di * co);
      const rk = rev[k], rmk = rev[mk];
      zr[rk] = er - oi;
      zi[rk] = ei + or;
      zr[rmk] = er + oi;
      zi[rmk] = or - ei;
    }
    // Inverse complex FFT via the swap identity (input already bit-reversed).
    this.fft._butterflies(zi, zr);
    for (let k = 0, j = 0; k < m; k++, j += 2) {
      output[j] = zr[k];
      output[j + 1] = zi[k];
    }
  }
}

/**
 * Hann window. periodic=true (DFT-even, for STFT/COLA) uses N = n, otherwise N = n - 1.
 * @param {number} n
 * @param {boolean} [periodic=true]
 * @returns {Float64Array}
 */
export function hann(n, periodic = true) {
  const w = new Float64Array(Math.max(0, n | 0));
  if (w.length === 1) {
    w[0] = 1;
    return w;
  }
  const N = periodic ? w.length : w.length - 1;
  for (let i = 0; i < w.length; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  return w;
}
