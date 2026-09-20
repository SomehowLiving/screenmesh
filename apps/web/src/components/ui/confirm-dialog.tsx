import { useEffect } from "react";
import { CloseIcon } from "../mesh-icons.js";
import { Button } from "./button.js";

/** Product-owned confirmation UI. Native browser dialogs expose the current
 * hostname and cannot match the ScreenMesh interface. */
export function ConfirmDialog(props: { open: boolean; title: string; description: string; confirmLabel: string; destructive?: boolean; onConfirm: () => void; onClose: () => void }) {
  useEffect(() => {
    if (!props.open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [props]);
  if (!props.open) return null;
  return <div className="fixed inset-0 z-[70] flex items-end bg-foreground/25 p-0 backdrop-blur-[1px] sm:items-center sm:justify-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}><section className="w-full rounded-t-2xl border border-border bg-background p-5 shadow-2xl sm:max-w-md sm:rounded-2xl"><div className="flex items-start justify-between gap-4"><div><h2 id="confirm-title" className="text-base font-semibold">{props.title}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{props.description}</p></div><Button size="icon" variant="ghost" aria-label="Close" onClick={props.onClose}><CloseIcon /></Button></div><div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button variant="outline" onClick={props.onClose}>Cancel</Button><Button variant={props.destructive ? "destructive" : "default"} onClick={props.onConfirm}>{props.confirmLabel}</Button></div></section></div>;
}
