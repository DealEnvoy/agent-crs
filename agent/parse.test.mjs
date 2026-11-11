import assert from "node:assert/strict";
import test from "node:test";
import { nearToYocto, parseOffline, yoctoToNear } from "./parse.mjs";

const aliases = [
  { alias: "vendor", accountId: "vendor.acrs261111k7m2.testnet" },
  { alias: "other", accountId: "other.acrs261111k7m2.testnet" },
];

test("converts NEAR decimals to yocto without float error", () => {
  assert.equal(nearToYocto("1"), "1000000000000000000000000");
  assert.equal(nearToYocto("0.05"), "50000000000000000000000");
  assert.equal(nearToYocto("0.5"), "500000000000000000000000");
  assert.equal(yoctoToNear("50000000000000000000000"), "0.05");
});

test("reads an explicit account and amount", () => {
  const parsed = parseOffline(
    "Pay 0.05 NEAR to vendor.acrs261111k7m2.testnet for API credits",
    aliases,
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.receiverId, "vendor.acrs261111k7m2.testnet");
  assert.equal(parsed.amountYocto, "50000000000000000000000");
  assert.equal(parsed.interpreter, "offline");
  assert.equal(parsed.model, null);
  assert.match(parsed.note, /No model was called/);
});

test("maps the words vendor and other when no account id is present", () => {
  const vendor = parseOffline("Send 2 NEAR to vendor for the monthly invoice", aliases);
  assert.equal(vendor.receiverId, "vendor.acrs261111k7m2.testnet");
  assert.equal(vendor.amountNear, "2");
  const other = parseOffline("Pay 0.1 NEAR to other", aliases);
  assert.equal(other.receiverId, "other.acrs261111k7m2.testnet");
});

test("refuses a sentence with no amount or no receiver", () => {
  assert.equal(parseOffline("pay the vendor", aliases).ok, false);
  assert.equal(parseOffline("Pay 1 NEAR to someone unknown", aliases).ok, false);
});
