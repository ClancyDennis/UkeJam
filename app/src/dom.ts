// Small DOM helpers shared across views.

/// Escape text for interpolation into an innerHTML template. Song titles,
/// artist names, track names and coach text all come from files the user
/// supplied or a model wrote, so none of it can be trusted as markup.
export function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/// Scroll `el` into view by moving ONLY `scroller` — never its ancestors.
///
/// scrollIntoView() has no "just this container" mode: it walks every scrollable
/// ancestor, and boxes with overflow:hidden are still programmatically
/// scrollable. On the Play screen that walk scrolled .song-bar and (on
/// WKWebView, where a grid row isn't clamped to the band's max-height)
/// .bottom-band itself — clipped containers with no scrollbar, so the panel
/// titles stayed sliced off until the next song load. Positioning the one
/// intended scroller by hand is the whole fix.
///
/// "nearest" matches scrollIntoView({block:"nearest"}): no movement when fully
/// visible, minimal movement otherwise. "center" keeps `el` mid-view.
export function scrollWithin(
  scroller: HTMLElement,
  el: HTMLElement,
  block: "nearest" | "center" = "nearest"
): void {
  const sr = scroller.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  // element's position in the scroller's content coordinates
  const top = er.top - sr.top + scroller.scrollTop;
  const bottom = top + er.height;
  const viewTop = scroller.scrollTop;
  const viewBottom = viewTop + scroller.clientHeight;
  if (block === "center") {
    scroller.scrollTop = top - (scroller.clientHeight - er.height) / 2;
    return;
  }
  if (top >= viewTop && bottom <= viewBottom) return; // already fully visible
  scroller.scrollTop =
    top < viewTop
      ? top // scroll up just enough
      : bottom - scroller.clientHeight; // scroll down just enough
}
