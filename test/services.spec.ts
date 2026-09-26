import { describe, expect, it } from "vitest";
import { serviceRoutes } from "../src/lib/service";
import { SERVICES } from "../src/services";

describe("services", () => {
  it.each(SERVICES.map((service) => [service.name, service] as const))(
    "%s keeps its view, key and routes under its own name",
    (name, service) => {
      expect(service.site.key).toBe(`${name}:site`);
      for (const [route] of serviceRoutes(service)) {
        expect(route.split(" ")[1].startsWith(`/${name}/`), route).toBe(true);
      }
    }
  );

  it("have unique names", () => {
    const names = SERVICES.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
  });
});
