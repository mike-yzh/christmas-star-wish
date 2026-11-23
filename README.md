# 🎄✨ 圣诞星光 · 考研上岸（Christmas Star Wish）

一个用 **React + Three.js（R3F）** 打造的单页互动祝福网站：圣诞树由数万颗星光粒子聚合而成，
用双手「以下犯上」手势（👇👆）触发许愿动画——散星成礼盒、烟花绽放、
「考研上岸」星光文字浮现，随后七幅人物画面依次由星光汇聚呈现，最后散场回归圣诞树，
全程主题曲伴奏。

**核心体验**：所有文字与画面都不是贴图，而是**运行时从 Canvas 字形 / 图片采样成粒子**，
由旁侧候场的星光汇聚"画"出来的——成形、停留、散开、切换，全程粒子可感。

## ✨ 功能亮点

- **手势触发**：MediaPipe 手势识别，双手同时比出「以下犯上」（一手 V 指朝下、一手朝上）触发许愿
- **粒子文字**：MERRY CHRISTMAS（花体）/ 考研上岸（书法体）由 Canvas 字形采样成 5000+ 星光粒子
- **七幕星光画**：答题 → 吃火锅 → 过圣诞 → 回家过年 → 一月返校 → 二月面试 → 硕士帽录取通知书
  - 每幅 18000 颗粒子，**轮廓加权采样**（五官、道具边缘的星星更密，画面清晰可辨）
  - 画面边缘密度衰减，自然融入星空、没有"相框"感
  - 尺寸响应式：按相机视锥实时计算，宽覆盖约 80% 视口、横版构图
- **主题曲**：手势触发时播放自定义 mp3，散场回树时停止；右上角 ♪ 可开关
- **上岸照片**：可上传一张照片，与「考研上岸」文字同框浮现（localStorage 本地保存）
- **细节动效**：礼盒烟花爆发、流星雨、字幕浮现、星光闪烁与笔画流动

## 🛠 技术栈

- React 18 + TypeScript + Vite
- Three.js + @react-three/fiber + drei + camera-controls
- 自定义 `shaderMaterial`（additive blending 柔边星光点）
- MediaPipe Tasks Vision（手势识别，本地 wasm + model，无外部请求）
- Canvas 2D 字形/图像采样 + 累积分布函数（CDF）粒子分布
- Web Audio 静音探针解锁自动播放策略（避免 play/pause 竞态掐断音乐）

## 🚀 本地运行

```bash
npm install
npm run dev      # 开发
npm run build    # 构建
npm start        # 预览构建产物（vite preview，监听 $PORT）
```

## 🎵 自定义主题曲

出于版权考虑，仓库**不包含**音乐文件。把你自己拥有的音频命名为
`wish_theme.mp3` 放入 `public/audio/` 即可；文件名或路径可在
`src/wishAudio.ts` 的 `THEME_SRC` 中修改。没有音乐文件时网站正常工作，只是无声。

## 🖼 自定义画面

- `public/scenes/scene1~7.png`：七幕画面底稿（任意宽高比，横版 3:2 观感最佳），
  运行时会自动做轮廓加权采样
- `public/photos/1~6.jpg`：挂在圣诞树上的照片
- 手势定义与阈值：`src/GestureController.tsx`
- 动画时间线（全部以秒为单位的常量表）：`src/wishTimeline.ts`

## 📄 License

[MIT](./LICENSE)

---

*愿每一个赶路的人，都能在某个冬夜看到属于自己的星光。⭐*
