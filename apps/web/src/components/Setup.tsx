import { useState } from "react";
import type { DeviceType } from "@screenmesh/protocol";
import { defaultDeviceType } from "../lib/app.js";

export function SetupView(props: {
  joining: boolean;
  onDone: (name: string, type: DeviceType) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<DeviceType>(defaultDeviceType());

  return (
    <div className="center">
      <h1>ScreenMesh</h1>
      <p className="muted">
        {props.joining
          ? "Name this device to join the workspace."
          : "Name this device to get started. Its keypair is generated locally and never leaves this device."}
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
          placeholder="Device name (e.g. Nidhi's Laptop)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <select value={type} onChange={(e) => setType(e.target.value as DeviceType)}>
          <option value="laptop">Laptop</option>
          <option value="phone">Phone</option>
          <option value="tablet">Tablet</option>
          <option value="desktop">Desktop</option>
          <option value="display">Display</option>
        </select>
        <button type="submit" disabled={!name.trim()}>
          Create device identity
        </button>
      </form>
    </div>
  );
}
