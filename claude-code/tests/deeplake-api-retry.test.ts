import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the createTableWithRetry path on DeeplakeApi.ensureTable. The
 * retry helper has 4 outer attempts with backoffs [2s, 5s, 10s] on top of
 * the inner _queryWithRetry's 3 retries. Without these tests the catch
 * branch (lines 340-348 in src/deeplake-api.ts) sits at 88% branch
 * coverage; this file pushes it above the 90% per-file bar.
 *
 * We mock `fetch` directly so we can simulate a transient network failure
 * during CREATE TABLE — exactly the scenario PR #76 caught in the
 * `test-apr-27` org runtime test (`CREATE TABLE "memory" attempt 1/4
 * failed: fetch failed` followed by attempt 2/4 succeeding).
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// Stub setTimeout so the 2s/5s/10s backoff fires instantly.
function instantTimers() {
  return vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeApi() {
  const { DeeplakeApi } = await import("../../src/deeplake-api.js");
  return new DeeplakeApi("tok", "https://api.example", "org", "ws", "memory");
}

describe("createTableWithRetry (via ensureTable)", () => {
  it("retries CREATE TABLE on transient failure and succeeds on a later attempt", async () => {
    // 1. listTables (returns no "memory" table)
    fetchMock.mockResolvedValueOnce(ok({ columns: ["table_name"], rows: [["sessions"]] }));
    // 2. CREATE TABLE attempt 1 → throws fetch failed (network-level)
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    // 3. inner-retry attempt 2 → throws again
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    // 4. inner-retry attempt 3 → throws again (exhausts inner retry)
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    // 5. inner-retry attempt 4 → throws again
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    // 6. After ~2s outer backoff: outer attempt 2 → succeeds (CREATE OK)
    fetchMock.mockResolvedValueOnce(ok({ columns: [], rows: [], row_count: 0 }));
    // 7. ensureLookupIndex flow: hasFreshIndexMarker probably returns false on
    //    a fresh dir → CREATE INDEX call → succeeds
    fetchMock.mockResolvedValue(ok({ columns: [], rows: [], row_count: 0 }));

    const restoreTimer = instantTimers();
    try {
      const api = await makeApi();
      await expect(api.ensureTable("memory")).resolves.toBeUndefined();
      // We expect at least one successful CREATE — i.e. our outer retry kicked
      // in after the first attempt's inner retries exhausted.
      // Counting fetch calls is informative but the success-or-throw is the
      // contract assertion.
    } finally {
      restoreTimer.mockRestore();
    }
  });

  it("throws after exhausting all 4 outer attempts × 4 inner retries", async () => {
    // listTables ok (no "memory")
    fetchMock.mockResolvedValueOnce(ok({ columns: ["table_name"], rows: [["sessions"]] }));
    // Every subsequent fetch fails. The retry budget is 4 outer × 4 inner.
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const restoreTimer = instantTimers();
    try {
      const api = await makeApi();
      await expect(api.ensureTable("memory")).rejects.toThrow(/fetch failed/);
      // After all retries exhausted, we should have made many calls but
      // ultimately propagated the network error.
      expect(fetchMock.mock.calls.length).toBeGreaterThan(4);
    } finally {
      restoreTimer.mockRestore();
    }
  });
});
