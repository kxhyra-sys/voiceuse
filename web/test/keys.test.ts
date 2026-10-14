import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyError, chord, modifiers, sequence } from "../server/keys.ts";

test("maps xdotool-style names to Playwright keys", () => {
  assert.equal(chord("Return"), "Enter");
  assert.equal(chord("BackSpace"), "Backspace");
  assert.equal(chord("Page_Down"), "PageDown");
  assert.equal(chord("Up"), "ArrowUp");
  assert.equal(chord("F5"), "F5");
  assert.equal(chord("a"), "a");
  assert.equal(chord("A"), "A");
});

test("ctrl becomes ControlOrMeta, super becomes Meta", () => {
  assert.equal(chord("ctrl+a"), "ControlOrMeta+a");
  assert.equal(chord("super+shift+t"), "Meta+Shift+t");
  assert.equal(chord("ctrl+shift+Delete"), "ControlOrMeta+Shift+Delete");
});

test("plus key edge cases", () => {
  assert.equal(chord("+"), "+");
  assert.equal(chord("ctrl++"), "ControlOrMeta++");
  assert.equal(chord("ctrl+plus"), "ControlOrMeta++");
});

test("modifier-only chords for hold_key", () => {
  assert.equal(chord("shift"), "Shift");
});

test("space-separated sequences", () => {
  assert.deepEqual(sequence("Backspace Backspace"), ["Backspace", "Backspace"]);
  assert.deepEqual(sequence("ctrl+a Delete"), ["ControlOrMeta+a", "Delete"]);
});

test("rejects unknown keys", () => {
  assert.throws(() => chord("Hyper"), KeyError);
  assert.throws(() => sequence("   "), KeyError);
  assert.throws(() => modifiers("ctrl+banana"), KeyError);
});

test("click modifiers", () => {
  assert.deepEqual(modifiers("ctrl+shift"), ["ControlOrMeta", "Shift"]);
  assert.deepEqual(modifiers(null), []);
});
