// Coverage test for the Rust ↔ TS key label contract.
//
// keymap.json (src-tauri/keymap.json) is the shared source of truth listing
// every valid label and the web KeyboardEvent.code values that produce it.
// This test asserts that labelFromCode() can reach every label in the JSON
// from at least one of its declared web_codes, catching TS-side drift.
//
// Companion Rust test: src-tauri/src/listener.rs keymap_json_coverage
// asserts that label_to_key() handles every non-modifier label in the JSON.

import { describe, it, expect } from "vitest";
import keymap from "../../../src-tauri/keymap.json";
import { labelFromCode } from "./binding";

const entries = (keymap as { labels: Array<{ label: string; web_codes: string[] }> }).labels;

describe("keymap.json coverage — labelFromCode", () => {
  for (const entry of entries) {
    it(`produces "${entry.label}" from at least one web_code`, () => {
      const reached = entry.web_codes.some((code) => labelFromCode(code) === entry.label);
      expect(
        reached,
        `labelFromCode did not produce "${entry.label}" — tried: ${entry.web_codes.join(", ")}`,
      ).toBe(true);
    });
  }
});
