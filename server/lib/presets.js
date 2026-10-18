'use strict';
// خيارات الضغط والحجم المتوقع. نفس النموذج الرياضي يُستخدم لعرض الأحجام وللتشفير الفعلي.

const TIERS = [2160, 1440, 1080, 720, 480, 360, 240];

// bits-per-pixel لمحتوى الأنمي (ألوان مسطحة = ضغط ممتاز). HEVC أكفأ بحوالي 35%.
const BPP = { h264: 0.062, hevc: 0.040 };
const MIN_KBPS = { h264: 220, hevc: 150 };
const AUDIO_KBPS = 128;

function tierBitrateKbps(codec, w, h, fps) {
  const pps = w * h * fps;
  const smallBoost = Math.pow(1080 / Math.max(h, 240), 0.18); // الإطارات الصغيرة تحتاج bits أكثر لكل بكسل
  const kbps = (pps * BPP[codec] * smallBoost) / 1000;
  return Math.max(MIN_KBPS[codec], Math.round(kbps));
}

function crfFor(codec, h) {
  const base = h >= 2160 ? 24 : h >= 1440 ? 23 : h >= 1080 ? 22 : h >= 720 ? 21 : 20;
  return codec === 'hevc' ? base + 3 : base;
}

function evenInt(n) { return Math.max(2, Math.round(n / 2) * 2); }

function fpsLabel(f) {
  const r = Math.round(f);
  return Math.abs(f - r) < 0.06 ? String(r) : f.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

// probe: ناتج ffmpeg.probe  |  sizeBytes: حجم الملف الأصلي
function buildOptions(probe, sizeBytes) {
  const v = probe.video;
  const srcH = v.height;
  const srcW = v.width;
  const srcFps = v.fps > 0 ? v.fps : 30;
  const dur = probe.duration;
  const origBitrate = sizeBytes > 0 && dur > 0 ? (sizeBytes * 8) / dur / 1000 : probe.bitrateKbps || 0; // kbps إجمالي

  // الصوت: AAC بجودة جيدة؛ نُبقي صوت AAC الأصلي إن كان ≤ 160kbps كما هو.
  const a = probe.audio;
  let audioKbps = 0;
  let audioCopy = false;
  if (a) {
    if (a.codec === 'aac' && a.bitrateKbps && a.bitrateKbps <= 160 && a.channels <= 2) {
      audioCopy = true;
      audioKbps = a.bitrateKbps;
    } else {
      audioKbps = a.channels <= 1 ? 96 : AUDIO_KBPS;
    }
  }
  const origVideoKbps = v.bitrateKbps || Math.max(0, origBitrate - (a ? a.bitrateKbps || AUDIO_KBPS : 0));

  // سلالم الدقة: كل الدرجات ≤ دقة المصدر + دقة المصدر نفسها
  const heights = [];
  const stdAtOrBelow = TIERS.filter((t) => t <= srcH * 1.02);
  if (!stdAtOrBelow.includes(srcH) && !TIERS.some((t) => Math.abs(t - srcH) <= 8)) heights.push(srcH);
  for (const t of stdAtOrBelow) heights.push(t);
  const heightsUnique = Array.from(new Set(heights)).sort((x, y) => y - x);

  // خيارات الإطارات: المصدر (بحد أقصى 60) + 30 إذا كان المصدر أعلى بوضوح
  const fpsList = [];
  const topFps = srcFps > 60.5 ? 60 : srcFps;
  fpsList.push(topFps);
  if (topFps > 31) fpsList.push(30);

  const out = [];
  for (const h of heightsUnique) {
    for (const fps of fpsList) {
      for (const codec of ['h264', 'hevc']) {
        const w = evenInt((srcW / srcH) * h);
        const heightOut = h === srcH ? srcH : h;
        const widthOut = h === srcH ? srcW : w;
        let vk = tierBitrateKbps(codec, widthOut, heightOut, fps);
        // لا فائدة من تجاوز معدل بيانات المصدر نفسه
        let capped = false;
        if (origVideoKbps && vk > origVideoKbps * 0.92) { vk = Math.max(MIN_KBPS[codec], Math.round(origVideoKbps * 0.92)); capped = true; }
        const totalKbps = vk + audioKbps;
        const est = Math.round((totalKbps * 1000 / 8) * dur * 1.012);
        const gain = sizeBytes > 0 ? 1 - est / sizeBytes : 0;
        out.push({
          height: heightOut,
          width: widthOut,
          fps,
          fpsLabel: fpsLabel(fps),
          codec,
          videoKbps: vk,
          audioKbps,
          estBytes: est,
          savingPct: Math.round(gain * 100),
          noGain: sizeBytes > 0 && est >= sizeBytes * 0.97, // لن يصغّر
          capped,
          scale: heightOut < srcH,
          fpsChange: fps < srcFps - 0.6,
        });
      }
    }
  }
  return {
    original: {
      width: srcW,
      height: srcH,
      fps: srcFps,
      fpsLabel: fpsLabel(srcFps),
      codec: v.codec,
      sizeBytes: sizeBytes || 0,
      duration: dur,
      totalKbps: Math.round(origBitrate),
    },
    audioKbps,
    audioCopy,
    hdr: !!probe.hdr,
    options: out,
  };
}

// يعيد خيارًا واحدًا (نفس تعريف الواجهة) كما سيُشفَّر فعليًا، مع التحقق من القيم.
function resolveOption(built, req) {
  const h = Number(req.height);
  const fps = Number(req.fps);
  const codec = req.codec === 'hevc' ? 'hevc' : 'h264';
  let best = null;
  for (const o of built.options) {
    if (o.codec !== codec) continue;
    if (o.height === h && Math.abs(o.fps - fps) < 0.01) { best = o; break; }
  }
  return best;
}

module.exports = { buildOptions, resolveOption, crfFor, tierBitrateKbps, evenInt, AUDIO_KBPS };
