import { useEffect } from "react";

const SELECTOR = ".ss-section, .ss-med, .ss-row, .ss-detail, .ss-allclear";
const STEP_MS = 60;
const MAX_DELAY_MS = 480;
const DONE_MS = 1400; // reveal (700ms) + step-number pops in .ss-detail

/**
 * Scroll-reveal for the patient UI. Tags matching elements with `ss-rv`,
 * then `ss-in` once they enter the viewport. Siblings stagger via `--d`.
 * After the reveal settles the classes are removed so the elements' own
 * hover transforms/transitions are not overridden.
 */
export function useReveal(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduced =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const seen = new WeakSet<Element>();
    const timers = new Set<number>();

    const settle = (el: HTMLElement, delay: number) => {
      const t = window.setTimeout(() => {
        timers.delete(t);
        el.classList.remove("ss-rv", "ss-in");
        el.style.removeProperty("--d");
      }, delay + DONE_MS);
      timers.add(t);
    };

    const io =
      !reduced && "IntersectionObserver" in window
        ? new IntersectionObserver(
            (entries) => {
              for (const e of entries) {
                if (!e.isIntersecting) continue;
                const el = e.target as HTMLElement;
                io?.unobserve(el);
                el.classList.add("ss-in");
                settle(el, parseInt(el.style.getPropertyValue("--d"), 10) || 0);
              }
            },
            { threshold: 0.12 },
          )
        : null;

    const register = (el: HTMLElement) => {
      if (seen.has(el)) return;
      seen.add(el);
      if (!io) return; // reduced motion: leave untouched (fully visible)
      const parent = el.parentElement;
      let idx = 0;
      if (parent) {
        for (const sib of Array.from(parent.children)) {
          if (sib === el) break;
          if (sib.matches(SELECTOR)) idx++;
        }
      }
      el.style.setProperty("--d", `${Math.min(idx * STEP_MS, MAX_DELAY_MS)}ms`);
      el.classList.add("ss-rv");
      io.observe(el);
    };

    const scan = (root: ParentNode) => {
      if (root instanceof HTMLElement && root.matches(SELECTOR)) register(root);
      root.querySelectorAll<HTMLElement>(SELECTOR).forEach(register);
    };

    let mo: MutationObserver | null = null;
    let rootEl: Element | null = null;

    const attach = () => {
      rootEl = document.querySelector(".ss");
      if (!rootEl) return false;
      scan(rootEl);
      mo?.disconnect();
      mo = new MutationObserver((records) => {
        for (const r of records)
          r.addedNodes.forEach((n) => {
            if (n instanceof HTMLElement) scan(n);
          });
      });
      mo.observe(rootEl, { childList: true, subtree: true });
      return true;
    };

    // `.ss` may mount after this effect; watch body until it appears.
    let bodyMo: MutationObserver | null = null;
    if (!attach()) {
      bodyMo = new MutationObserver(() => {
        if (attach()) {
          bodyMo?.disconnect();
          bodyMo = null;
        }
      });
      bodyMo.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      bodyMo?.disconnect();
      mo?.disconnect();
      io?.disconnect();
      timers.forEach((t) => window.clearTimeout(t));
      document.querySelectorAll<HTMLElement>(".ss-rv").forEach((el) => {
        el.classList.remove("ss-rv", "ss-in");
        el.style.removeProperty("--d");
      });
    };
  }, []);
}
