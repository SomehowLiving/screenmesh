import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreIcon } from "../mesh-icons.js";

export type ActionMenuItem = {
  key: string;
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  onSelect: () => void;
};

/** A small "..." kebab popover for row-level actions, styled to match SelectMenu. */
export function ActionMenu(props: { items: ActionMenuItem[]; ariaLabel: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${props.className ?? ""}`} onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        aria-label={props.ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4"
      >
        <MoreIcon />
      </button>
      {open && (
        <div role="menu" aria-label={props.ariaLabel} className="absolute right-0 z-40 mt-1.5 min-w-40 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-lg">
          {props.items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors hover:bg-accent [&_svg]:size-3.5 ${item.destructive ? "text-destructive hover:bg-destructive/10" : ""}`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
