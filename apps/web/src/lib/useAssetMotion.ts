import { type RefObject, useEffect, useRef } from "react";

/** Only the artwork moves: purchase controls keep stable, immediately usable hit targets. */
function trackPointer(card: HTMLElement): () => void {
  let frame = 0;
  let clientX = 0;
  let clientY = 0;
  const reset = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    delete card.dataset.pointer;
    for (const name of ["--art-x", "--art-y", "--light-x", "--light-y"]) {
      card.style.removeProperty(name);
    }
  };
  const paint = () => {
    frame = 0;
    const rect = card.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    card.style.setProperty("--art-x", `${(x - 0.5) * 8}deg`);
    card.style.setProperty("--art-y", `${(0.5 - y) * 6}deg`);
    card.style.setProperty("--light-x", `${x * 100}%`);
    card.style.setProperty("--light-y", `${y * 100}%`);
    card.dataset.pointer = "active";
  };
  const move = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    clientX = event.clientX;
    clientY = event.clientY;
    if (!frame) frame = requestAnimationFrame(paint);
  };
  card.addEventListener("pointermove", move, { passive: true });
  card.addEventListener("pointerleave", reset);
  card.addEventListener("pointercancel", reset);
  return () => {
    reset();
    card.removeEventListener("pointermove", move);
    card.removeEventListener("pointerleave", reset);
    card.removeEventListener("pointercancel", reset);
  };
}

/** Progressive enhancement: nothing is hidden while waiting for the observer (or without it). */
function revealArtwork(card: HTMLElement): () => void {
  if (!("IntersectionObserver" in window)) return () => {};
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      card.dataset.revealed = "true";
      observer.disconnect();
    },
    { threshold: 0, rootMargin: "0px 0px 24px 0px" },
  );
  observer.observe(card);
  return () => {
    observer.disconnect();
    delete card.dataset.revealed;
  };
}

export function useAssetMotion(): RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const card = ref.current;
    if (!card) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const pointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    let stopPointer: (() => void) | undefined;
    let stopReveal: (() => void) | undefined;
    const sync = () => {
      stopPointer?.();
      stopPointer = undefined;
      if (reduced.matches) {
        stopReveal?.();
        stopReveal = undefined;
        return;
      }
      stopReveal ??= revealArtwork(card);
      if (pointer.matches) stopPointer = trackPointer(card);
    };
    sync();
    reduced.addEventListener("change", sync);
    pointer.addEventListener("change", sync);
    return () => {
      stopPointer?.();
      stopReveal?.();
      reduced.removeEventListener("change", sync);
      pointer.removeEventListener("change", sync);
    };
  }, []);
  return ref;
}
