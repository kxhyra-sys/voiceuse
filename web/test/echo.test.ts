import assert from "node:assert/strict";
import { test } from "node:test";
import { isEcho } from "../public/echo.js";

const reply =
  "I compared nonstop flights for two people, for one-week trips around New Year. Should I check Eindhoven for more of the dates over New Year?";

test("a piece of the reply heard back is an echo", () => {
  assert.equal(isEcho("I compared", reply), true);
  assert.equal(isEcho("should I check Eindhoven for more of the dates", reply), true);
});

test("a slightly garbled echo is still an echo", () => {
  assert.equal(isEcho("I compare nonstop flights for two people for one week", reply), true);
});

test("real answers are not echoes", () => {
  assert.equal(isEcho("yes", reply), false);
  assert.equal(isEcho("no stay with Cologne", reply), false);
  assert.equal(isEcho("yes please check Eindhoven", reply), false);
  assert.equal(isEcho("we are two persons and want to fly direct", reply), false);
});

test("nothing spoken means no echo", () => {
  assert.equal(isEcho("I compared", null), false);
});
