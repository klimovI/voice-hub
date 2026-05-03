import { describe, expect, it } from "vitest";
import type {
  ConnectionState,
  UpdateAvailablePayload,
  UpdateErrorPayload,
  UpdateInstallingPayload,
  UpdateProgressPayload,
} from "./ipc";

// Structural assertions on the IPC contract. Each test constructs a payload
// in the shape Rust sends and asserts the field names and optionality match.
// If a Rust struct in updater.rs drifts (rename, retype, drop a field), the
// mirroring test below fails to typecheck — drift detection at compile time.

describe("ipc payloads", () => {
  it("UpdateAvailablePayload carries a version string", () => {
    const p: UpdateAvailablePayload = { version: "0.3.10" };
    expect(p.version).toBe("0.3.10");
  });

  it("UpdateProgressPayload accepts nullable total", () => {
    const known: UpdateProgressPayload = { downloaded: 50, total: 100 };
    const unknown: UpdateProgressPayload = { downloaded: 50, total: null };
    expect(known.total).toBe(100);
    expect(unknown.total).toBeNull();
  });

  it("UpdateInstallingPayload is structurally empty", () => {
    const p: UpdateInstallingPayload = {};
    expect(Object.keys(p)).toHaveLength(0);
  });

  it("UpdateErrorPayload carries a message string", () => {
    const p: UpdateErrorPayload = { message: "install failed" };
    expect(p.message).toBe("install failed");
  });

  it("ConnectionState mirrors get_state with nullable host", () => {
    const fresh: ConnectionState = { has_host: false, host: null };
    const set: ConnectionState = { has_host: true, host: "https://example.com" };
    expect(fresh.host).toBeNull();
    expect(set.has_host).toBe(true);
  });
});
