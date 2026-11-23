// 「考研上岸」过场声音：背景主题曲（public/audio/wish_theme.mp3）。
// 主题曲用 <audio> 流式播放，避免解码 7MB/184s 的开销。

const THEME_SRC = '/audio/wish_theme.mp3';
const THEME_VOLUME = 0.55;

let themeAudio: HTMLAudioElement | null = null;
let themeUnlocked = false;

// 1 秒静音 WAV，仅用来在用户手势里解锁自动播放策略；绝不碰主题曲本身。
// （之前用主题曲 play() 再异步 pause() 解锁，那个 pause 会和正式播放竞态，把音乐掐掉。）
const SILENT_WAV =
  'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA';

function ensureThemeAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!themeAudio) {
    themeAudio = new Audio(THEME_SRC);
    themeAudio.preload = 'auto';
    themeAudio.loop = false;
    themeAudio.volume = THEME_VOLUME;
  }
  return themeAudio;
}

// 必须在用户手势（点击手势控制 / 音效开关 / 触发动画）中调用，满足浏览器自动播放策略。
export function initWishAudio() {
  if (typeof window === 'undefined') return;
  if (!themeUnlocked) {
    themeUnlocked = true;
    try {
      const probe = new Audio(SILENT_WAV);
      probe.volume = 0;
      const p = probe.play();
      if (p) void p.catch(() => undefined);
    } catch {
      // 忽略：部分浏览器仍会在动画触发时的手势里放行
    }
  }
}

// 复位 / 关闭声音时立即掐断主题曲，并倒回开头。
export function stopWishAudio() {
  if (themeAudio) {
    themeAudio.pause();
    try {
      themeAudio.currentTime = 0;
    } catch {
      // 元数据尚未加载时设置 currentTime 会抛错，忽略
    }
  }
}

// 播放主题曲。调用前请确保 initWishAudio() 已在用户手势中跑过。
export function playWishSoundtrack() {
  initWishAudio();
  stopWishAudio(); // 防止连发时两段音叠在一起（同时会把主题曲倒回开头）

  // 主题曲从头播放，直到复位回树时由 stopWishAudio 掐断
  const audio = ensureThemeAudio();
  if (audio) {
    audio.volume = THEME_VOLUME;
    try {
      void audio.play().catch(() => {
        // 自动播放被拒（通常是还没建立用户手势）：重置解锁标志，
        // 让用户下次点「音效 / 手势控制」按钮时重新执行静音探针解锁。
        themeUnlocked = false;
      });
    } catch {
      themeUnlocked = false;
    }
  }
}
