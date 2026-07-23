import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  DiagnosticSchema,
  ErrorCodeSchema,
  ErrorEnvelopeSchema,
  fail,
  isFailure,
  ok,
  resultSchema
} from "../../src/contracts/result.js";

test("success results preserve data and structured warnings", () => {
  const result = ok(
    { projectId: "project-1" },
    [{
      severity: "warning",
      code: "EXTERNAL_CHANGE_RELOADED",
      message: "已重新加载外部修改",
      path: "assets/package.xml"
    }]
  );

  assert.deepEqual(result, {
    ok: true,
    data: { projectId: "project-1" },
    warnings: [{
      severity: "warning",
      code: "EXTERNAL_CHANGE_RELOADED",
      message: "已重新加载外部修改",
      path: "assets/package.xml"
    }]
  });
  assert.deepEqual(
    resultSchema(z.object({ projectId: z.string() })).parse(result),
    result
  );
});

test("failure results expose stable actionable error details", () => {
  const result = fail("SELECTOR_MATCH_COUNT", "选择器匹配数量不符合预期", {
    path: "operations[0].selector",
    actual: 2,
    allowed: [1],
    suggestedFix: "缩小选择器范围或更新 expectedMatches",
    transactionId: "txn-1",
    logPath: "logs/txn-1/journal.json"
  });

  assert.equal(isFailure(result), true);
  assert.deepEqual(ErrorEnvelopeSchema.parse(result), result);
  assert.equal(result.error.code, "SELECTOR_MATCH_COUNT");
  assert.equal(result.error.actual, 2);
});

test("error code schema rejects ad-hoc and misspelled codes", () => {
  assert.equal(ErrorCodeSchema.safeParse("COMPONENT_NOT_FOUND").success, true);
  assert.equal(ErrorCodeSchema.safeParse("component-not-found").success, false);
  assert.equal(ErrorCodeSchema.safeParse("WHATEVER_HAPPENED").success, false);
});

test("result factories omit empty optional fields", () => {
  assert.deepEqual(ok({ value: 1 }), { ok: true, data: { value: 1 } });
  assert.deepEqual(fail("INVALID_ARGUMENT", "参数无效"), {
    ok: false,
    error: {
      code: "INVALID_ARGUMENT",
      message: "参数无效"
    }
  });
});
