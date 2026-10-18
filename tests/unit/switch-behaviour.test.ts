import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("../../src/web/components/Switch.tsx", import.meta.url), "utf8");
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("switch component", () => {
  test("the track is decorative and carries no handler", () => {
    const track = /<span className="switch-track"[^>]*>/.exec(code);
    expect(track).not.toBeNull();
    expect(track?.[0]).toContain('aria-hidden="true"');
    expect(track?.[0]).not.toContain("onClick");
  });

  test("exactly one element changes the value", () => {
    expect((code.match(/onChange=/g) ?? []).length).toBe(1);
    expect(code).toMatch(/<input[\s\S]{0,500}onChange=/);
  });

  test("the track is inside the label, which is what makes clicks reach the input", () => {
    const labelStart = code.indexOf("<label");
    const labelEnd = code.indexOf("</label>");
    expect(labelStart).toBeGreaterThan(-1);
    expect(labelEnd).toBeGreaterThan(labelStart);
    const inside = code.slice(labelStart, labelEnd);
    expect(inside).toContain("switch-track");
    expect(inside).toMatch(/\{label\}/);
    expect((code.match(/<label/g) ?? []).length).toBe(1);
  });

  test("the label is associated with the input by id, not only by containment", () => {
    expect(code).toMatch(/const (\w+) = useId\(\)/);
    const id = /const (\w+) = useId\(\)/.exec(code)?.[1];
    expect(code).toContain("htmlFor={inputId}");
    expect(code).toContain("id={inputId}");
    expect(id).toBe("inputId");
  });

  test("the control exposes the switch role and takes its name from the label text", () => {
    expect(code).toContain('role="switch"');
    expect(code).toContain('type="checkbox"');
    expect(code).not.toContain("aria-label");
  });

  test("the hint is outside the label, so it does not join the accessible name", () => {
    const labelEnd = code.indexOf("</label>");
    const hintIndex = code.indexOf("switch-hint");
    expect(hintIndex).toBeGreaterThan(labelEnd);
    expect(code).toContain("aria-describedby");
    expect(code).toMatch(/const hintId = `\$\{inputId\}-hint`/);
  });

  test("the disabled state is conveyed, not only styled", () => {
    expect(code).toMatch(/disabled=\{disabled\}/);
    expect(code).toMatch(/switch-disabled/);
  });
});
