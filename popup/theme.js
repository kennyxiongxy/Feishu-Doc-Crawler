// popup/theme.js — 主题逻辑纯函数（v5.9）
// 与浏览器/Chrome API 解耦，可在 Node 中直接 import 测试。

// 用户偏好：'light' | 'dark' | null（null = 跟随系统）
// 系统偏好：'light' | 'dark'

export function resolveInitialTheme(savedPref, systemPref) {
  if (savedPref === 'light' || savedPref === 'dark') return savedPref;
  return systemPref === 'dark' ? 'dark' : 'light';
}

// 点击切换按钮：light <-> dark
// 对未知值（如 null）默认返回 'light'，符合"亮色是默认"的设计直觉
export function resolveNextTheme(currentTheme) {
  if (currentTheme === 'dark') return 'light';
  if (currentTheme === 'light') return 'dark';
  return 'light';  // unknown / null / 其他 → light 默认
}

// 根据当前主题返回按钮图标（显示\"点击后会变成什么\"）
export function themeButtonIcon(currentTheme) {
  return currentTheme === 'dark' ? '☀️' : '🌙';
}

// 根据当前主题返回按钮 aria-label
export function themeButtonLabel(currentTheme) {
  return currentTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
}
