import { useState } from "react";
import type { DeviceType } from "@screenmesh/protocol";
import { defaultDeviceType } from "../lib/app.js";
import { Button } from "./ui/button.js";
import { LockIcon, MeshMark } from "./mesh-icons.js";

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
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5">
          <MeshMark className="size-6" />
          <span className="text-sm font-semibold">ScreenMesh</span>
        </div>
        <h1 className="mt-6 text-xl font-semibold">
          {props.joining ? "Name this device to join" : "Name this device"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {props.joining
            ? "This name is shown to other devices in the workspace."
            : "Its identity keypair is generated locally and never leaves this device."}
        </p>
        <form
          className="mt-6 space-y-3"
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
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <select
            aria-label="Device type"
            value={type}
            onChange={(e) => setType(e.target.value as DeviceType)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
          >
            {DEVICE_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <div className="flex items-start gap-2 rounded-md border border-border bg-card p-3 text-xs text-muted-foreground">
            <LockIcon className="mt-0.5 size-4 shrink-0" />
            <span>Local keypair generated. Your private key never leaves this device.</span>
          </div>
          <Button type="submit" className="w-full" disabled={!name.trim()}>
            Continue
          </Button>
        </form>
      </div>
    </div>
  );
}
