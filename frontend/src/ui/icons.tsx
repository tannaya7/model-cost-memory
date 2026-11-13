/** A small set of line icons, 20px grid, drawn with currentColor so they take the text colour. */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 18, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconOverview = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="6" height="6" rx="1.5" />
    <rect x="11" y="3" width="6" height="9" rx="1.5" />
    <rect x="3" y="11" width="6" height="6" rx="1.5" />
    <rect x="11" y="14" width="6" height="3" rx="1.5" />
  </Icon>
);
export const IconJobs = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5h12M4 10h12M4 15h7" />
    <circle cx="15" cy="15" r="2" />
  </Icon>
);
export const IconModels = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 2.5 16.5 6v8L10 17.5 3.5 14V6z" />
    <path d="M3.5 6 10 9.5 16.5 6M10 9.5v8" />
  </Icon>
);
export const IconActivity = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 10h3l2-5 4 10 2-5h4" />
  </Icon>
);
export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 6h7M14.5 6h2M3.5 14h2M9.5 14h7" />
    <circle cx="12.5" cy="6" r="2" />
    <circle cx="7.5" cy="14" r="2" />
  </Icon>
);
export const IconBell = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 13.5V9a5 5 0 0 1 10 0v4.5l1.5 1.5h-13z" />
    <path d="M8.5 17a1.5 1.5 0 0 0 3 0" />
  </Icon>
);
export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="9" r="5.5" />
    <path d="m13.5 13.5 4 4" />
  </Icon>
);
export const IconArrowRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 10h12M11 5l5 5-5 5" />
  </Icon>
);
export const IconArrowDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 4v12M5 11l5 5 5-5" />
  </Icon>
);
export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4.5 10.5 3.5 3.5 7.5-8" />
  </Icon>
);
export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 3 18 16.5H2z" />
    <path d="M10 8.5v3.5M10 14.3v.2" />
  </Icon>
);
export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="7" />
    <path d="M10 6v4l2.5 2" />
  </Icon>
);
export const IconInfo = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="7" />
    <path d="M10 9v5M10 6.3v.2" />
  </Icon>
);
export const IconSpark = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 2.5 11.8 8.2 17.5 10l-5.7 1.8L10 17.5l-1.8-5.7L2.5 10l5.7-1.8z" />
  </Icon>
);
export const IconDollar = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.5 6.5c-.6-1.2-1.9-2-3.5-2-2 0-3.5 1-3.5 2.6 0 3.6 7.3 2 7.3 5.6 0 1.6-1.6 2.8-3.8 2.8-1.7 0-3.1-.8-3.7-2" />
    <path d="M10 2.5v15" />
  </Icon>
);
export const IconShield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 2.5 16 5v5c0 3.6-2.5 6.3-6 7.5-3.5-1.2-6-3.9-6-7.5V5z" />
  </Icon>
);
export const IconFlask = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.5h4M8.5 2.5v5L4 15.5a1.4 1.4 0 0 0 1.2 2h9.6a1.4 1.4 0 0 0 1.2-2L11.5 7.5v-5" />
    <path d="M6 12.5h8" />
  </Icon>
);
export const IconNews = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="11" height="12.5" rx="1.5" />
    <path d="M14 7h2.5v8a1.5 1.5 0 0 1-3 0M6 7.5h5M6 10.5h5M6 13.5h3" />
  </Icon>
);
export const IconExternal = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 4h5v5M16 4l-7 7M14 11.5V16H4V6h4.5" />
  </Icon>
);
export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6M16.5 3.5v3h-3" />
  </Icon>
);
export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 5 10 10M15 5 5 15" />
  </Icon>
);
export const IconChevron = (p: IconProps) => (
  <Icon {...p}>
    <path d="m7 5 5 5-5 5" />
  </Icon>
);
export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 4v12M4 10h12" />
  </Icon>
);
export const IconTable = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="14" height="12" rx="1.5" />
    <path d="M3 8h14M3 12h14M8 8v8" />
  </Icon>
);
export const IconChart = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 16.5h14M5.5 13l3.5-4 3 2.5 4-5.5" />
  </Icon>
);
export const IconBolt = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 2.5 4.5 11h5l-1 6.5L15.5 9h-5z" />
  </Icon>
);
export const IconUser = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="7" r="3.5" />
    <path d="M3.5 17a6.5 6.5 0 0 1 13 0" />
  </Icon>
);
export const IconLogo = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <defs>
      <linearGradient id="mcm-logo" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#a78bfa" />
        <stop offset="0.55" stopColor="#7c3aed" />
        <stop offset="1" stopColor="#d946ef" />
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="22" height="22" rx="7" fill="url(#mcm-logo)" />
    <path d="M6.5 15.5 10 9l3 4.5 4.5-7" fill="none" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const IconSun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="3.5" />
    <path d="M10 1.8v1.8M10 16.4v1.8M1.8 10h1.8M16.4 10h1.8M4.2 4.2l1.3 1.3M14.5 14.5l1.3 1.3M4.2 15.8l1.3-1.3M14.5 5.5l1.3-1.3" />
  </Icon>
);
export const IconMoon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M16.5 12.2A7 7 0 0 1 7.8 3.5a7 7 0 1 0 8.7 8.7Z" />
  </Icon>
);
