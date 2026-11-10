import { describe, expect, it } from "vitest";
import versions from "../contract/versions.json";
import { SERVICES } from "../src/services";

/**
 * contract/versions.json is what the homepage's CI reads to hold its
 * decoders to this Worker: a view's version cannot move here without the
 * file moving with it, and the homepage cannot move ahead of the file.
 */
describe("contract", () => {
  it("lists every view at the version the code serves", () => {
    expect(versions).toEqual(
      Object.fromEntries(SERVICES.map(({ name, site }) => [name, site.version]))
    );
  });
});
