import { useState } from "react";
import type { DeviceType } from "@screenmesh/protocol";
import { defaultDeviceType } from "../lib/app.js";
import { Select } from "./ui/Select.js";

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
    <div className="center">
      <h1>ScreenMesh</h1>
      <p className="tagline">[ node registration ]</p>
      <p className="muted">
        {props.joining
          ? "Identify this node to join the channel."
          : "Identify this node to proceed."}
      </p>
      <form
        className="stack"
        style={{ width: "min(320px, 90vw)" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) props.onDone(name.trim(), type);
        }}
      >
        <input
          type="text"
          placeholder="Node callsign (e.g. Nidhi's Laptop)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <Select ariaLabel="Device type" value={type} onChange={setType} options={DEVICE_TYPE_OPTIONS} />
        <div className="security-status">
          <span className="status-led" /> LOCAL KEYPAIR GENERATED
          <br />
          <span className="security-substatus">PRIVATE KEY NEVER LEAVES THIS NODE</span>
        </div>
        <button className="btn-primary" type="submit" disabled={!name.trim()}>
          Generate identity
        </button>
      </form>
    </div>
  );
}
