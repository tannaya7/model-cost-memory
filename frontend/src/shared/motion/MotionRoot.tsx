/** Tells the stylesheet whether motion is full or calm (html[data-motion]), so every CSS-only effect follows the same switch as the 3D scenes. */
import { useEffect } from "react";
import { useMotion } from "./useMotion";

export function MotionRoot() {
  const { calm } = useMotion();
  useEffect(() => {
    document.documentElement.dataset.motion = calm ? "calm" : "full";
  }, [calm]);
  return null;
}
