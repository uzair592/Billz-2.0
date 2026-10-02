import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword, verifyPassword } from "../src/server/auth/passwords.mjs";
import { createTokenPair, hashOpaqueToken } from "../src/server/auth/tokens.mjs";

const pepper = "test-pepper-is-long-enough";

describe("authentication security primitives", () => {
  it("hashes passwords with Argon2id and verifies only the correct secret", async () => {
    const hash = await hashPassword("a secure password", pepper);

    assert.match(hash, /^\$argon2id\$/);
    assert.equal(await verifyPassword(hash, "a secure password", pepper), true);
    assert.equal(await verifyPassword(hash, "wrong password", pepper), false);
  });

  it("uses salted hashes for equal passwords", async () => {
    const first = await hashPassword("a secure password", pepper);
    const second = await hashPassword("a secure password", pepper);

    assert.notEqual(first, second);
  });

  it("rejects short passwords and weak peppers", async () => {
    await assert.rejects(hashPassword("short", pepper), /at least 10/);
    await assert.rejects(hashPassword("long enough password", "short"), /pepper/);
  });

  it("creates random tokens and stores only deterministic SHA-256 hashes", () => {
    const first = createTokenPair();
    const second = createTokenPair();

    assert.notEqual(first.token, second.token);
    assert.equal(first.tokenHash.length, 32);
    assert.deepEqual(hashOpaqueToken(first.token), first.tokenHash);
    assert.notEqual(first.tokenHash.toString("hex"), first.token);
  });
});
