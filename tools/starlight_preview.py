# -*- coding: utf-8 -*-
"""把三幕设计稿渲染成星光点阵预览图：
模拟最终网页效果——深蓝夜空背景上，画面由数千颗金色/白色星光粒子汇聚而成。
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

GEN_DIR = r"C:\Users\admin\WorkBuddy\2026-11-22-11-56-41\generated-images"
OUT_DIR = os.path.join(GEN_DIR, "starlight-preview")
os.makedirs(OUT_DIR, exist_ok=True)

SCENES = [
    ("提取图中戴圆框眼镜_深蓝色头发_穿蓝色毛衣的男孩形象_保持完_2026-11-23T10-39-19.png", "scene1_starlight.png", 0),
    ("提取图中戴圆框眼镜_深蓝色头发男孩的形象_保持完全一致的面部_2026-11-23T10-39-49.png", "scene2_starlight.png", 0),
    # 第三幕：裁掉底部 8%（去除 AI 生成水印）
    ("保持这幅画_completely_不变_男孩圆框眼镜_笑容__2026-11-23T10-46-11.png", "scene3_starlight.png", 0.08),
]

STAR_COUNT = 7000   # 每幅画的星光粒子数（与网页礼盒/文字粒子量级一致）
rng = np.random.default_rng(20261123)

# 暖金色系（与网页星光配色一致）：暖白 / 金 / 琥珀
PALETTE = [
    (255, 246, 220),  # 暖白
    (255, 231, 160),  # 金
    (255, 205, 112),  # 琥珀
    (255, 214, 160),  # 暖金
]


def star_points_from_image(img: Image.Image):
    """从设计稿采样星光粒子：内容区域权重高，轮廓边缘额外加权（勾边更清晰）。"""
    img = img.convert("RGB").resize((640, 960))
    a = np.asarray(img).astype(np.float32)
    # 背景=浅蓝/浅米色（高亮度低饱和），内容=深色或高饱和
    lum = a.mean(axis=2)
    sat = a.max(axis=2) - a.min(axis=2)
    dark_w = np.clip((200 - lum) / 120, 0, 1)          # 深色线条/头发/衣服
    sat_w = np.clip((sat - 30) / 110, 0, 1)            # 彩色区域（红毛衣、绿树、金铃铛）
    # 轮廓检测：与四邻域差分越大越贴近边缘（五官/眼镜/证书边/树轮廓）
    edge = np.zeros_like(lum)
    edge[1:, :] = np.maximum(edge[1:, :], np.abs(np.diff(lum, axis=0)))
    edge[:, 1:] = np.maximum(edge[:, 1:], np.abs(np.diff(lum, axis=1)))
    edge = np.clip((edge - 6) / 30, 0, 1)
    w = dark_w * 0.45 + sat_w * 0.5 + edge * 2.6
    w[lum > 232] *= 0.06                                # 纯背景几乎不采样
    w = w ** 1.1
    total = w.sum()
    if total <= 0:
        raise RuntimeError("no content")
    p = (w / total).ravel()
    idx = rng.choice(p.size, size=STAR_COUNT, replace=True, p=p)
    ys, xs = np.unravel_index(idx, w.shape)
    # 像素内抖动，让边缘不那么栅格化
    xs = xs + rng.random(STAR_COUNT) - 0.5
    ys = ys + rng.random(STAR_COUNT) - 0.5
    # 亮度等级：10% 的粒子特别亮（模拟大颗星）
    bright = rng.random(STAR_COUNT) < 0.10
    # 按原图颜色决定星色偏白还是偏金：接近原图色相，再混入暖金基调
    cols = a[np.clip(ys.astype(int), 0, 959), np.clip(xs.astype(int), 0, 639)]
    # 把原图色映射到金/白色系：亮度越高越白，饱和度高偏暖金
    mix = rng.random(STAR_COUNT)
    base_gold = np.array(PALETTE)[rng.integers(0, len(PALETTE), STAR_COUNT)]
    whitish = np.clip(cols.mean(axis=1, keepdims=True) / 255.0, 0, 1)
    cols_out = (base_gold * (0.55 + 0.45 * whitish)).astype(int)
    return xs, ys, bright, cols_out


def render(xs, ys, bright, cols_out, out_path):
    W, H = 640, 960
    SCALE = 2
    W2, H2 = W * SCALE, H * SCALE
    img = Image.new("RGB", (W2, H2), (6, 14, 34))       # 深蓝夜空
    draw = ImageDraw.Draw(img)

    # 背景微弱环境星（远处小星星，营造夜空）
    for _ in range(260):
        bx, by = rng.random() * W2, rng.random() * H2
        r = rng.random() * 1.1
        c = int(120 + rng.random() * 90)
        draw.ellipse([bx - r, by - r, bx + r, by + r], fill=(c, c, min(255, c + 25)))

    order = rng.permutation(STAR_COUNT)
    for k in order:
        x, y = xs[k] * SCALE, ys[k] * SCALE
        r = (2.6 if bright[k] else 1.0 + rng.random() * 0.9) * SCALE * 0.55
        c = tuple(np.clip(cols_out[k] * (1.25 if bright[k] else 1.0), 0, 255).astype(int))
        # 光晕（大而淡）+ 星核（小而亮）
        glow_r = r * 3.2
        glow_c = tuple((np.array(c) * 0.22).astype(int))
        draw.ellipse([x - glow_r, y - glow_r, x + glow_r, y + glow_r], fill=glow_c)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=c)
        # 最亮的几颗加十字光芒
        if bright[k] and rng.random() < 0.5:
            arm = r * 2.6
            draw.line([x - arm, y, x + arm, y], fill=c, width=1)
            draw.line([x, y - arm, x, y + arm], fill=c, width=1)

    # 轻微模糊叠底，制造弥散辉光（弱一点避免糊掉轮廓）
    blur = img.filter(ImageFilter.GaussianBlur(3))
    final = Image.blend(img, blur, 0.16)
    final = Image.blend(img, final, 0.35)
    final.save(out_path)
    print("saved", out_path)


for src, out, crop_bottom in SCENES:
    img = Image.open(os.path.join(GEN_DIR, src))
    if crop_bottom > 0:
        w, h = img.size
        img = img.crop((0, 0, w, int(h * (1 - crop_bottom))))
    pts = star_points_from_image(img)
    render(*pts, os.path.join(OUT_DIR, out))

print("all done")
