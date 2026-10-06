import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSslConfig } from "../src/server/database/pool.mjs";

describe("database SSL configuration", () => {
  it("returns no ssl option when the mode is unset", () => {
    assert.equal(parseSslConfig({}), null);
    assert.equal(parseSslConfig({ DATABASE_SSL_MODE: "" }), null);
  });

  it("disable returns no ssl option", () => {
    assert.equal(parseSslConfig({ DATABASE_SSL_MODE: "disable" }), null);
  });

  it("disable ignores a supplied CA", () => {
    assert.equal(
      parseSslConfig({ DATABASE_SSL_MODE: "disable", DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----" }),
      null,
    );
  });

  it("require returns TLS with rejectUnauthorized false", () => {
    const ssl = parseSslConfig({ DATABASE_SSL_MODE: "require" });
    assert.deepEqual(ssl, { rejectUnauthorized: false });
  });

  it("require attaches the CA when supplied", () => {
    const ca = "-----BEGIN CERTIFICATE-----ABC-----END CERTIFICATE-----";
    const ssl = parseSslConfig({ DATABASE_SSL_MODE: "require", DATABASE_SSL_CA: ca });
    assert.deepEqual(ssl, { rejectUnauthorized: false, ca });
  });

  it("verify-full returns TLS with rejectUnauthorized true", () => {
    const ssl = parseSslConfig({ DATABASE_SSL_MODE: "verify-full" });
    assert.deepEqual(ssl, { rejectUnauthorized: true });
  });

  it("verify-full attaches the CA when supplied", () => {
    const ca = "-----BEGIN CERTIFICATE-----XYZ-----END CERTIFICATE-----";
    const ssl = parseSslConfig({ DATABASE_SSL_MODE: "verify-full", DATABASE_SSL_CA: ca });
    assert.deepEqual(ssl, { rejectUnauthorized: true, ca });
  });

  it("rejects an unknown mode", () => {
    assert.throws(
      () => parseSslConfig({ DATABASE_SSL_MODE: "verify-ca" }),
      (error) => error.code === "CONFIGURATION_INVALID" && /DATABASE_SSL_MODE/.test(error.message),
    );
    assert.throws(
      () => parseSslConfig({ DATABASE_SSL_MODE: "prefer" }),
      (error) => error.code === "CONFIGURATION_INVALID",
    );
  });

  it("is case-insensitive and trims whitespace", () => {
    assert.deepEqual(
      parseSslConfig({ DATABASE_SSL_MODE: "  VERIFY-FULL  " }),
      { rejectUnauthorized: true },
    );
    assert.deepEqual(
      parseSslConfig({ DATABASE_SSL_MODE: " Require " }),
      { rejectUnauthorized: false },
    );
  });

  it("never returns credentials or the connection string", () => {
    const ssl = parseSslConfig({
      DATABASE_SSL_MODE: "verify-full",
      DATABASE_SSL_CA: "ca-material",
      DATABASE_URL: "postgresql://user:secret@host:5432/db",
    });
    const serialized = JSON.stringify(ssl);
    assert.ok(!serialized.includes("secret"));
    assert.ok(!serialized.includes("postgresql://"));
    assert.ok(!serialized.includes("user"));
  });
});
