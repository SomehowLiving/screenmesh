import { useState, type ReactNode } from "react";
import type { DeviceType } from "@screenmesh/protocol";
import { defaultDeviceType } from "../lib/app.js";
import { Button } from "./ui/button.js";
import { SelectMenu } from "./ui/select-menu.js";
import { DeviceTypeIcon, LockIcon, MeshMark } from "./mesh-icons.js";

const DEVICE_TYPE_OPTIONS: Array<{ value: DeviceType; label: string }> = [
  { value: "laptop", label: "Laptop" },
  { value: "phone", label: "Phone" },
  { value: "tablet", label: "Tablet" },
  { value: "desktop", label: "Desktop" },
  { value: "display", label: "Display" },
];

export function SetupView(props: {
  joining: boolean;
  onDone: (name: string, type: DeviceType) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<DeviceType>(defaultDeviceType());

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-8 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(circle_at_18%_20%,oklch(0.94_0_0_/_75%),transparent_30%),radial-gradient(circle_at_80%_85%,oklch(0.96_0_0_/_85%),transparent_26%)] dark:opacity-25" />
      <div className="relative grid w-full max-w-4xl overflow-hidden rounded-2xl border border-border bg-card/90 shadow-[0_18px_60px_oklch(0_0_0_/_0.08)] backdrop-blur sm:grid-cols-[1.08fr_.92fr]">
        <section className="hidden border-r border-border p-8 sm:flex sm:flex-col lg:p-10">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-foreground text-background"><MeshMark className="size-4.5" /></span>
            <span className="text-sm font-semibold">ScreenMesh</span>
          </div>
          <div className="mt-auto">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Your private device mesh</p>
            <h2 className="mt-3 max-w-sm text-3xl font-semibold leading-tight tracking-tight">Move work between your devices without moving it through an app you do not trust.</h2>
            <p className="mt-4 max-w-md text-sm leading-6 text-muted-foreground">Pair the screens you use. Send a note, document, link, code snippet, image, or file. If a device is offline, ScreenMesh keeps the encrypted object safe until it can deliver.</p>
            <div className="mt-7 grid gap-2">
              <SetupFact icon={<LockIcon />} title="Private by design" detail="Keys are created on your device. Relays route encrypted bytes, not readable content." />
              <SetupFact icon={<MeshMark />} title="Works across your screens" detail="Phone, laptop, tablet, desktop, and display can become one workspace." />
              <SetupFact icon={<DeviceTypeIcon deviceType="laptop" />} title="Reliable when devices sleep" detail="Offline deliveries queue safely and resume when a trusted route returns." />
            </div>
          </div>
        </section>
        <section className="p-6 sm:p-8 lg:p-10">
          <div className="flex items-center gap-2.5 sm:hidden">
            <span className="grid size-8 place-items-center rounded-lg bg-foreground text-background"><MeshMark className="size-4.5" /></span>
            <span className="text-sm font-semibold">ScreenMesh</span>
          </div>
          <p className="mt-7 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground sm:mt-0">First, this device</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {props.joining ? "Give this device a name" : "Name this device"}
          </h1>
          <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
            {props.joining
              ? "Other devices in this workspace will see this name. You can choose something familiar, like “Nidhi’s Laptop”."
              : "This name helps you choose the right screen when sending or continuing work later."}
          </p>
          <form
          className="mt-7 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) props.onDone(name.trim(), type);
          }}
        >
          <input
            type="text"
            placeholder="e.g. Nidhi's Laptop"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <label className="block text-[11px] font-medium text-muted-foreground">This is a
            <SelectMenu
              className="mt-1.5"
              ariaLabel="Device type"
              value={type}
              onValueChange={(value) => setType(value as DeviceType)}
              options={DEVICE_TYPE_OPTIONS}
              triggerClassName="h-11 px-3 text-sm"
            />
          </label>
          <div className="group flex items-start gap-2.5 rounded-lg border border-border bg-muted/35 p-3 text-xs leading-5 text-muted-foreground" title="ScreenMesh creates a separate cryptographic identity for every device. The private part stays on this device.">
            <LockIcon className="mt-0.5 size-4 shrink-0 text-foreground" />
            <span><span className="font-medium text-foreground">Private identity, created here.</span> Your private key never leaves this device. <span className="hidden group-hover:inline sm:inline">This is how paired devices can recognise and trust it.</span></span>
          </div>
          <Button type="submit" className="h-11 w-full" disabled={!name.trim()}>
            {props.joining ? "Join workspace" : "Continue"}
          </Button>
          <p className="text-center text-[11px] leading-5 text-muted-foreground">No account. No personal cloud login. Just this device and the ones you choose to pair.</p>
        </form>
        </section>
      </div>
    </div>
  );
}

function SetupFact(props: { icon: ReactNode; title: string; detail: string }) {
  return <div className="group flex items-start gap-3 rounded-lg border border-border/80 bg-background/55 p-3 transition-colors hover:bg-accent/60"><span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">{props.icon}</span><span><span className="block text-xs font-medium">{props.title}</span><span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{props.detail}</span></span></div>;
}
