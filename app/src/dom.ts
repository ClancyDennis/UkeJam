// Small DOM helpers shared across views.

/// Escape text for interpolation into an innerHTML template. Song titles,
/// artist names, track names and coach text all come from files the user
/// supplied or a model wrote, so none of it can be trusted as markup.
export function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
