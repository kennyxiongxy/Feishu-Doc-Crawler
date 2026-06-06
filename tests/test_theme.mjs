// tests/test_theme.mjs — 主题逻辑单元测试（v5.9）
// 跑法：node tests/test_theme.mjs
//
// 测 popup/theme.js 的纯函数：resolveInitialTheme / resolveNextTheme /
// themeButtonIcon / themeButtonLabel。

import {
  resolveInitialTheme,
  resolveNextTheme,
  themeButtonIcon,
  themeButtonLabel,
} from '../popup/theme.js';

let passed = 0;
let failed = 0;

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}\n      expected: ${e}\n      actual:   ${a}`); }
}

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ ' + msg); }
}

function section(name) { console.log(`\n[${name}]`); }

// ============================================================
// resolveInitialTheme — 用户偏好 vs 系统偏好
// ============================================================
section('resolveInitialTheme: user pref overrides system');
assertEq(resolveInitialTheme('light', 'light'), 'light', 'saved light + system light → light');
assertEq(resolveInitialTheme('light', 'dark'), 'light', 'saved light + system dark → light (user wins)');
assertEq(resolveInitialTheme('dark', 'light'), 'dark', 'saved dark + system light → dark (user wins)');
assertEq(resolveInitialTheme('dark', 'dark'), 'dark', 'saved dark + system dark → dark');

section('resolveInitialTheme: no saved pref → follow system');
assertEq(resolveInitialTheme(null, 'light'), 'light', 'null + system light → light');
assertEq(resolveInitialTheme(null, 'dark'), 'dark', 'null + system dark → dark');
assertEq(resolveInitialTheme(undefined, 'light'), 'light', 'undefined + system light → light');
assertEq(resolveInitialTheme(undefined, 'dark'), 'dark', 'undefined + system dark → dark');

section('resolveInitialTheme: invalid saved pref → follow system (graceful)');
assertEq(resolveInitialTheme('', 'light'), 'light', 'empty string + system light → light');
assertEq(resolveInitialTheme('auto', 'dark'), 'dark', '"auto" + system dark → dark (treated as invalid)');
assertEq(resolveInitialTheme('LARK-CLAW', 'light'), 'light', 'garbage + system light → light');
assertEq(resolveInitialTheme(42, 'dark'), 'dark', 'non-string + system dark → dark');

// ============================================================
// resolveNextTheme — 点击切换
// ============================================================
section('resolveNextTheme: light <-> dark toggle');
assertEq(resolveNextTheme('light'), 'dark', 'light → dark');
assertEq(resolveNextTheme('dark'), 'light', 'dark → light');
assertEq(resolveNextTheme('unknown'), 'light', 'unknown → light (graceful default)');
assertEq(resolveNextTheme(null), 'light', 'null → light (graceful default)');

// Idempotent cycle: light → dark → light → dark → light
{
  const seq = ['light', 'dark', 'light', 'dark', 'light'];
  let cur = 'light';
  for (let i = 1; i < seq.length; i++) {
    cur = resolveNextTheme(cur);
    assertEq(cur, seq[i], `cycle step ${i}: ${seq[i-1]} → ${seq[i]}`);
  }
}

// ============================================================
// themeButtonIcon — 图标显示"点击后变成什么"
// ============================================================
section('themeButtonIcon: shows what click WILL do');
assertEq(themeButtonIcon('light'), '🌙', 'in light: shows moon (click to go dark)');
assertEq(themeButtonIcon('dark'), '☀️', 'in dark: shows sun (click to go light)');
{
  // Invariant: button icon's symbol represents the FUTURE theme
  // (sun=light/day, moon=dark/night — icon previews the destination)
  const cur = 'light';
  const icon = themeButtonIcon(cur);
  const iconTheme = icon === '☀️' ? 'light' : icon === '🌙' ? 'dark' : null;
  assertEq(iconTheme, 'dark', 'icon represents the destination (light → moon → dark)');
}

// ============================================================
// themeButtonLabel — 屏幕阅读器可访问性
// ============================================================
section('themeButtonLabel: aria-label for accessibility');
assert(themeButtonLabel('light').includes('深色'), 'light label mentions 深色');
assert(themeButtonLabel('dark').includes('浅色'), 'dark label mentions 浅色');
assert(themeButtonLabel('light') !== themeButtonLabel('dark'), 'labels differ per theme');

// ============================================================
// 集成：theme 持久化往返
// ============================================================
section('Integration: theme persistence roundtrip');
{
  // 模拟：第一次启动（无 storage）→ 跟随系统
  let theme = resolveInitialTheme(null, 'dark');
  assertEq(theme, 'dark', 'first launch with system dark → dark');

  // 用户点击切换
  theme = resolveNextTheme(theme);
  assertEq(theme, 'light', 'click → light');

  // 模拟存储写入后再次启动（storage 现在是 'light'）
  const saved = 'light';
  theme = resolveInitialTheme(saved, 'dark');  // 系统改回 dark，但用户偏好仍是 light
  assertEq(theme, 'light', 'subsequent launch: saved light overrides system dark');

  // 用户再次点击
  theme = resolveNextTheme(theme);
  assertEq(theme, 'dark', 'click again → dark');

  // 写入 storage
  const newSaved = theme;
  // 模拟系统变成 light
  theme = resolveInitialTheme(newSaved, 'light');
  assertEq(theme, 'dark', 'saved dark overrides system light');
}

// ============================================================
// Summary
// ============================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
