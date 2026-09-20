import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function MeshMark(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 5.25 10 2l6 3.25v6.5L10 15l-6-3.25v-6.5Z" stroke="currentColor" strokeWidth="1.4" />
      <path d="m4.5 5.5 5.5 3 5.5-3M10 8.5V15" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="12" r="1.7" fill="currentColor" />
      <circle cx="16" cy="12" r="1.7" fill="currentColor" />
    </Icon>
  );
}

export function InboxIcon(props: IconProps) {
  return <Icon {...props}><path d="M3.5 4.5h13v11h-13zM3.5 11h3l1.5 2h4l1.5-2h3" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></Icon>;
}

export function DevicesIcon(props: IconProps) {
  return <Icon {...props}><rect x="2.5" y="4" width="10" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" /><path d="M6 15h9.5a2 2 0 0 0 2-2V8M6.5 12v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></Icon>;
}

export function ActivityIcon(props: IconProps) {
  return <Icon {...props}><path d="M2.5 10h3l2-5 4 10 2-5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}

export function SettingsIcon(props: IconProps) {
  return <Icon {...props}><circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.4" /><path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></Icon>;
}

export function PlusIcon(props: IconProps) {
  return <Icon {...props}><path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></Icon>;
}

export function ArrowUpIcon(props: IconProps) {
  return <Icon {...props}><path d="m5 9 5-5 5 5M10 4v12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}

export function CopyIcon(props: IconProps) {
  return <Icon {...props}><rect x="6" y="6" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" /><path d="M13 6V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H6" stroke="currentColor" strokeWidth="1.4" /></Icon>;
}

export function TerminalIcon(props: IconProps) {
  return <Icon {...props}><rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.4" /><path d="m5.5 7 2.5 2-2.5 2M10 12h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}

export function LinkIcon(props: IconProps) {
  return <Icon {...props}><path d="m8.2 11.8 3.6-3.6M6.3 13.7l-1 .9a2.7 2.7 0 1 1-3.9-3.8l2.8-2.9A2.7 2.7 0 0 1 8 7.9M13.7 6.3l1-.9a2.7 2.7 0 1 1 3.9 3.8l-2.8 2.9a2.7 2.7 0 0 1-3.8 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></Icon>;
}

export function CommandIcon(props: IconProps) {
  return <Icon {...props}><path d="M7 6.5H5.5a2.5 2.5 0 1 1 2.5-2.5V16a2.5 2.5 0 1 1-2.5-2.5H14.5a2.5 2.5 0 1 1-2.5 2.5V4a2.5 2.5 0 1 1 2.5 2.5H7Zm0 0h6v7H7v-7Z" stroke="currentColor" strokeWidth="1.35" /></Icon>;
}

export function MoreIcon(props: IconProps) {
  return <Icon {...props}><circle cx="4" cy="10" r="1" fill="currentColor" /><circle cx="10" cy="10" r="1" fill="currentColor" /><circle cx="16" cy="10" r="1" fill="currentColor" /></Icon>;
}

export function LockIcon(props: IconProps) {
  return <Icon {...props}><rect x="4" y="8" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.4" /><path d="M7 8V6a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.4" /><circle cx="10" cy="12.5" r="1" fill="currentColor" /></Icon>;
}

export function SunIcon(props: IconProps) {
  return <Icon {...props}><circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="1.4" /><path d="M10 2v2M10 16v2M18 10h-2M4 10H2M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4M15.7 15.7l-1.4-1.4M5.7 5.7 4.3 4.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></Icon>;
}

export function MoonIcon(props: IconProps) {
  return <Icon {...props}><path d="M16.8 12.8A7 7 0 0 1 7.2 3.2 7 7 0 1 0 16.8 12.8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></Icon>;
}

/* --- Additions beyond the reference set, matching its exact style, for
 * actions the reference's mockup page didn't need to show (real object
 * actions: accept/reject, delete, download, edit, expand). --- */

export function CheckIcon(props: IconProps) {
  return <Icon {...props}><path d="M4 10.5 8 14l8-8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}

export function XIcon(props: IconProps) {
  return <Icon {...props}><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></Icon>;
}

export function TrashIcon(props: IconProps) {
  return <Icon {...props}><path d="M4 6h12M8 6V4.5A1.5 1.5 0 0 1 9.5 3h1A1.5 1.5 0 0 1 12 4.5V6M6 6v9a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 14 15V6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}

export function DownloadIcon(props: IconProps) {
  return <Icon {...props}><path d="M10 3v9m0 0-3.5-3.5M10 12l3.5-3.5M4 15.5h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}

export function EditIcon(props: IconProps) {
  return <Icon {...props}><path d="M12.5 3.5 16 7l-9 9-4 1 1-4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></Icon>;
}

export function ChevronDownIcon(props: IconProps) {
  return <Icon {...props}><path d="m5 8 5 5 5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}

export function ClipboardIcon(props: IconProps) {
  return <Icon {...props}><rect x="5" y="4" width="10" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4" /><rect x="7.5" y="2.5" width="5" height="3" rx="1" stroke="currentColor" strokeWidth="1.4" /></Icon>;
}

export function CloseIcon(props: IconProps) {
  return <Icon {...props}><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></Icon>;
}
