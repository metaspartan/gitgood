export interface StlMesh {
  positions: Float32Array;
  triangleCount: number;
}

export function parseStl(bytes: Uint8Array, maxTriangles: number): StlMesh | null {
  const isAscii = isAsciiStl(bytes);
  const triangles = isAscii ? parseAsciiStl(bytes, maxTriangles) : parseBinaryStl(bytes, maxTriangles);
  if (!triangles || triangles.length < 9) return null;
  return { positions: triangles, triangleCount: triangles.length / 9 };
}

function isAsciiStl(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 84));
  if (!head.startsWith("solid")) return false;
  if (bytes.byteLength < 84) return true;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(80, true);
  return 84 + triangleCount * 50 !== bytes.byteLength;
}

function parseBinaryStl(bytes: Uint8Array, maxTriangles: number): Float32Array | null {
  if (bytes.byteLength < 84) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(80, true);
  if (triangleCount === 0 || triangleCount > maxTriangles) return null;
  if (84 + triangleCount * 50 !== bytes.byteLength) return null;
  const out = new Float32Array(triangleCount * 9);
  let at = 84;
  for (let t = 0; t < triangleCount; t++) {
    at += 12;
    for (let v = 0; v < 9; v++) {
      out[t * 9 + v] = view.getFloat32(at, true);
      at += 4;
    }
    at += 2;
  }
  return out;
}

function parseAsciiStl(bytes: Uint8Array, maxTriangles: number): Float32Array | null {
  const text = new TextDecoder().decode(bytes);
  const vertices: number[] = [];
  const regex = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (vertices.length >= maxTriangles * 9) return null;
    vertices.push(Number.parseFloat(match[1] as string), Number.parseFloat(match[2] as string), Number.parseFloat(match[3] as string));
  }
  if (vertices.length === 0 || vertices.length % 9 !== 0) return null;
  return new Float32Array(vertices);
}

const VERTEX_SHADER = `
attribute vec3 aPosition;
uniform mat4 uModel;
uniform mat4 uProjection;
varying vec3 vNormal;
void main() {
  gl_Position = uProjection * uModel * vec4(aPosition, 1.0);
  vNormal = aPosition;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vNormal;
void main() {
  // Fixed headlight: cheap, adequate for silhouettes, honest about being
  // a viewer and not a render engine.
  float shade = 0.55 + 0.45 * abs(normalize(vNormal).y);
  gl_FragColor = vec4(vec3(0.62, 0.68, 0.78) * shade, 1.0);
}
`;

export interface StlViewOptions {
  maxTriangles?: number;
}

export function mountStlViewer(
  container: HTMLElement,
  mesh: StlMesh,
  options: StlViewOptions = {},
): () => void {
  const canvas = document.createElement("canvas");
  canvas.className = "stl-canvas";
  canvas.width = container.clientWidth || 640;
  canvas.height = Math.max(280, Math.min(520, container.clientWidth || 640));
  container.appendChild(canvas);

  const gl = canvas.getContext("webgl", { antialias: true });
  if (!gl) return () => canvas.remove();

  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return () => canvas.remove();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return () => canvas.remove();
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  const aPosition = gl.getAttribLocation(program, "aPosition");
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    minX = Math.min(minX, mesh.positions[i] as number);
    maxX = Math.max(maxX, mesh.positions[i] as number);
    minY = Math.min(minY, mesh.positions[i + 1] as number);
    maxY = Math.max(maxY, mesh.positions[i + 1] as number);
    minZ = Math.min(minZ, mesh.positions[i + 2] as number);
    maxZ = Math.max(maxZ, mesh.positions[i + 2] as number);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const scale = 1.6 / extent;

  const uModel = gl.getUniformLocation(program, "uModel");
  const uProjection = gl.getUniformLocation(program, "uProjection");

  const perspective = (fovy: number, aspect: number, near: number, far: number): Float32Array => {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]);
  };

  let angleX = 0.5;
  let angleY = 0.7;
  let distance = 3.2;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (event: PointerEvent): void => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    angleY += (event.clientX - lastX) * 0.01;
    angleX += (event.clientY - lastY) * 0.01;
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const onPointerUp = (): void => {
    dragging = false;
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    distance = Math.min(8, Math.max(1.4, distance + event.deltaY * 0.002));
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  let raf = 0;
  const render = (): void => {
    const aspect = canvas.width / canvas.height;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.07, 0.09, 0.12, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const cosX = Math.cos(angleX);
    const sinX = Math.sin(angleX);
    const cosY = Math.cos(angleY);
    const sinY = Math.sin(angleY);
    const model = new Float32Array([
      cosY * scale, 0, -sinY * scale, 0,
      sinX * sinY * scale, cosX * scale, cosX * sinY * scale, 0,
      cosX * sinY * scale, -sinX * scale, cosX * cosY * scale, 0,
      -centerX * scale, -centerY * scale, -centerZ * scale - distance, 1,
    ]);
    gl.uniformMatrix4fv(uModel, false, model);
    gl.uniformMatrix4fv(uProjection, false, perspective(Math.PI / 4, aspect, 0.1, 100));
    const capped = (options.maxTriangles ?? mesh.triangleCount) * 3;
    gl.drawArrays(gl.TRIANGLES, 0, Math.min(mesh.triangleCount * 3, capped));
    raf = requestAnimationFrame(render);
  };
  raf = requestAnimationFrame(render);

  return () => {
    cancelAnimationFrame(raf);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.remove();
  };
}

export function webglSupported(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return canvas.getContext("webgl") !== null;
  } catch {
    return false;
  }
}
