/** Can this browser draw the 3D scenes, and is it a machine that should get the lighter version?
 *  Everything 3D is decoration: when either answer is "no" the page shows its flat picture instead, and nothing is lost. */

let cached: boolean | null = null;

export function canUseWebGL(): boolean {
  if (cached !== null) return cached;
  try {
    if (typeof document === "undefined" || typeof window === "undefined") return (cached = false);
    const canvas = document.createElement("canvas");
    // jsdom (the test runner) has no getContext implementation worth the name: treat it as "no WebGL".
    const gl = canvas.getContext?.("webgl2") ?? canvas.getContext?.("webgl");
    cached = Boolean(gl);
  } catch {
    cached = false;
  }
  return cached;
}

/** Few cores or little memory: fewer particles, smaller canvas, no antialiasing. Never refuses to draw, only draws less. */
export function isLowPower(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { deviceMemory?: number };
  return (nav.hardwareConcurrency ?? 8) <= 4 || (nav.deviceMemory ?? 8) <= 4;
}

/** Test hook: forget the cached answer. */
export function resetWebGLCache(): void {
  cached = null;
}
