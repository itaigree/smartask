/**
 * A ref for the board's sticky header. It keeps the page's scroll padding
 * equal to the header's height, so moving keyboard focus back up the page
 * scrolls the focused control clear of the header rather than under it. The
 * height is measured, not fixed in CSS: the header's controls wrap onto a
 * second row on narrow phones, a larger font makes it taller, and a save
 * error is shown inside it.
 *
 * A plain function, so React attaches it once rather than on every render.
 */
export function trackHeaderHeight(header: HTMLElement | null) {
  if (!header) return;
  const root = document.documentElement;
  const observer = new ResizeObserver(() => {
    // Zero while the board is hidden behind AI settings: fall back to the CSS default.
    if (header.offsetHeight) root.style.setProperty('--header-height', `${header.offsetHeight}px`);
    else root.style.removeProperty('--header-height');
  });
  observer.observe(header);
  return () => {
    observer.disconnect();
    root.style.removeProperty('--header-height');
  };
}
