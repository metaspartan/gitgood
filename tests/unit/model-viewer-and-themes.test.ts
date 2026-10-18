import { describe, expect, test } from "bun:test";
import { resolveTheme, THEMES, themeById } from "../../src/web/themes.ts";
import { resolveModelUri } from "../../src/web/components/ModelViewer.tsx";
import { assertDecodable, collectStats, gltfExtensions, modelFormatFor } from "../../src/web/components/model3d.ts";
import { isPreviewableModel } from "../../src/web/components/ModelDiff.tsx";
import { errorResponse } from "../../src/lib/http.ts";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from "three";

function glb(json: object): Uint8Array {
  let text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (text.length % 4)) % 4;
  const padded = new Uint8Array(text.length + pad).fill(0x20);
  padded.set(text);
  text = padded;
  const out = new Uint8Array(20 + text.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  return out;
}

describe("model formats", () => {
  test("every format the server classifies as a model has a loader", () => {
    for (const ext of ["glb", "gltf", "obj", "ply", "stl", "3mf"]) {
      expect(modelFormatFor(`assets/thing.${ext.toUpperCase()}`)).toBe(ext as never);
      expect(isPreviewableModel(`a/b.${ext}`)).toBe(true);
    }
    for (const path of ["model.fbx", "glb", "readme.md", "x."]) {
      expect(modelFormatFor(path)).toBeNull();
      expect(isPreviewableModel(path)).toBe(false);
    }
  });

  test("glTF extension lists are read from a GLB header and from .gltf JSON", () => {
    const json = { asset: { version: "2.0" }, extensionsUsed: ["EXT_meshopt_compression", "KHR_materials_emissive_strength"], extensionsRequired: ["EXT_meshopt_compression"] };
    expect(gltfExtensions(glb(json), "glb")).toEqual({ used: json.extensionsUsed, required: json.extensionsRequired });
    expect(gltfExtensions(new TextEncoder().encode(JSON.stringify(json)), "gltf").required).toEqual(["EXT_meshopt_compression"]);
    expect(gltfExtensions(new Uint8Array([1, 2, 3]), "glb")).toEqual({ used: [], required: [] });
    expect(gltfExtensions(glb(json).subarray(0, 24), "glb")).toEqual({ used: [], required: [] });
  });

  test("a model needing an unshipped decoder fails with a sentence naming it", () => {
    expect(() => assertDecodable(["EXT_meshopt_compression"])).not.toThrow();
    expect(() => assertDecodable(["KHR_draco_mesh_compression"])).toThrow(/Draco-compressed geometry/);
    expect(() => assertDecodable(["KHR_texture_basisu", "EXT_texture_webp", "KHR_mesh_quantization"])).not.toThrow();
  });

  test("relative glTF references resolve against the file's directory, not the repository root", () => {
    expect(resolveModelUri("models/gltf/crate.gltf", "crate.bin")).toBe("models/gltf/crate.bin");
    expect(resolveModelUri("models/gltf/crate.gltf", "./textures/a%20b.png")).toBe("models/gltf/textures/a b.png");
    expect(resolveModelUri("models/gltf/crate.gltf", "../shared/t.png")).toBe("models/shared/t.png");
    expect(resolveModelUri("crate.gltf", "t.png")).toBe("t.png");
    expect(resolveModelUri("a.gltf", "../../../etc/passwd")).toBe("etc/passwd");
  });

  test("stats count shared materials once and report bounding dimensions", () => {
    const material = new MeshStandardMaterial();
    const group = new Group();
    const a = new Mesh(new BoxGeometry(2, 1, 1), material);
    const b = new Mesh(new BoxGeometry(1, 1, 1), material);
    b.position.x = 3;
    group.add(a, b);
    const stats = collectStats(group, [], ["KHR_materials_variants"]);
    expect(stats.meshes).toBe(2);
    expect(stats.triangles).toBe(24);
    expect(stats.materials).toBe(1);
    expect(stats.size[0]).toBeCloseTo(4.5);
    expect(stats.extensions).toEqual(["KHR_materials_variants"]);
  });
});

describe("3D viewer CSP allowances stay narrow", () => {
  test("blob: and wasm compilation are allowed, eval and remote origins are not", () => {
    const csp = errorResponse(new Error("probe")).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("connect-src 'self' blob:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).not.toMatch(/https?:\/\//);
  });
});

describe("personal theme preference", () => {
  test("instance, fixed and system modes resolve as described", () => {
    expect(resolveTheme({ mode: "instance" }, "nord", true)).toBe("nord");
    expect(resolveTheme({ mode: "instance" }, null, true)).toBeNull();
    expect(resolveTheme({ mode: "fixed", theme: "dracula" }, "nord", false)).toBe("dracula");
    const sync = { mode: "system", light: "catppuccin-latte", dark: "tokyo-night" } as const;
    expect(resolveTheme(sync, "nord", true)).toBe("tokyo-night");
    expect(resolveTheme(sync, "nord", false)).toBe("catppuccin-latte");
  });

  test("the new palettes are registered and correctly classed", () => {
    for (const [id, mode] of [["github-dimmed", "dark"], ["dracula", "dark"], ["tokyo-night", "dark"], ["catppuccin-mocha", "dark"], ["gruvbox-dark", "dark"], ["one-dark", "dark"], ["solarized-dark", "dark"], ["catppuccin-latte", "light"], ["github-light-soft", "light"], ["rose-pine-dawn", "light"]] as const) {
      expect(themeById(id)?.mode).toBe(mode);
    }
    expect(THEMES.length).toBeGreaterThanOrEqual(26);
  });
});
