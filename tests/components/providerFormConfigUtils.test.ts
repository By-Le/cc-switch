import { describe, expect, it } from "vitest";
import { parseConfigRecordWithFallback } from "@/components/providers/forms/helpers/opencodeFormUtils";

const fallback = JSON.stringify({ enabled: true, nested: { value: 1 } });

describe("parseConfigRecordWithFallback", () => {
  it("preserves valid object configs", () => {
    expect(
      parseConfigRecordWithFallback('{"custom":"value"}', fallback),
    ).toEqual({ custom: "value" });
  });

  it("uses the fallback for malformed JSON", () => {
    expect(parseConfigRecordWithFallback("{broken", fallback)).toEqual({
      enabled: true,
      nested: { value: 1 },
    });
  });

  it.each(["null", "[]", '"text"', "42"])(
    "uses the fallback for non-object JSON: %s",
    (value) => {
      expect(parseConfigRecordWithFallback(value, fallback)).toEqual({
        enabled: true,
        nested: { value: 1 },
      });
    },
  );
});
