import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, extend, useThree } from '@react-three/fiber';
import { shaderMaterial } from '@react-three/drei';
import * as THREE from 'three';
import { WISH_T } from './wishTimeline';

/* ---------- 礼物点阵：礼盒星光权重贴图 → 按密度采样成目标点 ---------- */
/* gift_shape.png：alpha=星光采样权重，R 通道=shade(255 丝带 / 56 盒身)，
   由用户提供的红色礼盒图片抠图生成（保留盒身/双竖丝带/金蝴蝶结）。 */
function rasterizeGiftImage(
  img: HTMLImageElement | null,
  count: number,
  worldWidth: number,
  rand: () => number,
): { pos: Float32Array; shade: Float32Array } {
  const pos = new Float32Array(count * 3);
  const shade = new Float32Array(count);
  // 贴图尚未加载完成时降级为一小团散星，避免所有点叠在原点过曝
  if (!img) {
    for (let i = 0; i < count; i += 1) {
      pos[i * 3] = (rand() - 0.5) * 9;
      pos[i * 3 + 1] = (rand() - 0.5) * 9;
      pos[i * 3 + 2] = (rand() - 0.5) * 3;
      shade[i] = 0.22;
    }
    return { pos, shade };
  }
  const w = img.naturalWidth, h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { pos, shade };
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;

  // 轮廓检测：alpha 与四邻域差分越大，越贴近礼盒外轮廓（盒身边缘/丝带边界/蝴蝶结轮廓）。
  // 轮廓点额外加权采样 + 独立亮度等级，让礼盒「外形」一眼可辨而不是一团星云。
  const alphaGrid = new Float32Array(w * h);
  for (let i = 0, o = 3; i < w * h; i += 1, o += 4) {
    alphaGrid[i] = data[o] / 255;
  }

  // 按 alpha 权重建立累积分布，保证丝带/盒身/蝴蝶结的点数比例正确
  const cum: number[] = [], px: number[] = [], py: number[] = [], ps: number[] = [];
  let acc = 0, minX = w, maxX = 0, minY = h, maxY = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const idx = y * w + x;
      const o = idx * 4;
      const a = alphaGrid[idx];
      if (a > 0.02) {
        const gl = x > 0 ? alphaGrid[idx - 1] : 0;
        const gr = x < w - 1 ? alphaGrid[idx + 1] : 0;
        const gu = y > 0 ? alphaGrid[idx - w] : 0;
        const gd = y < h - 1 ? alphaGrid[idx + w] : 0;
        const grad = Math.max(Math.abs(a - gl), Math.abs(a - gr), Math.abs(a - gu), Math.abs(a - gd));
        const edge = THREE.MathUtils.clamp((grad - 0.1) / 0.32, 0, 1);
        acc += a * (1 + edge * 2.4);
        cum.push(acc); px.push(x); py.push(y);
        // shade 分三档：1.0 丝带 / 0.5 轮廓勾边 / 0.22 盒身
        ps.push(data[o] > 200 ? 1 : edge > 0.3 ? 0.5 : 0.22);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (acc <= 0) return { pos, shade };
  const scale = worldWidth / Math.max(1, maxX - minX);
  const ccx = (minX + maxX) / 2, ccy = (minY + maxY) / 2;
  const n = cum.length;

  /* ---- 真三维礼盒：正面 / 顶面 / 右侧面 / 蝴蝶结四个部件在物体空间构建，
     再统一旋转：方位角 32°（右侧面转向镜头）+ 仰角 35°（顶面朝向镜头），
     每个可见面与视线的夹角都落在 30-40°，标准 3/4 立体视角 ---- */
  const BOX_TOP = 108, BOX_R = 346;
  // 蝴蝶结像素：盒顶以上 + 环底重叠区；整体从顶面上立起来（立体蝴蝶结）
  const isBowPx = (x: number, y: number) => y < BOX_TOP || (y < 124 && x >= 190 && x <= 312);
  // 四个独立累积分布：正面 / 蝴蝶结 / 顶面条带（丝带延续到盖子）/ 右缘条带（侧面图案）
  const cumF: number[] = [], pxF: number[] = [], pyF: number[] = [], psF: number[] = [];
  const cumBw: number[] = [], pxBw: number[] = [], pyBw: number[] = [];
  const cumLd: number[] = [], pxLd: number[] = [], psLd: number[] = [];
  const cumSd: number[] = [], pxSd: number[] = [], pySd: number[] = [];
  let accF = 0, accBw = 0, accLd = 0, accSd = 0;
  for (let k = 0; k < n; k += 1) {
    const X = px[k], Y = py[k];
    const A = alphaGrid[Y * w + X];
    if (isBowPx(X, Y)) {
      accBw += A; cumBw.push(accBw); pxBw.push(X); pyBw.push(Y);
    } else {
      accF += A; cumF.push(accF); pxF.push(X); pyF.push(Y); psF.push(ps[k]);
    }
    if (Y >= 112 && Y <= 130 && X >= 122 && X <= BOX_R - 2) {
      accLd += A; cumLd.push(accLd); pxLd.push(X);
      psLd.push(data[(Y * w + X) * 4] > 200 ? 1 : 0.26);
    }
    if (X >= 334 && X <= BOX_R && Y >= 112 && Y <= 248) {
      accSd += A; cumSd.push(accSd); pxSd.push(X); pySd.push(Y);
    }
  }

  const AZ = (32 * Math.PI) / 180;           // 方位角：右侧面转向镜头
  const EL = (35 * Math.PI) / 180;           // 仰角：顶面朝向镜头
  const cA = Math.cos(AZ), sA = Math.sin(AZ);
  const cE = Math.cos(EL), sE = Math.sin(EL);
  const DEPTH = (maxX - minX) * scale * 0.75; // 盒深 ≈ 0.75×盒宽：三围接近正方体
  const YS = 1.3;                             // 纵向整体拉伸：前脸更接近正方形
  const yTop = -(BOX_TOP - ccy) * scale * YS; // 盒顶边相对内容中心的世界 y
  const xRight = (BOX_R - ccx) * scale;       // 盒右棱相对内容中心的世界 x

  // 分层随机采样：progressive stratification 保证覆盖均匀
  const pick = (cumA: number[], total: number, frac: number) => {
    const target = frac * total;
    let lo = 0, hi = cumA.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumA[mid] < target) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  const nFront = Math.floor(count * 0.58);
  const nTop = Math.floor(count * 0.19);
  const nSide = Math.floor(count * 0.13);
  const nBow = count - nFront - nTop - nSide;
  for (let i = 0; i < count; i += 1) {
    let X: number, Y: number, Z: number, sh: number;
    if (i < nFront && accF > 0) {
      // 正面：保持用户喜欢的原有形象
      const k = pick(cumF, accF, (i + rand() * 0.9) / nFront);
      X = (pxF[k] - ccx + (rand() - 0.5) * 0.9) * scale;
      Y = -(pyF[k] - ccy + (rand() - 0.5) * 0.9) * scale * YS;
      Z = (rand() - 0.5) * 0.8;
      sh = psF[k];
    } else if (i < nFront + nTop && accLd > 0) {
      // 顶面：条带图案（丝带延续到盖子上），前后缘勾边
      const k = pick(cumLd, accLd, (i - nFront + rand() * 0.9) / nTop);
      const u = rand();
      X = (pxLd[k] - ccx + (rand() - 0.5) * 0.9) * scale;
      Y = yTop + (rand() - 0.5) * 0.35;
      Z = -u * DEPTH;
      sh = psLd[k] === 1 ? 1 : u < 0.07 || u > 0.93 ? 0.5 : 0.26;
    } else if (i < nFront + nTop + nSide && accSd > 0) {
      // 右侧面：右缘条带图案，从右前棱向后延展；整体调暗(阴影面)，前后缘勾边
      const k = pick(cumSd, accSd, (i - nFront - nTop + rand() * 0.9) / nSide);
      const u = rand();
      X = xRight + (rand() - 0.5) * 0.3;
      Y = -(pySd[k] - ccy + (rand() - 0.5) * 0.9) * scale * YS;
      Z = -u * DEPTH;
      sh = u < 0.06 || u > 0.94 ? 0.5 : 0.14;
    } else if (accBw > 0) {
      // 立体蝴蝶结：立在顶面前 1/3 处，贴图纵向为高度（60° 立起、随高度微微后仰），
      // 厚度抖动让双环有体积感，不再是趴在盖上的一片
      const k = pick(cumBw, accBw, (i - nFront - nTop - nSide + rand() * 0.9) / nBow);
      const h = (BOX_TOP - pyBw[k]) * scale * 0.95;
      const BOW_ANG = Math.PI / 3;               // 与盖面夹角 60°
      const u0 = 0.3 + rand() * 0.06;            // 站位：顶面前 1/3
      X = (pxBw[k] - ccx + (rand() - 0.5) * 0.9) * scale;
      Y = yTop + h * Math.sin(BOW_ANG) + (rand() - 0.5) * 0.2;
      Z = -(u0 * DEPTH + h * Math.cos(BOW_ANG) * 0.55) + (rand() - 0.5) * 0.8;
      sh = 1.15;  // >1 的勾边档：shader 里尺寸加成更大，蝴蝶结更醒目
    } else {
      // 某个分布为空时兜底回平面全集
      const k = pick(cum, acc, (i + rand() * 0.9) / count);
      X = (px[k] - ccx + (rand() - 0.5) * 0.9) * scale;
      Y = -(py[k] - ccy + (rand() - 0.5) * 0.9) * scale;
      Z = (rand() - 0.5) * 0.8;
      sh = ps[k];
    }
    // 统一旋转：先方位角（右侧面入画），再仰角（顶面入画）
    const x1 = X * cA - Z * sA;
    const z1 = X * sA + Z * cA;
    pos[i * 3] = x1;
    pos[i * 3 + 1] = Y * cE - z1 * sE;
    pos[i * 3 + 2] = Y * sE + z1 * cE;
    shade[i] = sh;
  }
  return { pos, shade };
}

type EffectProps = {
  active: boolean;
  position: [number, number, number];
  onComplete?: () => void;
  photoUrl?: string;
};

const clamp01 = (x: number) => THREE.MathUtils.clamp(x, 0, 1);
const SMOOTH = (x: number) => {
  const v = clamp01(x);
  return v * v * (3 - 2 * v);
};
// 线稿生长动画 skill · 原则 3：两端正弦缓入缓出，避免机械匀速
const SINE_EASE = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(x));
const EASE_OUT = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);

/* ------------------------------------------------------------------ */
/* 字体：Great Vibes（弯曲连笔花体英文）+ Long Cang（飘逸中文）          */
/* ------------------------------------------------------------------ */
const fontPromises = new Map<string, Promise<boolean>>();

function loadFont(family: string, url: string) {
  if (!fontPromises.has(family)) {
    fontPromises.set(
      family,
      (async () => {
        try {
          const face = new FontFace(family, `url(${url})`);
          const loaded = await face.load();
          document.fonts.add(loaded);
          return true;
        } catch {
          return false;
        }
      })(),
    );
  }
  return fontPromises.get(family)!;
}

// 页面一加载就开始预取字体：确保首帧文字就用目标字体渲染，
// 杜绝「备用 Georgia → DancingScript」中途切换导致文字形态突变
loadFont('DancingScript', '/fonts/DancingScript.ttf');
loadFont('LongCang', '/fonts/LongCang.ttf');
loadFont('CormorantItalic', '/fonts/CormorantItalic.woff2');
loadFont('LiuJianMaoCao', '/fonts/LiuJianMaoCao.woff2');
loadFont('ZCOOLKuaiLe', '/fonts/ZCOOLKuaiLe.woff2');

function useFonts() {
  const [ready, setReady] = useState({ dancingScript: false, longCang: false, cormorant: false, liujian: false, kuaiLe: false, settled: false });
  useEffect(() => {
    let mounted = true;
    Promise.all([
      loadFont('DancingScript', '/fonts/DancingScript.ttf'),
      loadFont('LongCang', '/fonts/LongCang.ttf'),
      loadFont('CormorantItalic', '/fonts/CormorantItalic.woff2'),
      loadFont('LiuJianMaoCao', '/fonts/LiuJianMaoCao.woff2'),
      loadFont('ZCOOLKuaiLe', '/fonts/ZCOOLKuaiLe.woff2'),
    ]).then(([dancingScript, longCang, cormorant, liujian, kuaiLe]) => {
      if (mounted) setReady({ dancingScript, longCang, cormorant, liujian, kuaiLe, settled: true });
    });
    return () => {
      mounted = false;
    };
  }, []);
  return ready;
}

/* ------------------------------------------------------------------ */
/* 与圣诞树同源的发光颗粒材质（additive 柔边圆点）                      */
/* ------------------------------------------------------------------ */
const StarPointsMaterial = shaderMaterial(
  {
    uTime: 0,
    uSize: 40,
    uOpacity: 1,
    uFlash: 0,
    uGiftMix: 0,
    uColor: new THREE.Color('#DFF7FF'),
    uColorMix: 0,
  },
  /* vertex */ `
    uniform float uTime;
    uniform float uSize;
    uniform float uFlash;
    uniform float uGiftMix;
    attribute float aRandom;
    attribute float aHue;
    attribute float aGiftShade;
    varying float vRandom;
    varying float vHue;
    varying float vGiftShade;
    void main() {
      vRandom = aRandom;
      vHue = aHue;
      vGiftShade = aGiftShade;
      vec3 p = position;
      p.y += sin(uTime * 1.1 + aRandom * 24.0) * 0.05;
      p.x += cos(uTime * 0.9 + aRandom * 17.0) * 0.04;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      // 礼物成形时：丝带最大、轮廓勾边次之、盒面保持可见（避免只剩丝带像门框）
      float sizeMod = mix(1.0, 0.78 + vGiftShade * 0.95, uGiftMix);
      gl_PointSize = (uSize * (0.5 + aRandom * 0.9) * (1.0 + uFlash * 1.2) * sizeMod) / -mv.z;
      gl_Position = projectionMatrix * mv;
    }
  `,
  /* fragment */ `
    uniform float uTime;
    uniform vec3 uColor;
    uniform float uOpacity;
    uniform float uFlash;
    uniform float uColorMix;
    uniform float uGiftMix;
    varying float vRandom;
    varying float vHue;
    varying float vGiftShade;

    vec3 hue2rgb(float h) {
      return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    }

    void main() {
      float r = distance(gl_PointCoord, vec2(0.5));
      if (r > 0.5) discard;
      float glow = pow(smoothstep(0.5, 0.0, r), 1.35);
      // 霓虹渐变：粒子携带色相，中心白热、边缘带色 —— 网感发光字的核心
      vec3 rainbow = 0.55 + hue2rgb(vHue) * 0.8;
      vec3 base = mix(uColor * 0.95, rainbow, uColorMix);
      vec3 c = mix(base, vec3(1.0), glow * 0.7 + uFlash * 0.45);
      // 礼物成形时：丝带冷白高亮、轮廓线亮白勾边、盒面压暗 —— 外形清晰可辨
      float ribbon = step(0.9, vGiftShade);
      float edge = step(0.4, vGiftShade) * (1.0 - ribbon);
      float boxDim = mix(1.0, mix(0.60, 0.95, edge), 1.0 - ribbon);
      vec3 giftC = mix(c * boxDim, vec3(1.0), ribbon * 0.85 + edge * 0.5);
      c = mix(c, giftC, uGiftMix);
      float flicker = 0.76 + 0.24 * sin(uTime * 2.1 + vRandom * 31.0);
      float alphaMod = mix(1.0,
        mix(0.85, 1.0, max(ribbon, edge)) * mix(0.72, 1.0, clamp(vGiftShade / 0.22, 0.0, 1.0)),
        uGiftMix);
      gl_FragColor = vec4(c, glow * uOpacity * flicker * alphaMod);
    }
  `,
);
extend({ StarPointsMaterial });

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */
function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function makeTexture(canvas: HTMLCanvasElement) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

type GlyphOptions = {
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
  step: number;
};

/** 把字形栅格化后采样成离散点阵 —— 这就是「星光组成的字」 */
function sampleGlyphPoints(text: string, options: GlyphOptions): Array<[number, number]> {
  const { width, height, fontFamily, step } = options;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];

  let fontSize = options.fontSize;
  ctx.font = `${fontSize}px ${fontFamily}`;
  const measured = ctx.measureText(text).width;
  if (measured > width * 0.9) {
    fontSize = Math.floor(fontSize * ((width * 0.9) / measured));
    ctx.font = `${fontSize}px ${fontFamily}`;
  }
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2);

  const data = ctx.getImageData(0, 0, width, height).data;
  const candidates: Array<[number, number]> = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      // 索引必须是整数：step 若为非整数，直接用 x / y 取下标会得到 undefined 而漏采样
      const px = Math.floor(x);
      const py = Math.floor(y);
      if (data[(py * width + px) * 4 + 3] > 100) candidates.push([px, py]);
    }
  }
  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates;
}

function bboxOf(samples: Array<[number, number]>) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < samples.length; i += 1) {
    const [x, y] = samples[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  };
}

/** 按真实字形包围盒缩放，保证文字铺满目标尺寸且不变形 */
function fitGlyphSamples(
  samples: Array<[number, number]>,
  targetWidth: number,
  targetHeight: number,
) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < samples.length; i += 1) {
    const [x, y] = samples[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  return {
    scale: Math.min(targetWidth / w, targetHeight / h),
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  };
}

function createBurstTexture() {
  const canvas = createCanvas(256, 256);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.1, 'rgba(225,250,255,0.95)');
  gradient.addColorStop(0.32, 'rgba(130,210,255,0.32)');
  gradient.addColorStop(1, 'rgba(100,190,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);

  ctx.save();
  ctx.translate(128, 128);
  ctx.strokeStyle = 'rgba(235,252,255,0.9)';
  ctx.lineWidth = 2;
  ctx.shadowColor = '#BFEFFF';
  ctx.shadowBlur = 14;
  for (let i = 0; i < 16; i += 1) {
    const angle = (i / 16) * Math.PI * 2;
    const length = i % 2 === 0 ? 108 : 72;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(angle) * length, Math.sin(angle) * length);
    ctx.stroke();
  }
  ctx.restore();
  return canvas;
}

function createDotTexture() {
  const canvas = createCanvas(64, 64);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(210,245,255,0.85)');
  gradient.addColorStop(1, 'rgba(120,200,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return canvas;
}

/* ------------------------------------------------------------------ */
/* 场景一：MERRY CHRISTMAS —— 弯曲花体 + 与树同源的颗粒                */
/* ------------------------------------------------------------------ */
export function MerryBrightText({ active, position }: EffectProps) {
  const { dancingScript, settled } = useFonts();
  const count = 5200;
  const attributeRef = useRef<THREE.BufferAttribute>(null);
  const materialRef = useRef<any>(null);
  const progressRef = useRef(0);

  const { targets, scatter, randoms, hues } = useMemo(() => {
    // 字体未就绪时先不采样：就绪后一次性用最终字体采样，字体全程固定不切换
    if (!settled) {
      const z = new Float32Array(count * 3);
      return { targets: z, scatter: new Float32Array(count * 3), randoms: new Float32Array(count), hues: new Float32Array(count) };
    }
    const fontFamily = dancingScript ? '"DancingScript", cursive' : 'Georgia, serif';
    const opts = {
      width: 1600,
      height: 520,
      fontSize: 260,
      fontFamily,
      step: 2,
    };
    const line1 = sampleGlyphPoints('MERRY', opts);
    const line2 = sampleGlyphPoints('CHRISTMAS', opts);
    const b1 = bboxOf(line1);
    const b2 = bboxOf(line2);

    // 两行统一字号：以较宽的一行为准，避免第二行被压扁
    const maxW = Math.max(b1.w, b2.w);
    const gapPx = 46;
    const totalH = b1.h + b2.h + gapPx;
    const scale = Math.min(40 / maxW, 10.5 / totalH);
    const y1 = (totalH / 2 - b1.h / 2) * scale;
    const y2 = -(totalH / 2 - b2.h / 2) * scale;

    const t = new Float32Array(count * 3);
    const s = new Float32Array(count * 3);
    const r = new Float32Array(count);
    const h = new Float32Array(count);
    const split = Math.floor(count * 0.42);

    for (let i = 0; i < count; i += 1) {
      const top = i < split;
      const arr = top ? line1 : line2;
      const box = top ? b1 : b2;
      const centerY = top ? y1 : y2;
      const sample = arr[i % arr.length] ?? [800, 260];
      t[i * 3] = position[0] + (sample[0] - box.cx) * scale + (Math.random() - 0.5) * 0.2;
      t[i * 3 + 1] = position[1] + centerY - (sample[1] - box.cy) * scale
        + (Math.random() - 0.5) * 0.2;
      t[i * 3 + 2] = position[2] + (Math.random() - 0.5) * 1.4;
      s[i * 3] = t[i * 3] + (Math.random() - 0.5) * 5;
      s[i * 3 + 1] = t[i * 3 + 1] - 3 - Math.random() * 4;
      s[i * 3 + 2] = t[i * 3 + 2] + (Math.random() - 0.5) * 6;
      r[i] = Math.random();
      // 窄幅青→蓝→紫渐变：保持冰蓝主调但更有层次
      const nx = (sample[0] - box.cx) / Math.max(1, box.w) + 0.5;
      h[i] = 0.47 + nx * 0.2 + (Math.random() - 0.5) * 0.02;
    }
    return { targets: t, scatter: s, randoms: r, hues: h };
  }, [position, dancingScript, settled]);

  const positions = useMemo(() => Float32Array.from(scatter), [scatter]);

  // 视角可自由绕树旋转：文字既始终正对相机（否则转到背面会镜像反转），
  // 又沿着相机方位绕到观察者这一侧的上方，保证任何角度都不会转出画面。
  const groupRef = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!groupRef.current) return;
    const cam = state.camera;
    const theta = Math.atan2(cam.position.x - position[0], cam.position.z - position[2]);
    groupRef.current.rotation.y = theta;
    groupRef.current.position.set(
      position[0] + Math.sin(theta) * 2.5,
      position[1],
      position[2] + Math.cos(theta) * 2.5,
    );
  });

  useFrame((state, delta) => {
    progressRef.current = THREE.MathUtils.damp(progressRef.current, active ? 1 : 0, 2.4, delta);
    const p = SMOOTH(progressRef.current);
    for (let i = 0; i < count; i += 1) {
      const i3 = i * 3;
      positions[i3] = THREE.MathUtils.lerp(scatter[i3], targets[i3], p);
      positions[i3 + 1] = THREE.MathUtils.lerp(scatter[i3 + 1], targets[i3 + 1], p);
      positions[i3 + 2] = THREE.MathUtils.lerp(scatter[i3 + 2], targets[i3 + 2], p);
    }
    if (attributeRef.current) attributeRef.current.needsUpdate = true;
    if (materialRef.current) {
      const t = state.clock.elapsedTime;
      materialRef.current.uTime = t;
      materialRef.current.uSize = 145;
      materialRef.current.uOpacity = THREE.MathUtils.damp(
        materialRef.current.uOpacity,
        active ? 0.95 : 0,
        3,
        delta,
      );
      materialRef.current.uFlash = active ? (Math.sin(t * 2.2) * 0.5 + 0.5) * 0.16 : 0;
    }
  });

  return (
    <group ref={groupRef} position={position}>
      {settled ? (
        <points position={[-position[0], -position[1], -position[2]]}>
          <bufferGeometry>
            <bufferAttribute ref={attributeRef} attach="attributes-position" args={[positions, 3]} />
            <bufferAttribute attach="attributes-aRandom" args={[randoms, 1]} />
            <bufferAttribute attach="attributes-aHue" args={[hues, 1]} />
          </bufferGeometry>
          {/* @ts-ignore */}
          <starPointsMaterial
            ref={materialRef}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            uOpacity={0}
            uColorMix={0.55}
          />
        </points>
      ) : null}
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* 参考视频里的顶部星芒                                                 */
/* ------------------------------------------------------------------ */
export function TopStarBurst({ position = [0, 14, 0] }: { position?: [number, number, number] }) {
  const texture = useMemo(() => makeTexture(createBurstTexture()), []);
  const spriteRef = useRef<THREE.Sprite>(null);
  const materialRef = useRef<THREE.SpriteMaterial>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (materialRef.current) materialRef.current.opacity = 0.78 + Math.sin(t * 2.8) * 0.18;
    if (spriteRef.current) {
      const scale = 4.6 + Math.sin(t * 3.4) * 0.4;
      spriteRef.current.scale.set(scale, scale, 1);
    }
  });

  return (
    <sprite ref={spriteRef} position={position} scale={[4.6, 4.6, 1]}>
      <spriteMaterial
        ref={materialRef}
        map={texture}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        opacity={0.85}
        toneMapped={false}
      />
    </sprite>
  );
}

/* ------------------------------------------------------------------ */
/* 参考视频底部的同心粒子光环                                           */
/* ------------------------------------------------------------------ */
export function OrbitRings() {
  const groupRef = useRef<THREE.Group>(null);
  const dotTexture = useMemo(() => makeTexture(createDotTexture()), []);
  const count = 1400;
  const radii = [12, 17.5, 23];

  const positions = useMemo(() => {
    const array = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const ring = i % radii.length;
      const radius = radii[ring] + (Math.random() - 0.5) * 1.4;
      const theta = Math.random() * Math.PI * 2;
      array[i * 3] = Math.cos(theta) * radius;
      array[i * 3 + 1] = -9 + (Math.random() - 0.5) * 0.8 + Math.sin(theta * 2) * 0.25;
      array[i * 3 + 2] = Math.sin(theta) * radius;
    }
    return array;
  }, []);

  useFrame((_, delta) => {
    if (groupRef.current) groupRef.current.rotation.y += delta * 0.045;
  });

  return (
    <group ref={groupRef}>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          map={dotTexture}
          color="#9FE4FF"
          size={0.34}
          sizeAttenuation
          transparent
          opacity={0.5}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* 场景二：考研上岸                                                     */
/* 突然散成细小星光 → 四面八方汇聚成离散字形 → 组装完成闪光            */
/* 节奏借鉴 lineart-anim-video：√权重封顶 / 并行重叠 / 两端 easing /    */
/* 完成瞬间才「上色」（此处为闪光）                                     */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 副文字：斜体衬线发光字（CanvasTexture sprite）                      */
/* 在「考研上岸」组装完成、闪光之后依次浮现，构成横版海报的下半部分     */
/* ------------------------------------------------------------------ */
type CaptionProps = {
  active: boolean;
  startRef: { current: number | null };
  text: string;
  fontReady: boolean;
  appearAt: number;
  worldWidth: number;
  x: number;
  y: number;
  z: number;
  opacity: number;
  fontSize: number;
  letterSpacing: number;
  withRules?: boolean;
  exitAt?: number; // 停留结束时刻：超过后随文字一起平缓淡出
};

function makeCaptionTexture(
  text: string,
  fontReady: boolean,
  fontSize: number,
  letterSpacing: number,
  withRules: boolean,
) {
  const canvas = createCanvas(1400, 220);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // 字体文件本身即为斜体；未加载完成时回退系统 Georgia 斜体
  ctx.font = fontReady
    ? `${fontSize}px "CormorantItalic", Georgia, serif`
    : `italic ${fontSize}px Georgia, "Times New Roman", serif`;
  try {
    (ctx as any).letterSpacing = `${letterSpacing}px`;
  } catch {
    /* 旧内核忽略字距 */
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const textWidth = ctx.measureText(text).width;

  if (withRules) {
    const gap = textWidth / 2 + 36;
    const g1 = ctx.createLinearGradient(cx - gap - 220, 0, cx - gap, 0);
    g1.addColorStop(0, 'rgba(159,232,255,0)');
    g1.addColorStop(1, 'rgba(159,232,255,0.55)');
    ctx.fillStyle = g1;
    ctx.fillRect(cx - gap - 220, cy - 1, 220, 2);
    const g2 = ctx.createLinearGradient(cx + gap, 0, cx + gap + 220, 0);
    g2.addColorStop(0, 'rgba(159,232,255,0.55)');
    g2.addColorStop(1, 'rgba(159,232,255,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(cx + gap, cy - 1, 220, 2);
  }

  ctx.shadowColor = 'rgba(150,225,255,0.9)';
  ctx.shadowBlur = 24;
  ctx.fillStyle = '#EAFBFF';
  ctx.fillText(text, cx, cy);
  ctx.shadowBlur = 0;
  ctx.fillText(text, cx, cy);
  return canvas;
}

function GlowCaption({
  active, startRef, text, fontReady, appearAt,
  worldWidth, x, y, z, opacity, fontSize, letterSpacing, withRules = false, exitAt,
}: CaptionProps) {
  const texture = useMemo(
    () => makeTexture(makeCaptionTexture(text, fontReady, fontSize, letterSpacing, withRules)),
    [text, fontReady, fontSize, letterSpacing, withRules],
  );
  const spriteRef = useRef<THREE.Sprite>(null);
  const materialRef = useRef<THREE.SpriteMaterial>(null);
  const aspect = 220 / 1400;

  useFrame((state, delta) => {
    const t = startRef.current === null ? 0 : state.clock.elapsedTime - startRef.current;
    const p = SINE_EASE((t - appearAt) / 0.85);
    const exitFade = exitAt === undefined ? 1 : 1 - SMOOTH((t - exitAt) / (ASCEND_DUR * 0.6));
    const target = active
      ? p * opacity * exitFade * (0.86 + 0.14 * Math.sin(state.clock.elapsedTime * 1.7))
      : 0;
    if (materialRef.current) {
      materialRef.current.opacity = THREE.MathUtils.damp(
        materialRef.current.opacity ?? 0, target, 4, delta,
      );
    }
    if (spriteRef.current) spriteRef.current.position.y = y - (1 - p) * 1.1;
  });

  return (
    <sprite ref={spriteRef} position={[x, y, z]} scale={[worldWidth, worldWidth * aspect, 1]}>
      <spriteMaterial
        ref={materialRef}
        map={texture}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        opacity={0}
        toneMapped={false}
      />
    </sprite>
  );
}

// 横版海报排版：主标题上移，下方依次是斜体日期与一行小字
const TITLE_Y_OFFSET = 3.6;    // 礼物阶段字幕基准（保持不变，避免字幕压到礼盒）
const TEXT_Y_OFFSET = 1.0;     // 「考研上岸」文字中心（下移，为上方照片留出空间）
const PHOTO_Y_OFFSET = 16.5;   // 上岸照片浮现在文字上方
const METEOR_Y_BASE = -7;      // 流星带整体下移到文字所在的下半区
const METEOR_Y_SCALE = 0.45;   // 压缩高度分布，避免高流星划进上方照片
const DATE_TEXT = 'December 25, 2026';
const TAGLINE_TEXT = 'Anything is possible';

/* ------------------------------------------------------------------ */
/* 上岸照片：与「考研上岸」同框，在其上方带金框与柔光浮现，同步淡出      */
/* ------------------------------------------------------------------ */
function WishPhoto({
  active, startRef, url, position,
}: {
  active: boolean;
  startRef: { current: number | null };
  url: string;
  position: [number, number, number];
}) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const groupRef = useRef<THREE.Group>(null);
  const frameMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const photoMatRef = useRef<THREE.MeshBasicMaterial>(null);

  // 手动加载 data URL（用户上传的照片），避免额外依赖
  useEffect(() => {
    if (!url) { setTexture(null); return; }
    let alive = true;
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (tex) => {
        if (!alive) { tex.dispose(); return; }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        setTexture(tex);
      },
      undefined,
      () => { if (alive) setTexture(null); },
    );
    return () => { alive = false; };
  }, [url]);

  // 按图片宽高比适配：限制最大宽高，保持比例
  const { pw, ph } = useMemo(() => {
    const img = texture?.image as { width?: number; height?: number } | undefined;
    const iw = img?.width || 4;
    const ih = img?.height || 3;
    const aspect = iw / ih;
    const maxW = 34, maxH = 18;
    let w = maxW, h = maxW / aspect;
    if (h > maxH) { h = maxH; w = maxH * aspect; }
    return { pw: w, ph: h };
  }, [texture]);

  useFrame((state, delta) => {
    if (!groupRef.current) return;
    const t = startRef.current === null ? 0 : state.clock.elapsedTime - startRef.current;
    // 淡入 → 停留 → 淡出
    const appear = SINE_EASE((t - PHOTO_REVEAL_AT) / 0.7);
    const exit = 1 - SMOOTH((t - PHOTO_HOLD_UNTIL) / PHOTO_FADE_DUR);
    const vis = active && texture ? appear * exit : 0;
    // 浮现时轻微上浮 + 由小放大，带一点呼吸浮动
    const pop = 0.9 + 0.1 * SINE_EASE((t - PHOTO_REVEAL_AT) / 0.9);
    const float = Math.sin(state.clock.elapsedTime * 0.9) * 0.18 * vis;
    groupRef.current.scale.setScalar(pop);
    groupRef.current.position.set(
      position[0],
      position[1] + PHOTO_Y_OFFSET + float,
      position[2] + 1,
    );
    if (frameMatRef.current) {
      frameMatRef.current.opacity = THREE.MathUtils.damp(frameMatRef.current.opacity ?? 0, vis, 12, delta);
    }
    if (photoMatRef.current) {
      photoMatRef.current.opacity = THREE.MathUtils.damp(photoMatRef.current.opacity ?? 0, vis, 12, delta);
    }
    groupRef.current.visible = (photoMatRef.current?.opacity ?? 0) > 0.002;
  });

  if (!texture) return null;
  const frame = 0.55;
  return (
    <group ref={groupRef} position={[position[0], position[1] + PHOTO_Y_OFFSET, position[2] + 1]}>
      {/* 金色相框 */}
      <mesh>
        <planeGeometry args={[pw + frame * 2, ph + frame * 2]} />
        <meshBasicMaterial
          ref={frameMatRef}
          color="#F4D98A"
          transparent
          opacity={0}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {/* 照片本体 */}
      <mesh position={[0, 0, 0.05]}>
        <planeGeometry args={[pw, ph]} />
        <meshBasicMaterial
          ref={photoMatRef}
          map={texture}
          transparent
          opacity={0}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* 流星 v2：贝塞尔弧线尾迹 + 暖金火花迸溅 + 湍流尾 + 头部脉动 + 流星雨   */
/* 尾迹色温分层：贴头白热 -> 尾端深蓝渐隐；火花用独立暖金配色实例        */
/* ------------------------------------------------------------------ */
const MeteorMaterial = shaderMaterial(
  {
    uCold: new THREE.Color('#3E6FB8'),
    uHot: new THREE.Color('#FFFFFF'),
  },
  /* vertex */ `
    attribute float aAlpha;
    attribute float aSize;
    varying float vAlpha;
    void main() {
      vAlpha = aAlpha;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (60.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }
  `,
  /* fragment */ `
    uniform vec3 uCold;
    uniform vec3 uHot;
    varying float vAlpha;
    void main() {
      float r = distance(gl_PointCoord, vec2(0.5));
      if (r > 0.5) discard;
      float glow = pow(smoothstep(0.5, 0.0, r), 1.7);
      vec3 c = mix(uCold, uHot, pow(vAlpha, 0.75));
      gl_FragColor = vec4(c, glow * vAlpha);
    }
  `,
);
extend({ MeteorMaterial });

type MeteorDef = {
  from: [number, number, number];
  to: [number, number, number];
  lift: number;
  startAt: number;
  duration: number;
  period: number;
  tailFrac: number;
  brightness: number;
  headScale: number;
  sizeBase: number;
  sparks: number;
};

// 确定性随机：保证每次刷新/截图流星布局一致
function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 56 颗流星：2 颗主星 + 40 颗密集流星雨 + 14 颗循环氛围星
const METEOR_DEFS: MeteorDef[] = (() => {
  const rand = seededRandom(20261225);
  const defs: MeteorDef[] = [
    // 主流星：文字成形瞬间横掠上方，最亮最长，火花最密
    { from: [-34, 12, -2], to: [30, 6, -2], lift: 3.5, startAt: WISH_T.METEOR_AT, duration: 1.55, period: 0, tailFrac: 0.5, brightness: 1.0, headScale: 2.2, sizeBase: 13, sparks: 3 },
    // 副流星：反向掠过
    { from: [30, 16, -14], to: [-24, 8, -14], lift: 4, startAt: WISH_T.METEOR_AT + 1.15, duration: 1.35, period: 0, tailFrac: 0.45, brightness: 0.6, headScale: 1.5, sizeBase: 9, sparks: 2 },
  ];
  // 密集流星雨：文字成形即 40 颗从右上象限分层放射，大批量划过
  for (let i = 0; i < 40; i += 1) {
    const reverse = i % 5 === 0;
    const depth = -5 - Math.floor(i / 4) * 2.4 - rand() * 2;
    const y = 6 + rand() * 26;
    defs.push({
      from: reverse ? [-32 - rand() * 10, y, depth] : [30 + rand() * 12, y, depth],
      to: reverse ? [28 + rand() * 12, y - 4 - rand() * 10, depth] : [-28 - rand() * 12, y - 4 - rand() * 10, depth],
      lift: 2.5 + rand() * 6,
      startAt: WISH_T.METEOR_AT + 0.06 + i * 0.021 + rand() * 0.06,
      duration: 0.85 + rand() * 0.55,
      period: 0,
      tailFrac: 0.24 + rand() * 0.13,
      brightness: 0.22 + rand() * 0.3,
      headScale: 0.68 + rand() * 0.5,
      sizeBase: 5.5 + rand() * 4,
      sparks: rand() < 0.35 ? 1 : 0,
    });
  }
  // 氛围流星：14 条错峰循环，让夜空持续有流星划过（含礼物成形期间）
  for (let i = 0; i < 14; i += 1) {
    const reverse = i % 2 === 1;
    const depth = -6 - rand() * 26;
    const y = 5 + rand() * 24;
    defs.push({
      from: reverse ? [-28 - rand() * 8, y, depth] : [26 + rand() * 10, y, depth],
      to: reverse ? [26 + rand() * 10, y - 3 - rand() * 8, depth] : [-28 - rand() * 10, y - 3 - rand() * 8, depth],
      lift: 2 + rand() * 4,
      startAt: 2.2 + i * 0.83 + rand() * 0.4,
      duration: 0.95 + rand() * 0.5,
      period: 8 + (i % 7) * 1.3,
      tailFrac: 0.3 + rand() * 0.14,
      brightness: 0.26 + rand() * 0.22,
      headScale: 0.7 + rand() * 0.4,
      sizeBase: 5 + rand() * 3.5,
      sparks: 0,
    });
  }
  return defs;
})();

const METEOR_TRAIL = 128;
const SPARKS_PER_METEOR = 24;

// 每帧复用临时向量，避免上万粒子更新时产生 GC 抖动
const _meteorPoint = new THREE.Vector3();
const _meteorHead = new THREE.Vector3();
const _meteorTangent = new THREE.Vector3();

type Spark = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
};

function MeteorShower({
  active,
  startRef,
  position,
}: {
  active: boolean;
  startRef: { current: number | null };
  position: [number, number, number];
}) {
  const trailRef = useRef<THREE.BufferAttribute>(null);
  const trailAlphaRef = useRef<THREE.BufferAttribute>(null);
  const sparkRef = useRef<THREE.BufferAttribute>(null);
  const sparkAlphaRef = useRef<THREE.BufferAttribute>(null);
  const headRefs = useRef<Array<THREE.Sprite | null>>([]);
  const headMaterialRefs = useRef<Array<THREE.SpriteMaterial | null>>([]);
  const headTexture = useMemo(() => makeTexture(createDotTexture()), []);

  const { trailPos, trailAlpha, trailSize, trailJitter, sparkPos, sparkAlpha, sparkSize, sparks, curves } = useMemo(() => {
    const trailPos = new Float32Array(METEOR_DEFS.length * METEOR_TRAIL * 3);
    const trailAlpha = new Float32Array(METEOR_DEFS.length * METEOR_TRAIL);
    const trailSize = new Float32Array(METEOR_DEFS.length * METEOR_TRAIL);
    const trailJitter = new Float32Array(METEOR_DEFS.length * METEOR_TRAIL * 3);
    const sparkPos = new Float32Array(METEOR_DEFS.length * SPARKS_PER_METEOR * 3);
    const sparkAlpha = new Float32Array(METEOR_DEFS.length * SPARKS_PER_METEOR);
    const sparkSize = new Float32Array(METEOR_DEFS.length * SPARKS_PER_METEOR);
    const sparks: Spark[][] = METEOR_DEFS.map(() =>
      Array.from({ length: SPARKS_PER_METEOR }, () => ({
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: -1, max: 1,
      })),
    );
    const curves = METEOR_DEFS.map((def) => {
      // 流星整体下移到文字带：把原高度分布压缩并平移到画面下半
      const from = new THREE.Vector3(
        position[0] + def.from[0],
        position[1] + METEOR_Y_BASE + (def.from[1] - 6) * METEOR_Y_SCALE,
        position[2] + def.from[2],
      );
      const to = new THREE.Vector3(
        position[0] + def.to[0],
        position[1] + METEOR_Y_BASE + (def.to[1] - 6) * METEOR_Y_SCALE,
        position[2] + def.to[2],
      );
      const mid = from.clone().lerp(to, 0.5);
      mid.y += def.lift * 0.3;
      return new THREE.QuadraticBezierCurve3(from, mid, to);
    });
    for (let m = 0; m < METEOR_DEFS.length; m += 1) {
      const def = METEOR_DEFS[m];
      for (let j = 0; j < METEOR_TRAIL; j += 1) {
        const idx = m * METEOR_TRAIL + j;
        const pj = j / METEOR_TRAIL;
        trailSize[idx] = def.sizeBase * (0.14 + Math.pow(1 - pj, 2.1) * 0.86);
        // 湍流：越靠尾端散得越开的固定随机偏移
        const spread = 0.55 + def.headScale * 0.4;
        trailJitter[idx * 3] = (Math.random() - 0.5) * 2 * spread;
        trailJitter[idx * 3 + 1] = (Math.random() - 0.5) * 2 * spread;
        trailJitter[idx * 3 + 2] = (Math.random() - 0.5) * 2 * spread;
      }
      for (let k = 0; k < SPARKS_PER_METEOR; k += 1) {
        sparkSize[m * SPARKS_PER_METEOR + k] = 1.6 + Math.random() * 2.4;
      }
    }
    return { trailPos, trailAlpha, trailSize, trailJitter, sparkPos, sparkAlpha, sparkSize, sparks, curves };
  }, [position]);

  useFrame((state, delta) => {
    const t = startRef.current === null ? -1 : state.clock.elapsedTime - startRef.current;
    const show = active && t >= 0;
    const dt = Math.min(delta, 0.05);
    const clock = state.clock.elapsedTime;

    for (let m = 0; m < METEOR_DEFS.length; m += 1) {
      const def = METEOR_DEFS[m];
      const base = m * METEOR_TRAIL;

      let u = -1;
      let linger = 0;
      if (show && t >= def.startAt) {
        const local = def.period > 0 ? (t - def.startAt) % def.period : t - def.startAt;
        if (local <= def.duration) {
          u = local / def.duration;
        } else if (local <= def.duration + 0.45) {
          linger = (local - def.duration) / 0.45;
          u = 1 + def.tailFrac * linger;
        }
      }

      // 头部亮核（带脉动）
      const headSprite = headRefs.current[m];
      const headMat = headMaterialRefs.current[m];
      if (headSprite && headMat) {
        headSprite.visible = u >= 0 && linger === 0;
        if (headSprite.visible) {
          const fade = Math.min(1, u / 0.12) * Math.min(1, (1 - u) / 0.22);
          headSprite.position.copy(curves[m].getPoint(Math.min(1, u), _meteorPoint));
          const pulse = 0.9 + 0.1 * Math.sin(clock * 17 + m * 2.3);
          const hs = def.headScale * (0.7 + 0.3 * fade) * pulse;
          headSprite.scale.set(hs, hs, 1);
          headMat.opacity = def.brightness * fade * (0.88 + 0.12 * pulse);
        }
      }

      // 活跃头部沿途迸溅火花（导数直接算切线，复用临时向量零分配）
      let tangent: THREE.Vector3 | null = null;
      if (u >= 0 && linger === 0) {
        const curve = curves[m];
        const tu = Math.min(1, u);
        const it = 1 - tu;
        tangent = _meteorTangent.set(
          2 * it * (curve.v1.x - curve.v0.x) + 2 * tu * (curve.v2.x - curve.v1.x),
          2 * it * (curve.v1.y - curve.v0.y) + 2 * tu * (curve.v2.y - curve.v1.y),
          2 * it * (curve.v1.z - curve.v0.z) + 2 * tu * (curve.v2.z - curve.v1.z),
        ).normalize();
      }
      if (tangent && u > 0.04 && u < 0.96) {
        const head = curves[m].getPoint(Math.min(1, u), _meteorHead);
        const pool = sparks[m];
        for (let k = 0; k < def.sparks; k += 1) {
          const sp = pool.find((s) => s.life <= 0);
          if (!sp) break;
          sp.x = head.x + (Math.random() - 0.5) * 0.5;
          sp.y = head.y + (Math.random() - 0.5) * 0.5;
          sp.z = head.z + (Math.random() - 0.5) * 0.5;
          // 随机球面向外 + 沿轨迹向后甩 + 微微上扬
          const a1 = Math.random() * Math.PI * 2;
          const a2 = Math.acos(2 * Math.random() - 1);
          const speed = 1.1 + Math.random() * 2.1;
          sp.vx = (Math.sin(a2) * Math.cos(a1) * 0.85 - tangent.x * 0.45) * speed;
          sp.vy = (Math.cos(a2) * 0.85 + 0.18) * speed;
          sp.vz = (Math.sin(a2) * Math.sin(a1) * 0.85 - tangent.z * 0.45) * speed;
          sp.max = 0.4 + Math.random() * 0.55;
          sp.life = sp.max;
        }
      }

      // 尾迹：贴头白热，尾端湍流散开渐隐
      for (let j = 0; j < METEOR_TRAIL; j += 1) {
        const idx = base + j;
        const pj = j / METEOR_TRAIL;
        if (u < 0) {
          trailAlpha[idx] = 0;
          continue;
        }
        const pathU = u - pj * def.tailFrac;
        if (pathU <= 0 || pathU > 1 + def.tailFrac * linger + 0.001) {
          trailAlpha[idx] = 0;
          continue;
        }
        const p = curves[m].getPoint(Math.min(1, pathU), _meteorPoint);
        const tj = Math.pow(pj, 1.6);
        trailPos[idx * 3] = p.x + trailJitter[idx * 3] * tj;
        trailPos[idx * 3 + 1] = p.y + trailJitter[idx * 3 + 1] * tj;
        trailPos[idx * 3 + 2] = p.z + trailJitter[idx * 3 + 2] * tj;
        const fade = Math.min(1, Math.max(0, u) / 0.12);
        trailAlpha[idx] = Math.pow(1 - pj, 1.9) * fade * def.brightness * (1 - linger);
      }

      // 火花物理：外抛 + 微重力下坠 + 渐隐
      const pool = sparks[m];
      for (let k = 0; k < SPARKS_PER_METEOR; k += 1) {
        const idx = m * SPARKS_PER_METEOR + k;
        const sp = pool[k];
        if (sp.life > 0) {
          sp.life -= dt;
          sp.x += sp.vx * dt;
          sp.y += sp.vy * dt;
          sp.z += sp.vz * dt;
          sp.vy -= 1.0 * dt;
          const e = Math.max(0, sp.life / sp.max);
          sparkPos[idx * 3] = sp.x;
          sparkPos[idx * 3 + 1] = sp.y;
          sparkPos[idx * 3 + 2] = sp.z;
          sparkAlpha[idx] = Math.pow(e, 1.6) * def.brightness * 0.9;
        } else {
          sparkAlpha[idx] = 0;
        }
      }
    }

    if (trailRef.current) trailRef.current.needsUpdate = true;
    if (trailAlphaRef.current) trailAlphaRef.current.needsUpdate = true;
    if (sparkRef.current) sparkRef.current.needsUpdate = true;
    if (sparkAlphaRef.current) sparkAlphaRef.current.needsUpdate = true;
  });

  return (
    <>
      <points>
        <bufferGeometry>
          <bufferAttribute ref={trailRef} attach="attributes-position" args={[trailPos, 3]} />
          <bufferAttribute ref={trailAlphaRef} attach="attributes-aAlpha" args={[trailAlpha, 1]} />
          <bufferAttribute attach="attributes-aSize" args={[trailSize, 1]} />
        </bufferGeometry>
        {/* @ts-ignore */}
        <meteorMaterial transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </points>

      {/* 暖金火花：流星划过时迸溅的火光碎屑 */}
      <points>
        <bufferGeometry>
          <bufferAttribute ref={sparkRef} attach="attributes-position" args={[sparkPos, 3]} />
          <bufferAttribute ref={sparkAlphaRef} attach="attributes-aAlpha" args={[sparkAlpha, 1]} />
          <bufferAttribute attach="attributes-aSize" args={[sparkSize, 1]} />
        </bufferGeometry>
        {/* @ts-ignore */}
        <meteorMaterial transparent depthWrite={false} blending={THREE.AdditiveBlending} uCold="#C9862F" uHot="#FFF3D6" />
      </points>

      {METEOR_DEFS.map((_, m) => (
        <sprite
          key={m}
          ref={(el) => { headRefs.current[m] = el; }}
          visible={false}
          scale={[1, 1, 1]}
        >
          <spriteMaterial
            ref={(el) => { headMaterialRefs.current[m] = el; }}
            map={headTexture}
            color="#EAFBFF"
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            opacity={0}
            toneMapped={false}
          />
        </sprite>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 七幕人物星光画：答题 → 吃火锅 → 过圣诞 → 回家过年 → 返校 → 面试 → 录取 */
/* 每幕由旁侧候场的星光汇聚成形，停留后散开切换下一幕，最终散场回树        */
/* ------------------------------------------------------------------ */
const SCENE_COUNT = 18000;
const SCENE_FILES = [
  '/scenes/scene1.png', // 答题
  '/scenes/scene2.png', // 吃火锅
  '/scenes/scene3.png', // 过圣诞
  '/scenes/scene4.png', // 回家过年
  '/scenes/scene5.png', // 一月返校
  '/scenes/scene6.png', // 二月面试
  '/scenes/scene7.png', // 录取通知书
];
// 画面尺寸为响应式：按「宽覆盖约 80% 视宽、高不超过 85% 视高」取小值，
// 横版构图（宽>高）在网页平面上铺得更满
const SCENE_Y_OFFSET = 3.5;  // 画面中心相对文字锚点的抬升
const SCENE1_START = WISH_T.SCENE1_START;
const SCENE_INTERVAL = WISH_T.SCENE_INTERVAL;
const SCENE_TOTAL = WISH_T.SCENE_TOTAL;
const SCENE_CONVERGE = WISH_T.SCENE_CONVERGE;
const SCATTER_START = WISH_T.SCATTER_START;
const SCATTER_DUR = WISH_T.SCATTER_DUR;

// 从设计稿采样星光目标点：内容区域权重高，轮廓边缘额外加权（五官/证书边清晰可辨）；
// 四周做边界衰减，让画面边缘自然融入星空、看不到「相框」边界
function sampleSceneTargets(
  img: HTMLImageElement,
  count: number,
  worldW: number,
  rand: () => number,
): Float32Array {
  const pos = new Float32Array(count * 3);
  const SW = 384;
  const aspect = (img.naturalWidth || 2) / (img.naturalHeight || 3);
  const SH = Math.max(2, Math.round(SW / aspect));
  const canvas = createCanvas(SW, SH);
  const ctx = canvas.getContext('2d');
  const worldH = worldW / aspect;
  if (!ctx) return pos;
  ctx.drawImage(img, 0, 0, SW, SH);
  const data = ctx.getImageData(0, 0, SW, SH).data;

  // 边界衰减遮罩：距边缘 7% 以内线性衰减到 0，避免矩形边界感
  const edgeFade = (u: number) => {
    const m = 0.07;
    const d = Math.min(u, 1 - u); // 到最近边的归一化距离
    return clamp01(d / m);
  };

  const w = new Float32Array(SW * SH);
  for (let y = 0; y < SH; y += 1) {
    for (let x = 0; x < SW; x += 1) {
      const i = y * SW + x;
      const o = i * 4;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const lum = (r + g + b) / 3;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      const dark = clamp01((200 - lum) / 120);
      const satw = clamp01((sat - 30) / 110);
      let weight = dark * 0.55 + satw * 0.62;
      // 轮廓检测：与左/上邻域亮度差分
      if (y > 0) {
        const up = ((y - 1) * SW + x) * 4;
        weight += clamp01((Math.abs(lum - (data[up] + data[up + 1] + data[up + 2]) / 3) - 6) / 30) * 3.2;
      }
      if (x > 0) {
        const lf = (y * SW + x - 1) * 4;
        weight += clamp01((Math.abs(lum - (data[lf] + data[lf + 1] + data[lf + 2]) / 3) - 6) / 30) * 3.2;
      }
      weight *= edgeFade(x / (SW - 1)) * edgeFade(y / (SH - 1));
      w[i] = lum > 232 ? weight * 0.03 : weight;
    }
  }

  // 累积分布采样，保证点数比例与权重一致
  let acc = 0;
  const cum: number[] = [], px: number[] = [], py: number[] = [];
  for (let y = 0; y < SH; y += 1) {
    for (let x = 0; x < SW; x += 1) {
      const i = y * SW + x;
      if (w[i] > 0.001) {
        acc += w[i];
        cum.push(acc); px.push(x); py.push(y);
      }
    }
  }
  if (acc <= 0) return pos;
  for (let i = 0; i < count; i += 1) {
    const target = rand() * acc;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid + 1; else hi = mid;
    }
    const fx = (px[lo] + rand() - 0.5) / SW;
    const fy = (py[lo] + rand() - 0.5) / SH;
    pos[i * 3] = (fx - 0.5) * worldW;
    pos[i * 3 + 1] = (0.5 - fy) * worldH;
    pos[i * 3 + 2] = (rand() - 0.5) * 1.6;
  }
  return pos;
}

function WishScenes({
  active, startRef, position,
}: {
  active: boolean;
  startRef: { current: number | null };
  position: [number, number, number];
}) {
  const [sceneImgs, setSceneImgs] = useState<Array<HTMLImageElement | null>>(
    SCENE_FILES.map(() => null),
  );
  const attributeRef = useRef<THREE.BufferAttribute>(null);
  const materialRef = useRef<any>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);

  // 加载七幕设计稿
  useEffect(() => {
    let alive = true;
    SCENE_FILES.forEach((src, i) => {
      const img = new Image();
      img.onload = () => {
        if (!alive) return;
        setSceneImgs((prev) => {
          const next = [...prev];
          next[i] = img;
          return next;
        });
      };
      img.src = src;
    });
    return () => { alive = false; };
  }, []);

  const ready = sceneImgs.every(Boolean);

  // 画面平面处的可视范围（世界单位）：相机 fov=45，看向原点，画面在 z≈-3.2
  const vis = useMemo(() => {
    const dist = Math.max(1, camera.position.z - (position[2] + 0.8));
    const vFov = THREE.MathUtils.degToRad(camera.fov || 45);
    const visH = 2 * dist * Math.tan(vFov / 2);
    const visW = visH * (size.width / Math.max(1, size.height));
    return { visW, visH };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, size.width, size.height]);

  // 七幕目标点 + 旁侧候场起点 + 散场方向（同一 rand 序列保证稳定）
  const data = useMemo(() => {
    if (!ready) return null;
    let seed = 20261225;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    // 每幅图按自身宽高比适配：宽覆盖 80% 视宽，高不超过 85% 视高
    const targets = sceneImgs.map((img) => {
      const aspect = (img!.naturalWidth || 2) / (img!.naturalHeight || 3);
      const worldW = Math.min(vis.visW * 0.8, aspect * vis.visH * 0.85);
      return sampleSceneTargets(img!, SCENE_COUNT, worldW, rand);
    });
    // 候场星光环绕半径随画面尺寸等比放大（基准：宽 23 时半径 10~26）
    const sceneW = Math.min(vis.visW * 0.8, 1.63 * vis.visH * 0.85);
    const ringK = Math.min(2.2, Math.max(1, sceneW / 23));
    const starts = new Float32Array(SCENE_COUNT * 3);
    const dirs = new Float32Array(SCENE_COUNT * 3);
    const randoms = new Float32Array(SCENE_COUNT);
    const hues = new Float32Array(SCENE_COUNT);
    const shades = new Float32Array(SCENE_COUNT);
    for (let i = 0; i < SCENE_COUNT; i += 1) {
      const ang = rand() * Math.PI * 2;
      const rx = Math.cos(ang) * (10 + rand() * 16) * ringK;
      const ry = Math.sin(ang) * (6 + rand() * 10) * ringK;
      const rz = (rand() - 0.5) * 12;
      starts[i * 3] = rx;
      starts[i * 3 + 1] = ry;
      starts[i * 3 + 2] = rz;
      const dl = Math.hypot(rx, ry, rz) || 1;
      dirs[i * 3] = rx / dl;
      dirs[i * 3 + 1] = ry / dl + 0.25; // 散场时整体略向上飘
      dirs[i * 3 + 2] = rz / dl;
      randoms[i] = rand();
      hues[i] = 0.09 + rand() * 0.05; // 暖金色相，与文字星光一致
      shades[i] = 0.3 + rand() * 0.5;
    }
    return { targets, starts, dirs, randoms, hues, shades };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, vis.visW, vis.visH]);

  const positions = useMemo(() => new Float32Array(SCENE_COUNT * 3), []);
  const EMPTY_F32 = useMemo(() => new Float32Array(SCENE_COUNT), []);

  useFrame((state, delta) => {
    const mat = materialRef.current;
    if (!mat) return;
    const t = startRef.current === null ? 0 : state.clock.elapsedTime - startRef.current;
    mat.uTime = state.clock.elapsedTime;
    mat.uSize = 132;
    mat.uGiftMix = 0;

    if (!active || !data) {
      mat.uOpacity = THREE.MathUtils.damp(mat.uOpacity ?? 0, 0, 4, delta);
      return;
    }

    const { targets, starts, dirs, randoms } = data;
    // 当前所处幕（最后一幕后保持成形直至散场）
    let idx = Math.floor((t - SCENE1_START) / SCENE_INTERVAL);
    idx = Math.max(0, Math.min(SCENE_TOTAL - 1, idx));
    const convStart = SCENE1_START + idx * SCENE_INTERVAL;
    const convRaw = clamp01((t - convStart) / SCENE_CONVERGE);
    const convP = SINE_EASE(convRaw);
    const to = targets[idx];
    const from = idx === 0 ? starts : targets[idx - 1];
    // 切幕时中段向外膨胀，营造「散开再重聚」的呼吸感
    const bloom = idx === 0 ? 0 : 0.3 * Math.sin(Math.PI * convRaw);
    const scatterT = Math.max(0, t - SCATTER_START);

    for (let i = 0; i < SCENE_COUNT; i += 1) {
      const i3 = i * 3;
      let x: number;
      let y: number;
      let z: number;
      if (t < SCENE1_START) {
        // 旁侧候场星光：环绕画面缓慢漂移
        x = starts[i3] + Math.sin(t * 0.5 + randoms[i] * 6.28) * 0.4;
        y = starts[i3 + 1] + Math.cos(t * 0.4 + randoms[i] * 6.28) * 0.3;
        z = starts[i3 + 2];
      } else {
        const arcX = Math.sin(convP * Math.PI) * (0.5 + randoms[i] * 1.2);
        const arcY = Math.sin(convP * Math.PI) * (0.8 + randoms[i] * 1.8);
        const fx = from[i3] * (1 + bloom);
        const fy = from[i3 + 1] * (1 + bloom);
        const fz = from[i3 + 2] * (1 + bloom);
        x = THREE.MathUtils.lerp(fx, to[i3], convP) + arcX;
        y = THREE.MathUtils.lerp(fy, to[i3 + 1], convP) + arcY;
        z = THREE.MathUtils.lerp(fz, to[i3 + 2], convP);
        if (convRaw >= 1) {
          // 成形后沿笔画缓慢流动，保持星光灵动
          const drift = SMOOTH((t - convStart - SCENE_CONVERGE) / 0.5);
          const ph = t * 0.55 + randoms[i] * 6.28;
          x += Math.sin(ph) * 0.1 * drift;
          y += Math.cos(ph * 0.8 + i * 0.01) * 0.09 * drift;
          z += Math.sin(ph * 0.6) * 0.1 * drift;
        }
      }
      if (scatterT > 0) {
        // 散场：沿各自方向加速飞离，略向上飘
        const st2 = scatterT * scatterT;
        x += dirs[i3] * st2 * 3.2;
        y += dirs[i3 + 1] * st2 * 3.2;
        z += dirs[i3 + 2] * st2 * 2.0;
      }
      positions[i3] = x;
      positions[i3 + 1] = y;
      positions[i3 + 2] = z;
    }
    if (attributeRef.current) attributeRef.current.needsUpdate = true;

    // 透明度：与文字淡出同步淡入（候场星光不干扰礼盒/文字阶段）→ 散场淡出；
    // 透明度略降让画面与星空底色融合更自然
    const inOp = SINE_EASE((t - (WISH_T.ASCEND_START - 0.3)) / 1.6);
    const outOp = 1 - SMOOTH((t - SCATTER_START) / SCATTER_DUR);
    mat.uOpacity = THREE.MathUtils.damp(mat.uOpacity ?? 0, 0.98 * inOp * outOp, 4, delta);

    // 每幕成形瞬间闪光
    let flash = 0;
    for (let k = 0; k < SCENE_TOTAL; k += 1) {
      const done = SCENE1_START + k * SCENE_INTERVAL + SCENE_CONVERGE;
      if (t >= done) flash += 0.5 * Math.exp(-(t - done) / 0.28);
    }
    mat.uFlash = Math.min(0.6, flash);
  });

  return (
    <group position={[position[0], position[1] + SCENE_Y_OFFSET, position[2] + 0.8]}>
      <points visible={active}>
        <bufferGeometry>
          <bufferAttribute ref={attributeRef} attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-aRandom" args={[data?.randoms ?? EMPTY_F32, 1]} />
          <bufferAttribute attach="attributes-aHue" args={[data?.hues ?? EMPTY_F32, 1]} />
          <bufferAttribute attach="attributes-aGiftShade" args={[data?.shades ?? EMPTY_F32, 1]} />
        </bufferGeometry>
        {/* @ts-ignore */}
        <starPointsMaterial
          ref={materialRef}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          uOpacity={0}
          uColorMix={0.95}
        />
      </points>
    </group>
  );
}

const BURST_END = WISH_T.BURST_END;
// 树散成星 → 星光聚成礼物 → 礼物炸开 → 才汇聚成文字
const ASSEMBLE_START = WISH_T.ASSEMBLE_START;
const ASSEMBLE_DUR = WISH_T.ASSEMBLE_DUR;
// 文字成形瞬间：大批量流星爆发；副标题等流星掠过再浮现
const METEOR_AT = WISH_T.METEOR_AT;
// 结尾闭环：文字化光束上飘 → 浮现上岸照片 → 回调复位
const ASCEND_START = WISH_T.ASCEND_START;
const ASCEND_DUR = WISH_T.ASCEND_DUR;
const RESET_AT = WISH_T.RESET_AT;
const PHOTO_REVEAL_AT = WISH_T.PHOTO_REVEAL_AT;
const PHOTO_HOLD_UNTIL = WISH_T.PHOTO_HOLD_UNTIL;
const PHOTO_FADE_DUR = WISH_T.PHOTO_FADE_DUR;
const PHOTO_RESET_AT = WISH_T.PHOTO_RESET_AT;

export function WishLightWriting({ active, position, onComplete, photoUrl }: EffectProps) {
  const { longCang, cormorant, liujian, kuaiLe } = useFonts();
  const count = 7600;
  const startRef = useRef<number | null>(null);
  const attributeRef = useRef<THREE.BufferAttribute>(null);
  const materialRef = useRef<any>(null);
  const completedRef = useRef(false); // 复位回调只触发一次
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const [giftImg, setGiftImg] = useState<HTMLImageElement | null>(null);

  // 礼盒星光权重贴图（由用户提供的礼盒图片抠图生成）
  useEffect(() => {
    const img = new Image();
    img.onload = () => setGiftImg(img);
    img.src = '/textures/gift_shape.png';
    return () => { img.onload = null; };
  }, []);

  // 礼物目标点单独计算：图片异步加载完成后重算，不影响文字/散布等粒子布局
  const { giftTargets, giftShade, burstVel } = useMemo(() => {
    const sample = rasterizeGiftImage(giftImg, count, 21, Math.random);
    // 礼盒向左偏、稍降，与上方居中的字幕形成错位构图，互不重合
    const giftCx = position[0] - 6.5, giftCy = position[1] + 1.6, giftCz = position[2] + 2;
    const tgt = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      tgt[i * 3] = giftCx + sample.pos[i * 3];
      tgt[i * 3 + 1] = giftCy + sample.pos[i * 3 + 1];
      tgt[i * 3 + 2] = giftCz + sample.pos[i * 3 + 2];
    }

    // 烟花爆开速度场：从礼盒中心沿径向球壳飞出（方向 = 礼盒内该点的朝向 + 少量随机抖动），
    // 阻尼减速 + 轻微下坠，末态作为「汇聚成文字」的起点
    const vel = new Float32Array(count * 3);
    const exEnd = new Float32Array(count * 3);
    const K = 2.2;                                   // 线性阻尼系数
    const ET = WISH_T.EXPLODE_DUR;
    const dragEnd = (1 - Math.exp(-K * ET)) / K;     // 阻尼位移因子
    const BASE = 40;                                 // 基础初速（世界单位/秒）
    const DROOP = 0.45;                              // 重力下坠加速度
    for (let i = 0; i < count; i += 1) {
      let dx = sample.pos[i * 3];
      let dy = sample.pos[i * 3 + 1];
      let dz = sample.pos[i * 3 + 2] * 0.55;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx = dx / len + (Math.random() - 0.5) * 0.5;
      dy = dy / len + (Math.random() - 0.5) * 0.5;
      dz = dz / len + (Math.random() - 0.5) * 0.35;
      const n2 = Math.hypot(dx, dy, dz) || 1;
      const spd = BASE * (0.55 + Math.random() * 0.75);
      const vx = (dx / n2) * spd;
      const vy = (dy / n2) * spd;
      const vz = (dz / n2) * spd;
      vel[i * 3] = vx;
      vel[i * 3 + 1] = vy;
      vel[i * 3 + 2] = vz;
      // 爆开末态（τ=EXPLODE_DUR）：中心 + 阻尼位移 - 下坠
      exEnd[i * 3] = giftCx + vx * dragEnd;
      exEnd[i * 3 + 1] = giftCy + vy * dragEnd - DROOP * ET * ET;
      exEnd[i * 3 + 2] = giftCz + vz * dragEnd;
    }

    return { giftTargets: tgt, giftShade: sample.shade, burstVel: vel, explodedEnd: exEnd };
  }, [giftImg, count, position]);
  const { textTargets, scatter, cluster, curveX, curveY, delays, randoms, hues } = useMemo(() => {
    const samples = sampleGlyphPoints('考研上岸', {
      width: 1400,
      height: 380,
      fontSize: 240,
      // 站酷快乐体：新媒体/电商设计里最典型的「网感」字体，手绘俏皮、辨识度高
      fontFamily: kuaiLe
        ? '"ZCOOLKuaiLe", "LiuJianMaoCao", "LongCang", "KaiTi", serif'
        : '"KaiTi", serif',
      step: 1.4,
    });
    const fit = fitGlyphSamples(samples, 42, 10.5);
    const targets = new Float32Array(count * 3);
    const scat = new Float32Array(count * 3);
    const clus = new Float32Array(count * 3);
    const cx = new Float32Array(count);
    const cy = new Float32Array(count);
    const d = new Float32Array(count);
    const r = new Float32Array(count);
    const h = new Float32Array(count);

    for (let i = 0; i < count; i += 1) {
      const sample = samples[i % samples.length] ?? [600, 160];
      targets[i * 3] = position[0] + (sample[0] - fit.cx) * fit.scale + (Math.random() - 0.5) * 0.4;
      targets[i * 3 + 1] = position[1] + TEXT_Y_OFFSET - (sample[1] - fit.cy) * fit.scale + (Math.random() - 0.5) * 0.35;
      targets[i * 3 + 2] = position[2] + (Math.random() - 0.5) * 2.0;

      // 四面八方的球面散布 —— «从四面八方»
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const radius = 11 + Math.random() * 25;
      scat[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      scat[i * 3 + 1] = radius * Math.cos(phi) * 0.85 - 2;
      scat[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta) - 3;

      // 起始时聚在树的核心（散开前一瞬）
      clus[i * 3] = scat[i * 3] * 0.06;
      clus[i * 3 + 1] = scat[i * 3 + 1] * 0.06 - 1;
      clus[i * 3 + 2] = scat[i * 3 + 2] * 0.06;

      // 飞行路径的轻微弧度，避免直线机械感
      const angle = Math.random() * Math.PI * 2;
      cx[i] = Math.cos(angle);
      cy[i] = Math.sin(angle);
      // 幂律星等分布：大量微星 + 少数亮星，vertex 里的尺寸公式据此形成层次
      r[i] = Math.pow(Math.random(), 2.6);
      // 全霓虹渐变：青→蓝→紫→粉随横向位置流动，5% 粒子撞色橙金 —— 网感海报的标配
      const nx = THREE.MathUtils.clamp((sample[0] - fit.cx) / 24.5 + 0.5, 0, 1);
      let hue = 0.52 + nx * 0.4;
      if (Math.random() < 0.05) hue = 0.09 + Math.random() * 0.05;
      h[i] = hue + (Math.random() - 0.5) * 0.035;

      // skill 原则 1：时间按 √路径长度加权并封顶
      const dist = Math.hypot(
        scat[i * 3] - targets[i * 3],
        scat[i * 3 + 1] - targets[i * 3 + 1],
        scat[i * 3 + 2] - targets[i * 3 + 2],
      );
      const weight = Math.min(Math.sqrt(dist) / 7, 1);
      // skill 原则 2：起笔重叠 —— 多组粒子并行推进，而非一个接一个
      d[i] = weight * 0.55 + r[i] * 0.28;
    }
    return {
      textTargets: targets,
      scatter: scat,
      cluster: clus,
      curveX: cx,
      curveY: cy,
      delays: d,
      randoms: r,
      hues: h,
    };
  }, [position, longCang, liujian, kuaiLe]);

  const positions = useMemo(() => Float32Array.from(cluster), [cluster]);

  /* ---- 「圣诞礼物」字幕星光：礼盒成形时从盒顶升起汇聚成字，礼盒爆开时随之炸散消失 ---- */
  const capCount = 2400;
  const capAttrRef = useRef<THREE.BufferAttribute>(null);
  const capMatRef = useRef<any>(null);
  const cap = useMemo(() => {
    const n = capCount;
    const start = new Float32Array(n * 3);
    const tgt = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    const rr = new Float32Array(n);
    const hh = new Float32Array(n);
    const dd = new Float32Array(n);
    const shade = new Float32Array(n);
    const cx0 = position[0], cy0 = position[1] + TITLE_Y_OFFSET, cz0 = position[2] + 2;
    // 字幕横向居中悬在上方；礼盒已左移，两者错开不重合
    const capCx = cx0, capCy = cy0 + 16.2, capCz = cz0 + 1.2;

    // Cormorant 意大利斜体：优雅艺术字但基线规整（DancingScript 连笔起伏太歪）
    const samples = cormorant
      ? sampleGlyphPoints('The gifts for you', {
          width: 1800,
          height: 400,
          fontSize: 280,
          fontFamily: '"CormorantItalic", Georgia, serif',
          step: 1.4,
        })
      : [];
    const ok = samples.length > 0;
    const fit = ok ? fitGlyphSamples(samples, 19, 4.2) : { scale: 1, cx: 0, cy: 0 };

    const BASE = 26;   // 字幕爆散基础初速
    for (let i = 0; i < n; i += 1) {
      const s = samples[i % samples.length] ?? [500, 150];
      tgt[i * 3] = capCx + (s[0] - fit.cx) * fit.scale + (Math.random() - 0.5) * 0.14;
      tgt[i * 3 + 1] = capCy - (s[1] - fit.cy) * fit.scale + (Math.random() - 0.5) * 0.12;
      tgt[i * 3 + 2] = capCz + (Math.random() - 0.5) * 0.8;
      // 起点：左移后的礼盒顶部区域——星光像是从盒子里「升」出来的
      start[i * 3] = cx0 - 6.5 + (Math.random() - 0.5) * 13;
      start[i * 3 + 1] = cy0 - 1.2 + 3 + Math.random() * 4;
      start[i * 3 + 2] = cz0 + (Math.random() - 0.5) * 5;
      // 爆散速度：从字幕中心径向飞出（与礼盒烟花同款阻尼/下坠）
      let dx = tgt[i * 3] - capCx, dy = tgt[i * 3 + 1] - capCy, dz = (tgt[i * 3 + 2] - capCz) * 0.6;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx = dx / len + (Math.random() - 0.5) * 0.6;
      dy = dy / len + (Math.random() - 0.5) * 0.6;
      dz = dz / len + (Math.random() - 0.5) * 0.4;
      const n2 = Math.hypot(dx, dy, dz) || 1;
      const spd = BASE * (0.55 + Math.random() * 0.75);
      vel[i * 3] = (dx / n2) * spd;
      vel[i * 3 + 1] = (dy / n2) * spd;
      vel[i * 3 + 2] = (dz / n2) * spd;
      rr[i] = Math.pow(Math.random(), 2.2);
      dd[i] = rr[i] * 0.3;
      // 金色微渐变：暖金到琥珀，和礼盒白金配色呼应
      hh[i] = 0.09 + Math.random() * 0.05;
      shade[i] = 0.3;
    }
    return { start, tgt, vel, rr, hh, dd, shade, ok };
  }, [cormorant, position]);
  const capPositions = useMemo(() => Float32Array.from(cap.start), [cap]);

  useFrame((state, delta) => {
    if (active && startRef.current === null) startRef.current = state.clock.elapsedTime;
    if (!active) {
      startRef.current = null;
      completedRef.current = false; // 下次触发可再次复位
    }

    const t = startRef.current === null ? 0 : state.clock.elapsedTime - startRef.current;
    // 字幕时间锚点：礼盒开始汇聚 0.25s 后字幕开始升字
    const capT0 = WISH_T.GIFT_START + 0.25;
    const capTau = t - WISH_T.GIFT_BURST;
    const burst = EASE_OUT(t / BURST_END);
    // 文字成形瞬间被流星点亮；礼物成形与炸开时星光也短暂脉冲增亮
    const meteorFlash = Math.pow(Math.max(0, 1 - Math.abs(t - METEOR_AT) / 0.6), 2) * 0.6;
    const giftFormFlash = Math.pow(Math.max(0, 1 - Math.abs(t - (WISH_T.GIFT_START + WISH_T.GIFT_DUR + 0.4)) / 0.6), 2) * 0.4;
    const giftFlash = Math.pow(Math.max(0, 1 - Math.abs(t - WISH_T.GIFT_BURST - 0.2) / 0.7), 2) * 0.7;
    const flash = Math.max(meteorFlash, giftFlash, giftFormFlash);

    for (let i = 0; i < count; i += 1) {
      const i3 = i * 3;
      let x: number;
      let y: number;
      let z: number;

      if (t < BURST_END) {
        // 圣诞树「突然」散开成细小星光
        x = THREE.MathUtils.lerp(cluster[i3], scatter[i3], burst);
        y = THREE.MathUtils.lerp(cluster[i3 + 1], scatter[i3 + 1], burst);
        z = THREE.MathUtils.lerp(cluster[i3 + 2], scatter[i3 + 2], burst);
      } else if (t < WISH_T.GIFT_START + WISH_T.GIFT_DUR + 0.35) {
        // 散开的星光四面汇聚，组成中央的礼物（窗口覆盖最大延迟，晚到粒子不会被瞬移）
        const g = (t - WISH_T.GIFT_START - delays[i] * 0.35) / WISH_T.GIFT_DUR;
        const ge = SINE_EASE(g);
        const arc = Math.sin(ge * Math.PI) * (1.2 + randoms[i] * 2.4);
        x = THREE.MathUtils.lerp(scatter[i3], giftTargets[i3], ge) + curveX[i] * arc;
        y = THREE.MathUtils.lerp(scatter[i3 + 1], giftTargets[i3 + 1], ge) + curveY[i] * arc;
        z = THREE.MathUtils.lerp(scatter[i3 + 2], giftTargets[i3 + 2], ge);
      } else if (t < WISH_T.GIFT_BURST) {
        // 礼物成形后短暂停留：星光在原位轻轻呼吸（漂移从 0 渐入，避免相位切换跳变）
        const ramp = SMOOTH((t - (WISH_T.GIFT_START + WISH_T.GIFT_DUR + 0.35)) / 0.4);
        const dx = Math.sin(t * 3.0 + i * 0.03) * 0.16 * ramp;
        const dy = Math.sin(t * 2.4 + i * 0.05) * 0.14 * ramp;
        x = giftTargets[i3] + dx;
        y = giftTargets[i3 + 1] + dy;
        z = giftTargets[i3 + 2] + dx * 0.5;
      } else if (t < WISH_T.GIFT_BURST + WISH_T.EXPLODE_DUR) {
        // 烟花式爆开：径向初速球壳飞出，阻尼减速 + 轻微下坠；
        // 呼吸漂移在前 0.25s 内衰减清零，与停留段无缝衔接
        const tau = Math.max(0, t - WISH_T.GIFT_BURST);
        const drag = (1 - Math.exp(-2.2 * tau)) / 2.2;
        const dFade = Math.max(0, 1 - tau / 0.25);
        x = giftTargets[i3] + burstVel[i3] * drag + Math.sin(t * 3.0 + i * 0.03) * 0.16 * dFade;
        y = giftTargets[i3 + 1] + burstVel[i3 + 1] * drag - 0.45 * tau * tau
          + Math.sin(t * 2.4 + i * 0.05) * 0.14 * dFade;
        z = giftTargets[i3 + 2] + burstVel[i3 + 2] * drag;
      } else {
        // 从烟花实时位置（阻尼已饱和、下坠封顶）拉向文字 —— 起点连续，无顿挫
        const f = (t - ASSEMBLE_START - delays[i]) / ASSEMBLE_DUR;
        const fe = SINE_EASE(f);
        const tau = t - WISH_T.GIFT_BURST;
        const te = Math.min(tau, WISH_T.EXPLODE_DUR);
        const drag = (1 - Math.exp(-2.2 * te)) / 2.2;
        const ex = giftTargets[i3] + burstVel[i3] * drag;
        const ey = giftTargets[i3 + 1] + burstVel[i3 + 1] * drag - 0.45 * te * te;
        const ez = giftTargets[i3 + 2] + burstVel[i3 + 2] * drag;
        const arc = Math.sin(fe * Math.PI) * (1.4 + randoms[i] * 2.6);
        x = THREE.MathUtils.lerp(ex, textTargets[i3], fe) + curveX[i] * arc;
        y = THREE.MathUtils.lerp(ey, textTargets[i3 + 1], fe) + curveY[i] * arc;
        z = THREE.MathUtils.lerp(ez, textTargets[i3 + 2], fe);
      }

      positions[i3] = x;
      positions[i3 + 1] = y;
      positions[i3 + 2] = z;
    }

    // 「圣诞礼物」字幕星光动画
    for (let i = 0; i < capCount; i += 1) {
      const i3 = i * 3;
      let cx2: number;
      let cy2: number;
      let cz2: number;
      if (t < WISH_T.GIFT_BURST) {
        // 从盒顶升空汇聚成字（带弧线），成形后轻微呼吸
        const cf = SINE_EASE((t - capT0 - cap.dd[i]) / 1.05);
        const arc = Math.sin(cf * Math.PI) * (0.6 + cap.rr[i] * 1.2);
        cx2 = THREE.MathUtils.lerp(cap.start[i3], cap.tgt[i3], cf) + curveX[i] * arc;
        cy2 = THREE.MathUtils.lerp(cap.start[i3 + 1], cap.tgt[i3 + 1], cf) + curveY[i] * arc;
        cz2 = THREE.MathUtils.lerp(cap.start[i3 + 2], cap.tgt[i3 + 2], cf);
        if (cf >= 1) {
          const ramp = SMOOTH((t - capT0 - 1.05) / 0.4);
          cx2 += Math.sin(t * 2.6 + i * 0.05) * 0.1 * ramp;
          cy2 += Math.sin(t * 2.2 + i * 0.07) * 0.09 * ramp;
        }
      } else {
        // 礼盒爆开瞬间：字幕也径向炸散 + 下坠，随淡出消失
        const tau = Math.max(0, capTau);
        const drag = (1 - Math.exp(-2.2 * tau)) / 2.2;
        cx2 = cap.tgt[i3] + cap.vel[i3] * drag;
        cy2 = cap.tgt[i3 + 1] + cap.vel[i3 + 1] * drag - 0.45 * tau * tau;
        cz2 = cap.tgt[i3 + 2] + cap.vel[i3 + 2] * drag;
      }
      capPositions[i3] = cx2;
      capPositions[i3 + 1] = cy2;
      capPositions[i3 + 2] = cz2;
    }
    if (capAttrRef.current) capAttrRef.current.needsUpdate = true;

    if (attributeRef.current) attributeRef.current.needsUpdate = true;
    if (materialRef.current) {
      const time = state.clock.elapsedTime;
      materialRef.current.uTime = time;
      materialRef.current.uSize = 152;
      materialRef.current.uFlash = flash;
      // 礼物成形→停留→炸开期间启用礼物配色（丝带高亮/盒面压暗），炸开后恢复文字配色
      materialRef.current.uGiftMix = active && t >= WISH_T.GIFT_START && t < WISH_T.GIFT_BURST + 0.35
        ? SINE_EASE((t - WISH_T.GIFT_START) / 0.5) * (1 - SINE_EASE((t - WISH_T.GIFT_BURST) / 0.5))
        : 0;
      // 全程保持星光亮度，礼物与文字都由这批星光构成；停留结束后平缓淡出，
      // 确保复位回树时粒子已不可见、无跳变
      let opacityTarget = !active ? 0 : 0.98;
      if (active && t >= ASCEND_START) {
        const at = clamp01((t - ASCEND_START) / ASCEND_DUR);
        opacityTarget *= 1 - SMOOTH(at / 0.85);
      }
      materialRef.current.uOpacity = THREE.MathUtils.damp(
        materialRef.current.uOpacity,
        opacityTarget,
        3.5,
        delta,
      );
    }
    // 结尾闭环：飘散（+照片淡出）完成，回调 App 复位回圣诞树（只触发一次）
    const resetAt = photoUrl ? PHOTO_RESET_AT : RESET_AT;
    if (active && t >= resetAt && !completedRef.current) {
      completedRef.current = true;
      onCompleteRef.current?.();
    }
    if (capMatRef.current) {
      capMatRef.current.uTime = state.clock.elapsedTime;
      capMatRef.current.uSize = 118;
      capMatRef.current.uFlash = flash * 0.55;
      capMatRef.current.uGiftMix = 0; // 字幕保持金色，不走礼盒配色
      // 淡入（礼盒成形时升字）→ 礼盒爆开时同步淡出消失
      const capIn = SINE_EASE((t - capT0) / 0.55);
      const capOut = capTau > 0 ? Math.max(0, 1 - capTau / 0.85) : 1;
      capMatRef.current.uOpacity = cap.ok && active ? 0.92 * capIn * capOut : 0;
    }

  });

  return (
    <>
      <points>
        <bufferGeometry>
          <bufferAttribute ref={attributeRef} attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-aRandom" args={[randoms, 1]} />
          <bufferAttribute attach="attributes-aHue" args={[hues, 1]} />
          <bufferAttribute attach="attributes-aGiftShade" args={[giftShade, 1]} />
        </bufferGeometry>
        {/* @ts-ignore */}
        <starPointsMaterial
          ref={materialRef}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          uOpacity={0}
          uColorMix={0.95}
        />
      </points>

      {/* 「圣诞礼物」字幕星光：礼盒成形时升字，礼盒爆开时消失 */}
      <points>
        <bufferGeometry>
          <bufferAttribute ref={capAttrRef} attach="attributes-position" args={[capPositions, 3]} />
          <bufferAttribute attach="attributes-aRandom" args={[cap.rr, 1]} />
          <bufferAttribute attach="attributes-aHue" args={[cap.hh, 1]} />
          <bufferAttribute attach="attributes-aGiftShade" args={[cap.shade, 1]} />
        </bufferGeometry>
        {/* @ts-ignore */}
        <starPointsMaterial
          ref={capMatRef}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          uOpacity={0}
          uColorMix={0.95}
        />
      </points>

      {/* 组装完成后：流星掠过 + 氛围流星 */}
      <MeteorShower active={active} startRef={startRef} position={position} />

      {/* 横版海报下半部分：斜体英文日期 + 一行小字，流星掠过后依次浮现 */}
      <GlowCaption
        active={active}
        startRef={startRef}
        text={DATE_TEXT}
        fontReady={cormorant}
        appearAt={METEOR_AT + 0.75}
        worldWidth={24}
        x={position[0]}
        y={position[1] - 7.0}
        z={position[2] + 0.4}
        opacity={0.92}
        fontSize={128}
        letterSpacing={2}
        withRules
        exitAt={ASCEND_START}
      />
      <GlowCaption
        active={active}
        startRef={startRef}
        text={TAGLINE_TEXT}
        fontReady={cormorant}
        appearAt={METEOR_AT + 1.15}
        worldWidth={17}
        x={position[0]}
        y={position[1] - 10.8}
        z={position[2] + 0.4}
        opacity={0.72}
        fontSize={108}
        letterSpacing={9}
        exitAt={ASCEND_START}
      />
      {/* 上岸照片：与文字同框，在其上方浮现，一起停留后同步淡出（未上传则不渲染） */}
      {photoUrl ? (
        <WishPhoto active={active} startRef={startRef} url={photoUrl} position={position} />
      ) : null}
      {/* 三幕人物星光画：文字散去后依次呈现（答题 → 过圣诞 → 录取通知书），散场回树 */}
      <WishScenes active={active} startRef={startRef} position={position} />
    </>
  );
}
