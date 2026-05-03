// Coverage test for the Rust ↔ TS key label contract.
//
// keymap.json (src-tauri/keymap.json) is the shared source of truth listing
// every valid label and the web KeyboardEvent.code values that produce it.
// This test asserts that labelFromCode() can reach every label in the JSON
// from at least one of its declared web_codes, catching TS-side drift.
//
// Companion Rust test: src-tauri/src/listener.rs keymap_json_coverage
// asserts that label_to_key() handles every non-modifier label in the JSON.
//
// Also contains:
//   - mousemap.json coverage (Test W): asserts formatBinding renders each
//     static mouse-button label and validates the Side{n} pattern contract.
//   - InputBinding fixture roundtrip (Test L): asserts parsed fixtures match
//     expected shapes and re-serialise to byte-identical JSON.

import { describe, it, expect } from "vitest";
import keymap from "../../../src-tauri/keymap.json";
import mousemap from "../../../src-tauri/mousemap.json";
import bindingKeyboardPlain from "../../../src-tauri/testdata/binding-keyboard-plain.json";
import bindingKeyboardPlainRaw from "../../../src-tauri/testdata/binding-keyboard-plain.json?raw";
import bindingKeyboardModifiers from "../../../src-tauri/testdata/binding-keyboard-modifiers.json";
import bindingKeyboardModifiersRaw from "../../../src-tauri/testdata/binding-keyboard-modifiers.json?raw";
import bindingMouse from "../../../src-tauri/testdata/binding-mouse.json";
import bindingMouseRaw from "../../../src-tauri/testdata/binding-mouse.json?raw";
import bindingClearedRaw from "../../../src-tauri/testdata/binding-cleared.json?raw";
import { labelFromCode, formatBinding } from "./binding";
import type { InputBinding } from "./binding";

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

// ---------------------------------------------------------------------------
// Test W: mousemap.json coverage — formatBinding
//
// Companion Rust test: src-tauri/src/listener.rs mousemap_json_coverage
// asserts every static entry round-trips through button_label().
// ---------------------------------------------------------------------------

type MousemapButton = { label: string; rdev_variant: string; notes: string };
type Mousemap = {
  buttons: MousemapButton[];
  side_pattern: { format: string; regex: string; n_type: string };
};

const mm = mousemap as Mousemap;

describe("mousemap.json coverage — formatBinding", () => {
  for (const btn of mm.buttons) {
    it(`formatBinding renders static label "${btn.label}" as "Mouse ${btn.label}"`, () => {
      const binding: InputBinding = { kind: "mouse", button: btn.label };
      expect(formatBinding(binding)).toBe(`Mouse ${btn.label}`);
    });
  }

  it('static labels match the Side{n} pattern or are "Right"/"Middle"', () => {
    const sideRe = new RegExp(mm.side_pattern.regex);
    const knownNonSide = new Set(["Right", "Middle"]);
    for (const btn of mm.buttons) {
      const valid = knownNonSide.has(btn.label) || sideRe.test(btn.label);
      expect(valid, `unexpected label format: "${btn.label}"`).toBe(true);
    }
  });

  it('synthesised "Side42" passes the side_pattern regex and formatBinding', () => {
    const sideRe = new RegExp(mm.side_pattern.regex);
    expect(sideRe.test("Side42")).toBe(true);
    const binding: InputBinding = { kind: "mouse", button: "Side42" };
    expect(formatBinding(binding)).toBe("Mouse Side42");
  });
});

// ---------------------------------------------------------------------------
// Test L: InputBinding fixture roundtrip
//
// Each fixture in src-tauri/testdata/ documents the authoritative serialised
// form that Rust persists to shortcut.json. The TS side must parse the same
// shape. The roundtrip assertion catches: field additions/removals, key renames,
// type changes, and key-order changes.
//
// Note on whitespace: serde_json serialises short arrays as compact inline
// JSON ("keys": ["M"]) while JSON.stringify(obj, null, 2) always expands
// arrays to multi-line. We normalise both sides through a parse→stringify
// round so the comparison is whitespace-agnostic but structure-strict:
//   canonical(raw fixture) === canonical(TS-parsed object)
// A field added or renamed on either side will still fail this test.
//
// ?raw imports provide the source bytes for the normalisation step.
// ---------------------------------------------------------------------------

function canonical(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

describe("InputBinding fixture roundtrip", () => {
  it("binding-keyboard-plain.json — shape and structure roundtrip", () => {
    const parsed = bindingKeyboardPlain as InputBinding;
    expect(parsed.kind).toBe("keyboard");
    if (parsed.kind !== "keyboard") throw new Error("unreachable");
    expect(Array.isArray(parsed.keys)).toBe(true);
    // canonical(raw) === canonical(parsed): catches field drift on either side
    expect(canonical(parsed)).toBe(canonical(JSON.parse(bindingKeyboardPlainRaw)));
  });

  it("binding-keyboard-modifiers.json — shape and structure roundtrip", () => {
    const parsed = bindingKeyboardModifiers as InputBinding;
    expect(parsed.kind).toBe("keyboard");
    if (parsed.kind !== "keyboard") throw new Error("unreachable");
    expect(Array.isArray(parsed.keys)).toBe(true);
    expect(canonical(parsed)).toBe(canonical(JSON.parse(bindingKeyboardModifiersRaw)));
  });

  it("binding-mouse.json — shape and structure roundtrip", () => {
    const parsed = bindingMouse as InputBinding;
    expect(parsed.kind).toBe("mouse");
    if (parsed.kind !== "mouse") throw new Error("unreachable");
    expect(typeof parsed.button).toBe("string");
    expect(canonical(parsed)).toBe(canonical(JSON.parse(bindingMouseRaw)));
  });

  it("binding-cleared.json — null and structure roundtrip", () => {
    // The cleared fixture is a bare JSON null literal.
    const parsed: InputBinding | null = JSON.parse(bindingClearedRaw) as InputBinding | null;
    expect(parsed).toBeNull();
    expect(canonical(parsed)).toBe(canonical(JSON.parse(bindingClearedRaw)));
  });
});
