import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withTenantTransaction } from "../src/server/database/tenant-transaction.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

function fakePool({ failRollback = false } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (failRollback && text === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };

  return {
    calls,
    get released() {
      return released;
    },
    async connect() {
      return client;
    },
  };
}

describe("tenant transaction boundary", () => {
  it("sets tenant and user context before application queries", async () => {
    const pool = fakePool();

    const value = await withTenantTransaction(
      pool,
      { restaurantId, userId },
      async (client) => {
        await client.query("SELECT * FROM orders");
        return "done";
      },
    );

    assert.equal(value, "done");
    assert.deepEqual(
      pool.calls.map((call) => call.text),
      [
        "BEGIN",
        "SET LOCAL statement_timeout = '15s'",
        "SELECT set_config('app.restaurant_id', $1, true)",
        "SELECT set_config('app.user_id', $1, true)",
        "SELECT * FROM orders",
        "COMMIT",
      ],
    );
    assert.deepEqual(pool.calls[2].values, [restaurantId]);
    assert.equal(pool.released, true);
  });

  it("rolls back and releases the connection when work fails", async () => {
    const pool = fakePool();
    const failure = new Error("order insert failed");

    await assert.rejects(
      withTenantTransaction(pool, { restaurantId }, async () => {
        throw failure;
      }),
      failure,
    );

    assert.equal(pool.calls.at(-1).text, "ROLLBACK");
    assert.equal(pool.released, true);
  });

  it("rejects untrusted malformed tenant identifiers before connecting", async () => {
    const pool = fakePool();

    await assert.rejects(
      withTenantTransaction(pool, { restaurantId: "from-request-body" }, async () => {}),
      /restaurantId must be a valid UUID/,
    );
    assert.equal(pool.calls.length, 0);
    assert.equal(pool.released, false);
  });

  it("reports both the operation and rollback failures", async () => {
    const pool = fakePool({ failRollback: true });

    await assert.rejects(
      withTenantTransaction(pool, { restaurantId }, async () => {
        throw new Error("operation failed");
      }),
      AggregateError,
    );
    assert.equal(pool.released, true);
  });
});
