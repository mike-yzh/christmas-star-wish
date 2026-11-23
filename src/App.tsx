import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';

import { type SceneState, type TextEffect, bodyPhotoPaths } from './config';
import type { TreeCanvasHandle } from './TreeCanvas';
import { initWishAudio, playWishSoundtrack, stopWishAudio } from './wishAudio';

const TreeCanvas = lazy(() => import('./TreeCanvas'));
const GestureController = lazy(() => import('./GestureController'));

// 默认自动旋转速度（弧度/帧）
const AUTO_ROTATION_SPEED = 0.0009;

export default function GrandTreeApp() {
  const [sceneState, setSceneState] = useState<SceneState>('FORMED');
  const [textEffect, setTextEffect] = useState<TextEffect>('merry');
  const [rotationSpeed, setRotationSpeed] = useState(0);
  const [pitchSpeed, setPitchSpeed] = useState(0);
  const [aiStatus, setAiStatus] = useState('AI: OFF');
  const [debugMode, setDebugMode] = useState(false);
  const [gestureEnabled, setGestureEnabled] = useState(false);
  const [showScene, setShowScene] = useState(false);
  const [isUserInteracting, setIsUserInteracting] = useState(false);
  const [showGestureHint, setShowGestureHint] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);

  // 聚焦相关状态 - 使用 textureIndex (0-5) 而非 ornamentIndex (0-11)
  const [focusedTextureIndex, setFocusedTextureIndex] = useState<number>(-1);
  const [previousState, setPreviousState] = useState<'CHAOS' | 'FORMED'>('FORMED');
  const [isMobile, setIsMobile] = useState(false);

  // TreeCanvas ref 用于获取最近照片索引
  const treeCanvasRef = useRef<TreeCanvasHandle | null>(null);

  // 用户上传的照片（压缩后的 data URL，存 localStorage 刷新不丢）
  const PHOTO_STORAGE_KEY = 'christmas-tree-memories';
  const [userPhotos, setUserPhotos] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(PHOTO_STORAGE_KEY);
      return saved ? (JSON.parse(saved) as string[]) : [];
    } catch {
      return [];
    }
  });
  // 用户上传的照片直接替换默认示例照：有上传就只挂自己的照片
  const photoUrls = userPhotos.length ? userPhotos : bodyPhotoPaths;
  const photoCount = photoUrls.length;
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 「上岸照片」：单独一张，考研上岸动画结尾浮现，独立于挂树照片
  const WISH_PHOTO_KEY = 'christmas-wish-photo';
  const [wishPhoto, setWishPhoto] = useState<string | null>(() => {
    try { return localStorage.getItem(WISH_PHOTO_KEY); } catch { return null; }
  });
  const wishPhotoInputRef = useRef<HTMLInputElement | null>(null);

  // 图片压缩：最长边 640px、JPEG 0.78，避免多张照片撑爆 localStorage
  const compressImage = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read failed'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('decode failed'));
        img.onload = () => {
          const max = 640;
          const ratio = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * ratio));
          canvas.height = Math.max(1, Math.round(img.height * ratio));
          const ctx = canvas.getContext('2d');
          if (!ctx) return reject(new Error('canvas failed'));
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.78));
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    });

  const handlePhotoUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      try {
        const encoded = await Promise.all(files.map(compressImage));
        setUserPhotos(() => {
          // 有旧照片时先清空再放入新上传的 —— 实现「替换」而非累加
          const next = encoded.slice(0, 20); // 上限 20 张，保护存储空间
          try {
            localStorage.setItem(PHOTO_STORAGE_KEY, JSON.stringify(next));
          } catch {
            // 存储超限时静默保留本次会话的照片
          }
          return next;
        });
      } finally {
        e.target.value = '';
      }
    },
    [],
  );

  // 上传「上岸照片」（单张，压缩后存 localStorage）
  const handleWishPhotoUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = Array.from(e.target.files ?? []).find((f) => f.type.startsWith('image/'));
      if (!file) return;
      try {
        const encoded = await compressImage(file);
        setWishPhoto(encoded);
        try { localStorage.setItem(WISH_PHOTO_KEY, encoded); } catch { /* 存储超限时仅保留本次会话 */ }
      } finally {
        e.target.value = '';
      }
    },
    [],
  );

  const clearWishPhoto = useCallback(() => {
    setWishPhoto(null);
    try { localStorage.removeItem(WISH_PHOTO_KEY); } catch { /* ignore */ }
  }, []);

  // 引导弹窗状态
  const [showGuide, setShowGuide] = useState(false);

  // 滑动手势相关
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // 移动端检测
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(
        navigator.maxTouchPoints > 0 ||
        window.matchMedia('(max-width: 768px)').matches
      );
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // 引导弹窗改为点击右上角「?」手动打开，避免遮挡首屏画面

  const closeGuide = useCallback(() => {
    setShowGuide(false);
    localStorage.setItem('christmas-tree-guide-seen', 'true');
  }, []);

  // 打开帮助弹窗
  const openGuide = useCallback(() => {
    setShowGuide(true);
  }, []);

  // 进入聚焦模式
  const enterFocusMode = useCallback((textureIndex: number) => {
    if (sceneState === 'FOCUS') {
      // 已在 FOCUS 模式，直接切换到新照片
      setFocusedTextureIndex(textureIndex);
      return;
    }
    setPreviousState(sceneState as 'CHAOS' | 'FORMED');
    setFocusedTextureIndex(textureIndex);
    setSceneState('FOCUS');
    setRotationSpeed(0);
  }, [sceneState]);

  // 退出聚焦模式
  const exitFocusMode = useCallback(() => {
    if (sceneState !== 'FOCUS') return;
    setSceneState(previousState);
    setFocusedTextureIndex(-1);
  }, [sceneState, previousState]);

  // 下一张照片 - 纯循环
  const nextPhoto = useCallback(() => {
    if (sceneState !== 'FOCUS' || focusedTextureIndex === -1) return;
    setFocusedTextureIndex((prev) => (prev + 1) % photoCount);
  }, [sceneState, focusedTextureIndex, photoCount]);

  // 上一张照片 - 纯循环
  const prevPhoto = useCallback(() => {
    if (sceneState !== 'FOCUS' || focusedTextureIndex === -1) return;
    setFocusedTextureIndex((prev) => (prev - 1 + photoCount) % photoCount);
  }, [sceneState, focusedTextureIndex, photoCount]);

  // 触发「考研上岸」星光动画：树散星 → 礼盒 → 字幕 → 烟花 → 文字
  const triggerWish = useCallback(() => {
    if (textEffect === 'wish') return; // 动画进行中不重复触发
    if (soundEnabled) playWishSoundtrack();
    setFocusedTextureIndex(-1);
    setSceneState('CHAOS');
    setTextEffect('wish');
  }, [textEffect, soundEnabled]);

  // 停留结束（文字淡出+照片淡出）后自动复位回圣诞树，并停止主题曲
  const handleWishComplete = useCallback(() => {
    stopWishAudio();
    setSceneState('FORMED');
    setTextEffect('merry');
  }, []);

  // 手势回调 - 支持更多手势
  type GestureType = SceneState | 'NEXT_PHOTO' | 'PREV_PHOTO' | 'ENTER_FOCUS' | 'WISH';
  const handleGesture = useCallback((gesture: GestureType, nearestTextureIndex?: number) => {
    // 「以下犯上」双手手势 → 触发考研上岸动画（最高优先级，任何模式下都能触发）
    if (gesture === 'WISH') {
      triggerWish();
      return;
    }

    // 无论当前在什么模式，如果是直接的粒子状态指令，都直接切换
    if (gesture === 'CHAOS' || gesture === 'FORMED') {
      if (sceneState === 'FOCUS') {
        setFocusedTextureIndex(-1);
      }
      setSceneState(gesture);
      return;
    }

    if (gesture === 'ENTER_FOCUS') {
      // ☝️ Pointing_Up 进入聚焦
      if (sceneState !== 'FOCUS' && nearestTextureIndex !== undefined && nearestTextureIndex >= 0) {
        enterFocusMode(nearestTextureIndex);
      }
      return;
    }

    if (sceneState === 'FOCUS') {
      // FOCUS 模式下的手势处理
      if (gesture === 'NEXT_PHOTO') nextPhoto(); // 👎 下一张
      if (gesture === 'PREV_PHOTO') prevPhoto(); // 👍 上一张
      return;
    }
  }, [sceneState, enterFocusMode, nextPhoto, prevPhoto, triggerWish]);

  // 手势移动回调 - FOCUS 模式下忽略
  const handleMove = useCallback((speed: number) => {
    if (sceneState === 'FOCUS' || textEffect === 'wish') return;
    setRotationSpeed(speed);
    // 当手势控制有输入时，标记用户正在交互
    setIsUserInteracting(speed !== 0);
  }, [sceneState, textEffect]);

  // 手势俯仰回调 - FOCUS / 考研上岸动画下忽略
  const handlePitch = useCallback((speed: number) => {
    if (sceneState === 'FOCUS' || textEffect === 'wish') return;
    setPitchSpeed(speed);
  }, [sceneState, textEffect]);

  // 计算最终旋转速度：FOCUS 与考研上岸动画锁定单一视角
  const cameraLocked = sceneState === 'FOCUS' || textEffect === 'wish';
  const effectiveRotationSpeed = cameraLocked
    ? 0
    : (gestureEnabled && isUserInteracting ? rotationSpeed : AUTO_ROTATION_SPEED);

  // 计算最终俯仰速度
  const effectivePitchSpeed = cameraLocked
    ? 0
    : (gestureEnabled ? pitchSpeed : 0);

  // 获取最近照片索引的回调（供 GestureController 使用）
  const getNearestPhotoIndex = useCallback(() => {
    return treeCanvasRef.current?.getNearestPhotoIndex() ?? 0;
  }, []);

  // 键盘事件处理
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (sceneState !== 'FOCUS') return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        nextPhoto();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prevPhoto();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        exitFocusMode();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sceneState, nextPhoto, prevPhoto, exitFocusMode]);

  // 触屏滑动手势
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (sceneState !== 'FOCUS') return;
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  }, [sceneState]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (sceneState !== 'FOCUS' || !touchStartRef.current) return;
    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStartRef.current.x;
    const deltaY = touch.clientY - touchStartRef.current.y;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);

    const SWIPE_THRESHOLD = 50;

    if (absDeltaY > absDeltaX && deltaY > SWIPE_THRESHOLD) {
      // 下滑退出
      exitFocusMode();
    } else if (absDeltaX > absDeltaY && absDeltaX > SWIPE_THRESHOLD) {
      if (deltaX < 0) {
        // 左滑 → 下一张
        nextPhoto();
      } else {
        // 右滑 → 上一张
        prevPhoto();
      }
    }
    touchStartRef.current = null;
  }, [sceneState, nextPhoto, prevPhoto, exitFocusMode]);

  // 组件卸载时停止音效，避免离开页面后仍有声音
  useEffect(() => () => stopWishAudio(), []);

  useEffect(() => {
    const enable = () => setShowScene(true);

    const requestIdleCallback = (window as any).requestIdleCallback as
      | undefined
      | ((cb: () => void, opts?: { timeout: number }) => number);
    const cancelIdleCallback = (window as any).cancelIdleCallback as undefined | ((id: number) => void);

    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(enable, { timeout: 1500 });
      return () => cancelIdleCallback?.(id);
    }

    const id = window.setTimeout(enable, 0);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (gestureEnabled) {
      setAiStatus('INITIALIZING...');
      // 首次启用时显示手势提示
      setShowGestureHint(true);
      // 5秒后自动隐藏
      const timer = setTimeout(() => setShowGestureHint(false), 5000);
      return () => clearTimeout(timer);
    } else {
      setAiStatus('AI: OFF');
      setRotationSpeed(0);
      setPitchSpeed(0);
      setDebugMode(false);
      setIsUserInteracting(false);
      setShowGestureHint(false);
    }
  }, [gestureEnabled]);

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        backgroundColor: '#020616',
        position: 'relative',
        overflow: 'hidden',
      }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          position: 'absolute',
          top: 0,
          left: 0,
          zIndex: 1,
        }}
      >
        {showScene ? (
          <Suspense fallback={null}>
            <TreeCanvas
              ref={treeCanvasRef}
              isMobile={isMobile}
              sceneState={sceneState}
              effect={textEffect}
              rotationSpeed={effectiveRotationSpeed}
              pitchSpeed={effectivePitchSpeed}
              focusedTextureIndex={focusedTextureIndex}
              onPhotoClick={enterFocusMode}
              onExitFocus={exitFocusMode}
              onWishComplete={handleWishComplete}
              wishPhotoUrl={wishPhoto}
              photoUrls={photoUrls}
            />
          </Suspense>
        ) : null}
      </div>

      {gestureEnabled ? (
        <Suspense fallback={null}>
          <GestureController
            onGesture={handleGesture}
            onMove={handleMove}
            onPitch={handlePitch}
            onStatus={setAiStatus}
            debugMode={debugMode}
            sceneState={sceneState}
            getNearestPhotoIndex={getNearestPhotoIndex}
          />
        </Suspense>
      ) : null}

      {/* 虚拟方向键 - 桌面端 FOCUS 模式显示 */}
      {sceneState === 'FOCUS' && !isMobile && (
        <>
          <button
            onClick={prevPhoto}
            style={{
              position: 'absolute',
              left: '40px',
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 20,
              width: '60px',
              height: '60px',
              borderRadius: '50%',
              backgroundColor: 'rgba(0,0,0,0.5)',
              border: '1px solid rgba(159, 232, 255, 0.42)',
              color: '#9FE8FF',
              fontSize: '24px',
              cursor: 'pointer',
              backdropFilter: 'blur(4px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            aria-label="上一张"
          >
            &lt;
          </button>
          <button
            onClick={nextPhoto}
            style={{
              position: 'absolute',
              right: '40px',
              top: '50%',
              transform: 'translateY(-50%)',
              zIndex: 20,
              width: '60px',
              height: '60px',
              borderRadius: '50%',
              backgroundColor: 'rgba(0,0,0,0.5)',
              border: '1px solid rgba(159, 232, 255, 0.42)',
              color: '#9FE8FF',
              fontSize: '24px',
              cursor: 'pointer',
              backdropFilter: 'blur(4px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            aria-label="下一张"
          >
            &gt;
          </button>
        </>
      )}

      {/* UI - Top Bar */}
      <div
        style={{
          position: 'absolute',
          top: '20px',
          left: '40px',
          right: '40px',
          zIndex: 10,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        {/* Author Credit & Help */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <div
            style={{
              color: '#888',
              fontFamily: 'sans-serif',
              fontSize: '12px',
            }}
          >
            by 小ye
          </div>
          <button
            onClick={openGuide}
            style={{
              padding: '6px 12px',
              backgroundColor: 'rgba(0,0,0,0.5)',
              border: '1px solid rgba(159, 232, 255, 0.36)',
              borderRadius: '4px',
              color: 'rgba(159, 232, 255, 0.72)',
              fontFamily: 'sans-serif',
              fontSize: '11px',
              cursor: 'pointer',
              backdropFilter: 'blur(4px)',
            }}
          >
            ?
          </button>
        </div>

        {/* Buttons */}
        <div
          style={{
            display: 'flex',
            gap: '10px',
            alignItems: 'center',
          }}
        >
          {/* ADD MEMORIES：上传自己的照片挂到树上（GitHub 同款） */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={handlePhotoUpload}
          />
          {/* 上岸照片：考研上岸动画结尾浮现的单张照片 */}
          <input
            ref={wishPhotoInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleWishPhotoUpload}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{
              padding: '12px 15px',
              backgroundColor: 'rgba(232,197,106,0.16)',
              border: '1px solid rgba(232,197,106,0.7)',
              color: '#F3D98F',
              fontFamily: 'sans-serif',
              fontSize: '12px',
              fontWeight: 'bold',
              cursor: 'pointer',
              backdropFilter: 'blur(4px)',
            }}
          >
            ADD MEMORIES {userPhotos.length ? `· 已替换 ${userPhotos.length} 张 ✓` : ''}
          </button>
          {userPhotos.length > 0 && (
            <button
              onClick={() => {
                setUserPhotos([]);
                try { localStorage.removeItem(PHOTO_STORAGE_KEY); } catch { /* ignore */ }
              }}
              style={{
                padding: '12px 12px',
                backgroundColor: 'rgba(4,14,30,0.55)',
                border: '1px solid rgba(232,197,106,0.4)',
                color: 'rgba(243,217,143,0.8)',
                fontFamily: 'sans-serif',
                fontSize: '11px',
                cursor: 'pointer',
                backdropFilter: 'blur(4px)',
              }}
            >
              恢复示例
            </button>
          )}
          {/* 上岸照片：考研上岸动画结尾浮现的单张照片 */}
          <button
            onClick={() => wishPhotoInputRef.current?.click()}
            style={{
              padding: '12px 15px',
              backgroundColor: wishPhoto ? 'rgba(159,232,255,0.22)' : 'rgba(4,14,30,0.55)',
              border: '1px solid rgba(159,232,255,0.65)',
              color: '#9FE8FF',
              fontFamily: 'sans-serif',
              fontSize: '12px',
              fontWeight: 'bold',
              cursor: 'pointer',
              backdropFilter: 'blur(4px)',
            }}
          >
            {wishPhoto ? '上岸照片 ✓' : '＋ 上岸照片'}
          </button>
          {wishPhoto && (
            <button
              onClick={clearWishPhoto}
              title="移除上岸照片"
              style={{
                padding: '12px 12px',
                backgroundColor: 'rgba(4,14,30,0.55)',
                border: '1px solid rgba(159,232,255,0.4)',
                color: 'rgba(159,232,255,0.8)',
                fontFamily: 'sans-serif',
                fontSize: '11px',
                cursor: 'pointer',
                backdropFilter: 'blur(4px)',
              }}
            >
              移除
            </button>
          )}
          {/* AI Status */}
          <div
            style={{
              color: aiStatus.includes('ERROR') ? '#FF0000' : 'rgba(159, 232, 255, 0.36)',
              fontSize: '10px',
              letterSpacing: '2px',
              background: 'rgba(0,0,0,0.5)',
              padding: '4px 8px',
              borderRadius: '4px',
              marginRight: '10px',
            }}
          >
            {aiStatus}
          </div>
          {/* 音效开关：主题曲，可一键静音 */}
          <button
            onClick={() => {
              if (soundEnabled) stopWishAudio();
              else initWishAudio(); // 用户手势中解锁 AudioContext
              setSoundEnabled((v) => !v);
            }}
            style={{
              padding: '12px 15px',
              backgroundColor: soundEnabled ? 'rgba(232,197,106,0.22)' : 'rgba(4,14,30,0.55)',
              border: '1px solid rgba(232,197,106,0.6)',
              color: '#F3D98F',
              fontFamily: 'sans-serif',
              fontSize: '12px',
              fontWeight: 'bold',
              cursor: 'pointer',
              backdropFilter: 'blur(4px)',
            }}
          >
            {soundEnabled ? '♪ 音效 开' : '♪ 音效 关'}
          </button>
          <button
            onClick={() => {
              if (!gestureEnabled) initWishAudio(); // 在用户手势中解锁音频，满足浏览器自动播放策略
              setGestureEnabled((v) => !v);
            }}
            style={{
              padding: '12px 15px',
              backgroundColor: gestureEnabled ? '#9FE8FF' : 'rgba(4,14,30,0.55)',
              border: '1px solid rgba(159,232,255,0.55)',
              color: gestureEnabled ? '#001018' : '#9FE8FF',
              fontFamily: 'sans-serif',
              fontSize: '12px',
              fontWeight: 'bold',
              cursor: 'pointer',
              backdropFilter: 'blur(4px)',
            }}
          >
            {gestureEnabled ? '手势控制 开' : '手势控制 关'}
          </button>
          {/* DEBUG 按钮 - 移动端隐藏 */}
          {!isMobile && (
            <button
              onClick={() => setDebugMode((v) => !v)}
              disabled={!gestureEnabled}
              style={{
                padding: '12px 15px',
                backgroundColor: debugMode ? '#9FE8FF' : 'rgba(4,14,30,0.55)',
                border: '1px solid rgba(159,232,255,0.55)',
                color: debugMode ? '#001018' : '#9FE8FF',
                fontFamily: 'sans-serif',
                fontSize: '12px',
                fontWeight: 'bold',
                cursor: gestureEnabled ? 'pointer' : 'not-allowed',
                opacity: gestureEnabled ? 1 : 0.5,
                backdropFilter: 'blur(4px)',
              }}
            >
              {debugMode ? '隐藏调试' : '调试'}
            </button>
          )}
          <button
            onClick={() => {
              if (sceneState === 'FOCUS') {
                exitFocusMode();
              } else {
                setSceneState((s) => (s === 'CHAOS' ? 'FORMED' : 'CHAOS'));
              }
            }}
            style={{
              padding: '12px 30px',
              backgroundColor: 'rgba(0,0,0,0.5)',
              border: '1px solid rgba(159, 232, 255, 0.42)',
              color: '#9FE8FF',
              fontFamily: 'serif',
              fontSize: '14px',
              backdropFilter: 'blur(4px)',
            }}
          >
            {sceneState === 'FOCUS' ? '退出聚焦' : sceneState === 'CHAOS' ? '聚合成树' : '散开'}
          </button>
        </div>
      </div>

      {/* 文字特效按钮 - 聚焦看照片时隐藏，避免干扰 */}
      <div
        style={{
          position: 'absolute',
          bottom: '24px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 20,
          display: sceneState === 'FOCUS' ? 'none' : 'flex',
          gap: '12px',
        }}
      >
        <button
          onClick={() => {
            if (textEffect === 'wish') stopWishAudio(); // 中途复位时掐断动画配音
            if (textEffect === 'merry') {
              setTextEffect('none');
            } else {
              setSceneState('FORMED');
              setTextEffect('merry');
            }
          }}
          style={{
            padding: '12px 24px',
            backgroundColor: textEffect === 'merry' ? '#9FE8FF' : 'rgba(4,14,30,0.55)',
            border: '1px solid rgba(159,232,255,0.55)',
            color: textEffect === 'merry' ? '#001018' : '#9FE8FF',
            fontFamily: 'serif',
            fontSize: '14px',
            cursor: 'pointer',
            backdropFilter: 'blur(4px)',
          }}
        >
          MERRY CHRISTMAS
        </button>
        {/* 考研上岸改由「以下犯上」双手手势触发（需开启手势控制），不再单独放点击按钮 */}
      </div>

      {/* 手势提示 UI - 启用手势控制时显示 */}
      {showGestureHint && (
        <div
          style={{
            position: 'fixed',
            bottom: '100px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 50,
            backgroundColor: 'rgba(4, 14, 30, 0.92)',
            border: '1px solid rgba(159, 232, 255, 0.42)',
            borderRadius: '12px',
            padding: '16px 24px',
            backdropFilter: 'blur(10px)',
            boxShadow: '0 0 20px rgba(120, 200, 255, 0.22)',
            animation: 'fadeIn 0.3s ease-out',
          }}
          onClick={() => setShowGestureHint(false)}
        >
          <div
            style={{
              color: '#9FE8FF',
              fontFamily: 'sans-serif',
              fontSize: '14px',
              fontWeight: 'bold',
              marginBottom: '12px',
              textAlign: 'center',
            }}
          >
            手势控制
          </div>
          <div
            style={{
              color: '#fff',
              fontFamily: 'sans-serif',
              fontSize: '13px',
              lineHeight: 1.8,
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '4px 12px',
            }}
          >
            <span>🖐️</span><span>张开手掌 → 散开粒子</span>
            <span>✊</span><span>握拳 → 聚合成树</span>
            <span>☝️</span><span>竖食指 → 查看照片</span>
            <span>👍</span><span>大拇指 → 切换照片</span>
            <span>👇👆</span><span>以下犯上 → 考研上岸</span>
          </div>
          <div
            style={{
              color: 'rgba(255, 255, 255, 0.5)',
              fontFamily: 'sans-serif',
              fontSize: '11px',
              marginTop: '10px',
              textAlign: 'center',
            }}
          >
            点击关闭
          </div>
        </div>
      )}

      {/* 引导弹窗 */}
      {showGuide && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
          onClick={closeGuide}
        >
          <div
            style={{
              backgroundColor: 'rgba(4, 14, 30, 0.95)',
              border: '1px solid rgba(159, 232, 255, 0.42)',
              borderRadius: '12px',
              padding: isMobile ? '24px 20px' : '40px 50px',
              maxWidth: isMobile ? '90%' : '580px',
              width: isMobile ? 'auto' : '580px',
              backdropFilter: 'blur(10px)',
              boxShadow: '0 0 40px rgba(120, 200, 255, 0.22)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              style={{
                color: '#9FE8FF',
                fontFamily: 'serif',
                fontSize: isMobile ? '20px' : '28px',
                marginBottom: isMobile ? '20px' : '28px',
                textAlign: 'center',
                letterSpacing: '2px',
              }}
            >
              {isMobile ? '操作指南' : '操作指南'}
            </h2>

            {isMobile ? (
              // 移动端内容
              <div style={{ color: '#fff', fontFamily: 'sans-serif', fontSize: '14px', lineHeight: 1.8 }}>
                <div style={{ marginBottom: '16px' }}>
                  <div style={{ color: '#9FE8FF', marginBottom: '8px', fontWeight: 'bold' }}>基础操作</div>
                  <div>点击右上角按钮切换圣诞树状态</div>
                  <div>点击照片进入聚焦浏览</div>
                </div>
                <div style={{ marginBottom: '16px' }}>
                  <div style={{ color: '#9FE8FF', marginBottom: '8px', fontWeight: 'bold' }}>照片浏览</div>
                  <div>← 左滑：下一张</div>
                  <div>→ 右滑：上一张</div>
                  <div>↓ 下滑：退出聚焦</div>
                </div>
                <div>
                  <div style={{ color: '#9FE8FF', marginBottom: '8px', fontWeight: 'bold' }}>手势控制（可选）</div>
                  <div>👇👆 以下犯上：双手食指中指并拢伸直、其余弯曲，一手朝上一手朝下，触发「考研上岸」动画</div>
                  <div>✋ / ✊：散开 / 聚合圣诞树</div>
                </div>
              </div>
            ) : (
              // 桌面端内容
              <div style={{ color: '#fff', fontFamily: 'sans-serif', fontSize: '16px', lineHeight: 2 }}>
                <div style={{ marginBottom: '20px' }}>
                  <div style={{ color: '#9FE8FF', marginBottom: '10px', fontWeight: 'bold', fontSize: '17px' }}>基础操作</div>
                  <div>点击右上角按钮切换圣诞树状态</div>
                  <div>点击照片进入聚焦浏览</div>
                </div>
                <div style={{ marginBottom: '20px' }}>
                  <div style={{ color: '#9FE8FF', marginBottom: '10px', fontWeight: 'bold', fontSize: '17px' }}>照片浏览</div>
                  <div>← → 方向键：切换照片</div>
                  <div>ESC：退出聚焦</div>
                  <div>或点击左右两侧的导航按钮</div>
                </div>
                <div>
                  <div style={{ color: '#9FE8FF', marginBottom: '10px', fontWeight: 'bold', fontSize: '17px' }}>手势控制（可选）</div>
                  <div>👇👆 <strong>以下犯上</strong>：双手食指与中指并拢伸直、其余手指弯曲，一手朝上、一手朝下，两手靠拢保持约 0.6 秒 → 触发「考研上岸」星光动画</div>
                  <div>✋ 张开手掌：散开粒子　✊ 握拳：聚合成树</div>
                  <div>☝️ 指向上：进入聚焦　👍 大拇指：切换照片</div>
                  <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: '14px', marginTop: '6px' }}>动画会播放主题曲，右上角「♪ 音效」可开关；考研上岸文字散去后依次呈现七幕星光画面（答题 → 吃火锅 → 过圣诞 → 回家过年 → 返校 → 面试 → 录取通知书），每幕约 4 秒，约 44 秒后自动回树、音乐停止</div>
                  <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: '14px', marginTop: '6px' }}>「考研上岸」上方会浮现你的照片、下方划过流星，随后自动恢复圣诞树；点右上角「＋ 上岸照片」上传</div>
                </div>
              </div>
            )}

            <button
              onClick={closeGuide}
              style={{
                marginTop: isMobile ? '24px' : '32px',
                width: '100%',
                padding: isMobile ? '12px 24px' : '14px 28px',
                backgroundColor: '#9FE8FF',
                border: 'none',
                borderRadius: '6px',
                color: '#001018',
                fontFamily: 'sans-serif',
                fontSize: isMobile ? '14px' : '16px',
                fontWeight: 'bold',
                cursor: 'pointer',
              }}
            >
              开始体验
            </button>

            {/* AI 生成声明 */}
            <div
              style={{
                marginTop: '16px',
                textAlign: 'center',
                color: 'rgba(255, 255, 255, 0.4)',
                fontSize: isMobile ? '10px' : '11px',
                fontFamily: 'sans-serif',
                lineHeight: 1.5,
              }}
            >
              Images are generated by Google AI Model Gemini-3-pro-image-preview (Nanobanana Pro). If any content seems inappropriate, please{' '}
              <a
                href="https://kenxiao.netlify.app/"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'rgba(159, 232, 255, 0.6)', textDecoration: 'none' }}
              >
                contact me
              </a>
              .
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
