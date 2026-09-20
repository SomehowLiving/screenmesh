/**
 * Geometric, consistent-stroke SVG icons replacing the ad hoc Unicode
 * glyphs (◈ □ ◇ ↗ ⌘ ⌁ ⚙) previously used for sidebar navigation — those
 * render inconsistently across fonts/platforms and read as placeholder
 * text rather than a designed icon set. 17px, 1.4px stroke, currentColor
 * throughout so active/inactive/hover states are pure CSS.
 */

const base = { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function MeshIcon() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="2.4" />
      <circle cx="4.5" cy="6" r="1.8" />
      <circle cx="19.5" cy="6" r="1.8" />
      <circle cx="4.5" cy="18" r="1.8" />
      <circle cx="19.5" cy="18" r="1.8" />
      <path d="M6 7.2L10 11M18 7.2L14 11M6 16.8L10 13M18 16.8L14 13" />
    </svg>
  );
}

export function DeviceIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="4" width="18" height="12" rx="1.2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

export function InboxIcon() {
  return (
    <svg {...base}>
      <path d="M3 12h5l1.5 3h5L16 12h5" />
      <rect x="3" y="5" width="18" height="14" rx="1.2" />
    </svg>
  );
}

export function SendIcon() {
  return (
    <svg {...base}>
      <path d="M21 3L10.5 13.5M21 3L14.5 21L10.5 13.5M21 3L3 9.5L10.5 13.5" />
    </svg>
  );
}

export function PairIcon() {
  return (
    <svg {...base}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 17h7M17.5 14v7" />
    </svg>
  );
}

export function RouteIcon() {
  return (
    <svg {...base}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <circle cx="18" cy="6" r="2" />
      <path d="M8 6h6a4 4 0 0 1 4 4v0" />
      <path d="M6 8v4a4 4 0 0 0 4 4h6" />
    </svg>
  );
}

export function KeyIcon() {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="4" />
      <path d="M11 11l9 9M16 16l2.5-2.5M19 19l2-2" />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M21 12h-2.5M5.5 12H3M18 6l-1.7 1.7M7.7 16.3L6 18M18 18l-1.7-1.7M7.7 7.7L6 6" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M4 4l16 16M20 4L4 20" />
    </svg>
  );
}
