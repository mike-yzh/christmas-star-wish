export type SceneState = 'CHAOS' | 'FORMED' | 'FOCUS';
export type TextEffect = 'none' | 'merry' | 'wish';

// --- 手势控制配置 ---
export const GESTURE_CONFIG = {
  confidenceThreshold: 0.65,  // 置信度阈值（减少误识别）
  rotationDeadZone: 0.03,     // 旋转死区（减少颤抖）
  rotationSensitivity: 0.15,  // X轴旋转灵敏度
  pitchSensitivity: 0.1,      // Y轴俯仰灵敏度
  pitchDeadZone: 0.03,        // 俯仰死区
};

// --- 动态生成照片列表 (1.jpg ~ 6.jpg) ---
export const TOTAL_NUMBERED_PHOTOS = 6;
// 6.jpg 是竖幅照片，其他都是正方形
export const PORTRAIT_PHOTO_INDEX = 5; // 对应 6.jpg (0-indexed)
export const bodyPhotoPaths = Array.from(
  { length: TOTAL_NUMBERED_PHOTOS },
  (_, i) => `/photos/${i + 1}.jpg`
);

// --- 视觉配置 ---
export const CONFIG = {
  colors: {
    emerald: '#BFEFFF',
    gold: '#DFF7FF',
    silver: '#FFFFFF',
    red: '#8FD8FF',
    green: '#D6F5FF',
    white: '#FFFFFF',
    warmLight: '#BFEFFF',
    lights: ['#BFEFFF', '#FFFFFF', '#7FD4FF', '#E8FBFF'],
    borders: ['#EAF9FF', '#CFEEFF', '#FFFFFF', '#B8E6FF', '#DFF7FF', '#A9DEFF', '#F2FDFF'],
    giftColors: ['#9AD8FF', '#DFF7FF', '#7AB8FF', '#FFFFFF'],
    candyColors: ['#DFF7FF', '#8FD8FF'],
  },
  counts: {
    foliage: 15000,
    ornaments: 12, // 6张照片 × 2个 = 12个装饰品
    elements: 200,
    lights: 400,
  },
  tree: { height: 22, radius: 9 },
  photos: {
    body: bodyPhotoPaths,
  },
} as const;

