import type { SVGProps } from "react";

// Minimal hand-rolled line icons (24x24, currentColor stroke) -- just
// enough to make the 4 dashboard sections visually distinguishable at a
// glance, per the design brief ("統一されたシンプルな線アイコン...派手な
// イラストや AIロボット等は不要"). No icon library dependency.
type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function HomeIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10v9a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V19a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-9" />
    </svg>
  );
}

export function ReviewIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4 3.5V16H5.5A1.5 1.5 0 0 1 4 14.5v-9Z" />
      <path d="M8 9h8M8 12h5" />
    </svg>
  );
}

export function BlogIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6.5 3.5h8L19 8v11.5a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
      <path d="M14 3.5V8h4.5" />
      <path d="M8.5 12.5h7M8.5 15.5h7M8.5 18h4" />
    </svg>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 10a6 6 0 1 1 12 0c0 3.2 1 4.8 1.6 5.5a.8.8 0 0 1-.6 1.3H5a.8.8 0 0 1-.6-1.3C5 14.8 6 13.2 6 10Z" />
      <path d="M10 19.5a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 6h4M12 6h8M4 12h10M18 12h2M4 18h6M14 18h6" />
      <circle cx="9.5" cy="6" r="2" />
      <circle cx="14.5" cy="12" r="2" />
      <circle cx="11" cy="18" r="2" />
    </svg>
  );
}

export function LogOutIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M9 20H6.5A1.5 1.5 0 0 1 5 18.5v-13A1.5 1.5 0 0 1 6.5 4H9" />
      <path d="M16 16.5 20.5 12 16 7.5" />
      <path d="M20.5 12h-11" />
    </svg>
  );
}

export function UserCircleIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="10" r="2.75" />
      <path d="M6.3 18.2a6.3 6.3 0 0 1 11.4 0" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M5 12.5 9.5 17 19 7" />
    </svg>
  );
}
