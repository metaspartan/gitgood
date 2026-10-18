import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Switch } from "../../src/web/components/Switch.tsx";

function render(props: Partial<Parameters<typeof Switch>[0]> = {}): string {
  return renderToStaticMarkup(
    <Switch label="Wrap lines" checked={false} onChange={() => {}} {...props} />,
  );
}

describe("switch semantics", () => {
  test("renders a real checkbox input, not a div", () => {
    const html = render();
    expect(html).toContain("<input");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("<div role=\"switch\"");
  });

  test("exposes the switch role so assistive tech announces it as on/off", () => {
    expect(render()).toContain('role="switch"');
  });

  test("the label is associated with the input by id", () => {
    const html = render();
    const idMatch = /<input[^>]*id="([^"]+)"/.exec(html);
    expect(idMatch).not.toBeNull();
    const forMatch = /<label[^>]*for="([^"]+)"/.exec(html);
    expect(forMatch).not.toBeNull();
    expect(forMatch?.[1]).toBe(idMatch?.[1]);
  });

  test("checked state is reflected on the input", () => {
    expect(render({ checked: true })).toContain("checked");
  });

  test("disabled state is forwarded", () => {
    expect(render({ disabled: true })).toContain("disabled");
  });

  test("a hint is linked via aria-describedby, not just placed nearby", () => {
    const html = render({ hint: "Shows transparency" });
    expect(html).toContain("Shows transparency");
    const described = /aria-describedby="([^"]+)"/.exec(html);
    expect(described).not.toBeNull();
    const id = described?.[1] ?? "";
    expect(id.length).toBeGreaterThan(0);
    expect(html).toContain(`id="${id}"`);
  });

  test("without a hint there is no dangling aria-describedby", () => {
    expect(render()).not.toContain("aria-describedby");
  });

  test("decorative parts are hidden from assistive tech", () => {
    const html = render();
    expect(html).toContain('aria-hidden="true"');
  });

  test("the size variant only changes the class, not the semantics", () => {
    const small = render({ size: "sm" });
    const medium = render({ size: "md" });
    for (const html of [small, medium]) {
      expect(html).toContain('role="switch"');
      expect(html).toContain('type="checkbox"');
    }
    expect(small).toContain("switch-sm");
    expect(medium).not.toContain("switch-sm");
  });

  test("label text is the accessible name", () => {
    const html = render({ label: "Actual size" });
    expect(html).toContain(">Actual size<");
  });
});
