/**
 * qm-icons.mjs — line icons for the navigation (customer tabs, staff sidebars and tab bars).
 *
 * The 3.1 screens draw their nav icons as text symbols (⌂ ＋ ☰ ☺ ☻ ▦ …), which look playful
 * and say little about the page. The hash-checked 3.1 files stay unchanged: build.mjs turns this
 * map into CSS that hides the symbol and paints the icon (CSS mask, so it takes the text colour —
 * active, hover and disabled states keep working).
 *
 * Drawn for this project on a 24×24 grid: 2 px strokes, round caps and joins, no fill.
 */
export const NAV_ICONS = {
  // customer
  'c-home': 'M3 10.5 12 3l9 7.5M5 9v12h14V9M10 21v-6h4v6',
  'c-new': 'M7 7h12l-3.5-3.5M17 17H5l3.5 3.5',
  'c-orders': 'M8 4h8v3H8zM6 5.5H5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-1M8 12h8M8 16h5',
  'c-profile': 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1.4-3.8 4.5-6 8-6s6.6 2.2 8 6',

  // dashboards
  'a-home': 'M4 3h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3h6a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 12h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zM4 16h6a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z',
  // operations
  'a-tradeins': 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
  'a-collections': 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  'a-settlements': 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 12h.01M18 12h.01',
  // catalogue
  'a-pricing': 'M3 3h9l9 9-9 9-9-9zM7.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  'a-products': 'M12 3 2 8l10 5 10-5zM2 12.5l10 5 10-5M2 17l10 5 10-5',
  'a-brands': 'M12 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM8.5 14 7 22l5-3 5 3-1.5-8',
  'a-categories': 'M4 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM15 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM4 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zM15 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z',
  'a-import': 'M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
  'a-grades': 'M5 20v-5M10 20v-9M15 20V7M20 20V3M3 20h18',
  'a-inspection': 'M8 4h8v3H8zM6 5.5H5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-1M8.5 14l2.5 2.5 4.5-4.5',
  // marketplace
  'a-vendors': 'M5 3h14a1 1 0 0 1 1 1v17H4V4a1 1 0 0 1 1-1zM9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M10 21v-3h4v3',
  'a-branches': 'M12 21s-7-6-7-11.5a7 7 0 0 1 14 0C19 15 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  'a-commission': 'M19 5 5 19M7 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  // people
  'a-staff': 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .8 3.2 2.6 3.8 5.2',
  'a-customers': 'M4.5 5h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM9 13.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM5.5 17c.7-1.6 2-2.5 3.5-2.5s2.8.9 3.5 2.5M15 10h4M15 14h3',
  // system
  'a-reports': 'M21 12a9 9 0 1 1-9-9v9zM15 3.5A9 9 0 0 1 20.5 9H15z',
  'a-audit': 'M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5M12 7v5l3 2',
  'a-settings': 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',

  // technician
  't-queue': 'M3 6l2 2 3-3M3 13l2 2 3-3M12 6.5h9M12 13.5h9M12 19.5h9M4.5 19.5h.01',
  't-offers': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  't-receive': 'M12 3v10M8 9l4 4 4-4M3 14h5l1.5 3h5L16 14h5v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  't-returns': 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',

  // partner (vendor)
  'v-vouchers': 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4zM14 5v2M14 11v2M14 17v2',
};
// Same meaning, same icon.
Object.assign(NAV_ICONS, {
  'v-home': NAV_ICONS['a-home'], 'v-queue': NAV_ICONS['a-tradeins'], 'v-branches': NAV_ICONS['a-branches'],
  'v-staff': NAV_ICONS['a-staff'], 'v-settlements': NAV_ICONS['a-settlements'], 'v-reports': NAV_ICONS['a-reports'],
});

/** CSS that replaces each nav symbol with its icon (mask in the current text colour). */
export function navIconCss() {
  const svg = (d) => `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`)}")`;
  const rules = Object.entries(NAV_ICONS).map(([page, d]) => {
    const sel = `[data-page="${page}"] > .icon::before,[data-tab="${page}"] > .icon::before`;
    return `${sel}{-webkit-mask-image:${svg(d)};mask-image:${svg(d)}}`;
  });
  const all = Object.keys(NAV_ICONS).flatMap((p) => [`[data-page="${p}"] > .icon`, `[data-tab="${p}"] > .icon`]).join(',');
  return [
    `${all}{font-size:0!important;line-height:0;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:0 0 20px}`,
    `${all.split(',').map((s) => `${s}::before`).join(',')}{content:"";width:20px;height:20px;background:currentColor;` +
      `-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;-webkit-mask-size:contain;mask-size:contain}`,
    ...rules,
  ].join('\n');
}
