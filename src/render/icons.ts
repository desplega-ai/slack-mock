// Inline SVG icons for the workspace chrome, the composer and link chips.
// Line icons share one 24px grid and stroke; brand marks are filled paths.

const LINE: Record<string, string> = {
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  compose:
    '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  filter: '<path d="M3 6h18M7 12h10M10 18h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  dms: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 1 1 21 11.5z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  headphones:
    '<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M3 14h3a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2zM21 14h-3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h1a2 2 0 0 0 2-2z"/>',
  emojiPlus:
    '<path d="M21.5 12a9.5 9.5 0 1 1-9-9.5"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M16 5h6M19 2v6"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
  thread:
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 8.5h8M8 12.5h5"/>',
  share: '<path d="m15 17 5-5-5-5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
  bold: '<path d="M7 12h7a4 4 0 0 1 0 8H7zM7 4h6a4 4 0 0 1 0 8H7z"/>',
  italic: '<path d="M19 4h-9M14 20H5M15 4 9 20"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.8 4M14 12a4 4 0 0 1 0 8H6M4 12h16"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  listOrdered: '<path d="M10 6h11M10 12h11M10 18h11M4 4h1v4M4 8h2M6 19H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  listBullet: '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  quote: '<path d="M4 5v14M9 7h11M9 12h11M9 17h7"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  codeBlock:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 10-2 2 2 2M14 10l2 2-2 2"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  format:
    '<path d="M4 17 8.5 6h1L14 17M5.6 13h6.8M17 11.5c1-.9 4-1.2 4 1.2V17m0-3c-1.5-.4-4.5-.3-4.5 1.6 0 2 3.5 1.9 4.5.2M3 21h18"/>',
  video:
    '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
  slash: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 15 6-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  popout:
    '<rect x="8" y="3" width="13" height="13" rx="2"/><path d="M16 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h3"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  canvas:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  task: '<path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8"/>',
  app: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  workflow:
    '<rect x="3" y="3" width="8" height="8" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect x="13" y="13" width="8" height="8" rx="2"/>',
  pullRequest:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12"/>',
  merge:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  issue: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5"/>',
  commit: '<circle cx="12" cy="12" r="3"/><path d="M3 12h6M15 12h6"/>',
};

const SOLID: Record<string, string> = {
  home: '<path d="M11.3 2.8a1.1 1.1 0 0 1 1.4 0l8 6.7c.2.2.3.5.3.8V20a1.5 1.5 0 0 1-1.5 1.5h-4a1 1 0 0 1-1-1V16a1 1 0 0 0-1-1h-3a1 1 0 0 0-1 1v4.5a1 1 0 0 1-1 1h-4A1.5 1.5 0 0 1 3 20v-9.7c0-.3.1-.6.3-.8z"/>',
  more: '<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>',
  moreVertical:
    '<circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/>',
  caretDown: '<path d="M7 9.5h10l-5 6z"/>',
  send: '<path d="M3.2 3.3a.6.6 0 0 1 .8-.6l17.3 8.7a.6.6 0 0 1 0 1.1L4 21.3a.6.6 0 0 1-.8-.6l1.4-7.1 8.2-1.6-8.2-1.6z"/>',
  github:
    '<path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/>',
  linear:
    '<path d="M2.9 14.7 9.3 21.1a9.3 9.3 0 0 1-6.4-6.4zm-.2-2.9 9.5 9.5c.6 0 1.3-.1 1.9-.2L2.9 9.9c-.1.6-.2 1.3-.2 1.9zm.8-4.1 12.8 12.8c.5-.2.9-.5 1.4-.8L4.3 6.3c-.3.5-.6.9-.8 1.4zm1.8-2.6a9.3 9.3 0 1 1 13.6 12.7z"/>',
};

/** One icon as an inline SVG that takes the text colour. Unknown names render nothing. */
export function icon(name: string, size = 20): string {
  const attrs = `class="sm-ic" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"`;
  const line = LINE[name];
  if (line)
    return `<svg ${attrs} fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${line}</svg>`;
  const solid = SOLID[name];
  return solid ? `<svg ${attrs} fill="currentColor">${solid}</svg>` : "";
}

/** A CSS `mask` value for an icon, for controls whose markup is a text glyph. */
export function iconMask(name: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'>${(LINE[name] ?? "").replace(/"/g, "'")}</svg>`;
  return `url("data:image/svg+xml,${svg.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/#/g, "%23")}") center/contain no-repeat`;
}
