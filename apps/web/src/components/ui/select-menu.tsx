import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "../mesh-icons.js";

export type SelectMenuOption = {
  value: string;
  label: string;
  description?: string;
};

export function SelectMenu(props: {
  value: string;
  options: SelectMenuOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = props.options.find((option) => option.value === props.value);

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
    <div ref={rootRef} className={`relative ${props.className ?? ""}`}>
      <button
        type="button"
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background px-2.5 text-left text-xs shadow-sm transition-colors hover:border-foreground/30 focus:outline-none focus:ring-1 focus:ring-ring ${props.triggerClassName ?? ""}`}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? "text-foreground" : "text-muted-foreground"}`}>
          {selected?.label ?? props.placeholder ?? "Select an option"}
        </span>
        <ChevronDownIcon className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div role="listbox" aria-label={props.ariaLabel} className="absolute left-0 z-40 mt-1.5 max-h-64 w-full min-w-44 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
          {props.options.map((option) => {
            const active = option.value === props.value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  props.onValueChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${active ? "bg-accent" : "hover:bg-accent/70"}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{option.label}</span>
                  {option.description && <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{option.description}</span>}
                </span>
                {active && <CheckIcon className="size-3.5 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
