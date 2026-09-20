import { useEffect, useRef, useState } from "react";

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
}

/**
 * Fully custom listbox — native <select> can't be skinned past its
 * trigger on most platforms (the open option list is OS-rendered, e.g.
 * Windows' native blue highlight), which breaks the dark theme the
 * moment a user opens one. This renders its own option list instead, so
 * every pixel belongs to ScreenMesh's own styling.
 */
export function Select<T extends string | number>(props: {
  value: T;
  options: Array<SelectOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = props.options.find((o) => o.value === props.value);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`sm-select ${open ? "open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="sm-select-trigger"
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current?.label ?? "—"}</span>
        <svg className="sm-select-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none">
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className="sm-select-list" role="listbox">
          {props.options.map((opt) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={opt.value === props.value}
              className={`sm-select-option ${opt.value === props.value ? "selected" : ""}`}
              onClick={() => {
                props.onChange(opt.value);
                setOpen(false);
              }}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
