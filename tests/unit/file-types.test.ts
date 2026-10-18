import { describe, expect, test } from "bun:test";
import {
  classifyBlob,
  contentTypeForBlob,
  mediaTypeFromPath,
  sniffImageType,
  sniffMediaType,
} from "../../src/lib/file-types.ts";
import { parseStl } from "../../src/web/components/stl.ts";

const enc = new TextEncoder();

function wavBytes(): Uint8Array {
  const data = new Uint8Array([0x80, 0x7f, 0x40, 0xc0]);
  const buffer = new Uint8Array(44 + data.length);
  const view = new DataView(buffer.buffer);
  buffer.set(enc.encode("RIFF"), 0);
  view.setUint32(4, 36 + data.length, true);
  buffer.set(enc.encode("WAVE"), 8);
  buffer.set(enc.encode("fmt "), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  buffer.set(enc.encode("data"), 36);
  view.setUint32(40, data.length, true);
  buffer.set(data, 44);
  return buffer;
}

function binaryStlBytes(): Uint8Array {
  const buffer = new Uint8Array(84 + 50);
  const view = new DataView(buffer.buffer);
  buffer.set(enc.encode("binary stl fixture"), 0);
  view.setUint32(80, 1, true);
  let at = 84;
    for (let i = 0; i < 3; i++, at += 4) view.setFloat32(at, 0, true);
  const vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  for (const value of vertices) {
    view.setFloat32(at, value, true);
    at += 4;
  }
  view.setUint16(at, 0, true);
  return buffer;
}

const asciiStlBytes = (): Uint8Array =>
  enc.encode(
    "solid fixture\nfacet normal 0 0 1\n  outer loop\n    vertex 0 0 0\n    vertex 1 0 0\n    vertex 0 1 0\n  endloop\nendfacet\nendsolid fixture\n",
  );

describe("sniffMediaType", () => {
  test("WAV via RIFF/WAVE", () => {
    expect(sniffMediaType(wavBytes())?.mime).toBe("audio/wav");
    expect(sniffMediaType(wavBytes())?.kind).toBe("audio");
  });

  test("OggS, fLaC, ID3", () => {
    expect(sniffMediaType(enc.encode("OggS\x00\x02audio"))?.mime).toBe("audio/ogg");
    expect(sniffMediaType(enc.encode("fLaC\x00\x00\x00\x22"))?.mime).toBe("audio/flac");
    expect(sniffMediaType(enc.encode("ID3\x04\x00\x00\x00\x00\x00\x00"))?.mime).toBe("audio/mpeg");
  });

  test("MPEG frame sync without ID3", () => {
    expect(sniffMediaType(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))?.mime).toBe("audio/mpeg");
  });

  test("mp4 brands: video, and M4A as audio", () => {
    const mp4 = enc.encode("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2");
    expect(sniffMediaType(mp4)?.mime).toBe("video/mp4");
    const m4a = enc.encode("\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00M4A mp42");
    expect(sniffMediaType(m4a)?.mime).toBe("audio/mp4");
    const mov = enc.encode("\x00\x00\x00\x14ftypqt  \x00\x00\x02\x00qt  ");
    expect(sniffMediaType(mov)?.mime).toBe("video/quicktime");
  });

  test("EBML: webm vs matroska", () => {
    const webm = new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ...enc.encode("\x42\x82\x48webm"),
    ]);
    expect(sniffMediaType(webm)?.mime).toBe("video/webm");
    const mkv = new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ...enc.encode("\x42\x82\x48matroska"),
    ]);
    expect(sniffMediaType(mkv)?.mime).toBe("video/x-matroska");
  });

  test("GLB magic, and text bytes are never media", () => {
    expect(sniffMediaType(enc.encode("glTF\x02\x00\x00\x00"))?.mime).toBe("model/gltf-binary");
    expect(sniffMediaType(enc.encode("hello world, just text"))).toBeNull();
    expect(sniffMediaType(new Uint8Array(12))).toBeNull();
  });
});

describe("classifyBlob", () => {
  test("sniffed media beats the extension", () => {
    const classified = classifyBlob("logo.png", wavBytes(), { binary: true });
    expect(classified.kind).toBe("audio");
    expect(classified.mime).toBe("audio/wav");
  });

  test("binary STL previews as a model via its extension", () => {
    const classified = classifyBlob("part.stl", binaryStlBytes(), { binary: true });
    expect(classified.kind).toBe("model");
    expect(classified.mime).toBe("model/stl");
  });

  test("ASCII STL previews as a model even though git calls it text", () => {
    const classified = classifyBlob("part.stl", asciiStlBytes(), { binary: false });
    expect(classified.kind).toBe("model");
    expect(classified.mime).toBe("model/stl");
  });

  test("a text file that merely starts with 'solid' stays text", () => {
    const text = enc.encode("solid principles guide\n\n1. keep it simple\n");
    const classified = classifyBlob("solidity-notes.md", text, { binary: false });
    expect(classified.kind).toBe("text");
  });

  test("content type agrees with the blob kind for every media shape", () => {
    const cases: Array<[string, Uint8Array]> = [
      ["beat.wav", wavBytes()],
      ["model.stl", binaryStlBytes()],
      ["model.stl", asciiStlBytes()],
      ["clip.mp4", enc.encode("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2")],
    ];
    for (const [path, bytes] of cases) {
      const kind = classifyBlob(path, bytes, { binary: true });
      const served = contentTypeForBlob(path, bytes, { binary: true });
      expect(served).toBe(kind.mime);
    }
  });

  test("text .gltf highlights as JSON; binary .glb sniffs as glTF", () => {
    const json = enc.encode('{"asset":{"version":"2.0"}}');
    expect(classifyBlob("scene.gltf", json, { binary: false }).language).toBe("json");
    expect(sniffMediaType(enc.encode("glTF\x02\x00\x00\x00"))?.kind).toBe("model");
  });

  test("image sniffing still wins at the top of the order", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(sniffImageType(png)?.mime).toBe("image/png");
    expect(classifyBlob("x.png", png, { binary: true }).kind).toBe("image");
  });

  test("extension fallback for binary files with no signature", () => {
    const noise = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]);
    expect(mediaTypeFromPath("model.3mf")?.mime).toBe("model/3mf");
    expect(classifyBlob("model.3mf", noise, { binary: true }).kind).toBe("model");
    expect(classifyBlob("mystery.bin", noise, { binary: true }).kind).toBe("binary");
  });
});

describe("parseStl", () => {
  test("parses binary STL into one triangle", () => {
    const mesh = parseStl(binaryStlBytes(), 1000);
    expect(mesh).not.toBeNull();
    expect(mesh?.triangleCount).toBe(1);
    expect(mesh?.positions.length).toBe(9);
  });

  test("parses ASCII STL", () => {
    const mesh = parseStl(asciiStlBytes(), 1000);
    expect(mesh?.triangleCount).toBe(1);
    expect(mesh?.positions[3]).toBeCloseTo(1);
  });

  test("refuses a count that disagrees with the byte length", () => {
    const bytes = binaryStlBytes();
    bytes[80] = 9;
    expect(parseStl(bytes, 1000)).toBeNull();
  });

  test("enforces the triangle ceiling", () => {
    expect(parseStl(binaryStlBytes(), 0)).toBeNull();
  });

  test("rejects garbage", () => {
    expect(parseStl(enc.encode("not a mesh at all"), 1000)).toBeNull();
    expect(parseStl(new Uint8Array(10), 1000)).toBeNull();
  });
});
