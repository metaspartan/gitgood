import {
  ACESFilmicToneMapping,
  AnimationMixer,
  Box3,
  BufferGeometry,
  Timer,
  DirectionalLight,
  Group,
  GridHelper,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Sphere,
  type Texture,
  Vector3,
  WebGLRenderer,
  LoadingManager,
  type AnimationClip,
  type AnimationAction,
  LoopRepeat,
  REVISION,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

export type ModelFormat = "glb" | "gltf" | "obj" | "ply" | "stl" | "3mf";

export interface ModelStats {
  meshes: number;
  triangles: number;
  vertices: number;
  materials: number;
  textures: number;
  size: [number, number, number];
  animations: string[];
  extensions: string[];
}

export interface ModelViewerHandle {
  stats: ModelStats;
  setWireframe(on: boolean): void;
  setAutoRotate(on: boolean): void;
  setGround(on: boolean): void;
  resetView(): void;
  playAnimation(index: number | null): void;
  snapshot(): string;
  dispose(): void;
}

export interface MountOptions {
  resolveUri?: (uri: string) => string;
  onWarning?: (message: string) => void;
}

const UNSUPPORTED_REQUIRED = new Map<string, string>([
  ["KHR_draco_mesh_compression", "Draco-compressed geometry"],
]);

let ktx2: KTX2Loader | null = null;
function ktx2Loader(renderer: WebGLRenderer): KTX2Loader {
  if (!ktx2) {
    ktx2 = new KTX2Loader().setTranscoderPath(`/_assets/three-r${REVISION}-`).setWorkerLimit(2);
    ktx2.detectSupport(renderer);
  }
  return ktx2;
}

export function modelFormatFor(path: string): ModelFormat | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  return ext === "glb" || ext === "gltf" || ext === "obj" || ext === "ply" || ext === "stl" || ext === "3mf" ? ext : null;
}

export function gltfExtensions(bytes: Uint8Array, format: "glb" | "gltf"): { used: string[]; required: string[] } {
  try {
    let jsonText: string;
    if (format === "glb") {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) return { used: [], required: [] };
      const chunkLength = view.getUint32(12, true);
      if (view.getUint32(16, true) !== 0x4e4f534a || 20 + chunkLength > bytes.byteLength) return { used: [], required: [] };
      jsonText = new TextDecoder().decode(bytes.subarray(20, 20 + chunkLength));
    } else {
      jsonText = new TextDecoder().decode(bytes);
    }
    const json = JSON.parse(jsonText) as { extensionsUsed?: unknown; extensionsRequired?: unknown };
    const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
    return { used: list(json.extensionsUsed), required: list(json.extensionsRequired) };
  } catch {
    return { used: [], required: [] };
  }
}

export function assertDecodable(required: readonly string[]): void {
  const missing = required.filter((name) => UNSUPPORTED_REQUIRED.has(name));
  if (missing.length > 0) {
    const names = missing.map((name) => UNSUPPORTED_REQUIRED.get(name)).join(" and ");
    throw new Error(`This model uses ${names}, which the web preview cannot decode yet. Download it to view it locally.`);
  }
}

function neutralMaterial(vertexColors: boolean): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: vertexColors ? 0xffffff : 0xb8bec8, metalness: 0.05, roughness: 0.55, vertexColors });
}

function meshFromGeometry(geometry: BufferGeometry): Mesh {
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  return new Mesh(geometry, neutralMaterial(Boolean(geometry.getAttribute("color"))));
}

async function parseModel(
  bytes: Uint8Array,
  format: ModelFormat,
  options: MountOptions,
  renderer: WebGLRenderer,
): Promise<{ root: Object3D; clips: AnimationClip[]; extensions: string[] }> {
  const buffer = bytes.slice().buffer;
  switch (format) {
    case "glb":
    case "gltf": {
      const { used, required } = gltfExtensions(bytes, format);
      assertDecodable(required);
      const manager = new LoadingManager();
      if (options.resolveUri) {
        const resolve = options.resolveUri;
        manager.setURLModifier((url) => (/^(data|blob|https?):/i.test(url) ? url : resolve(url)));
      }
      const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
      if (used.includes("KHR_texture_basisu")) loader.setKTX2Loader(ktx2Loader(renderer));
      const gltf = await new Promise<{ scene: Group; animations: AnimationClip[] }>((resolve, reject) => {
        loader.parse(
          format === "glb" ? buffer : new TextDecoder().decode(bytes),
          "",
          (result) => resolve(result),
          (error) => reject(error instanceof Error ? error : new Error(String(error))),
        );
      });
      return { root: gltf.scene, clips: gltf.animations ?? [], extensions: used };
    }
    case "obj": {
      const group = new OBJLoader().parse(new TextDecoder().decode(bytes));
      group.traverse((node) => {
        const mesh = node as Mesh;
        if (mesh.isMesh) {
          const geometry = mesh.geometry as BufferGeometry;
          if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
          disposeMaterial(mesh.material);
          mesh.material = neutralMaterial(Boolean(geometry.getAttribute("color")));
        }
      });
      return { root: group, clips: [], extensions: [] };
    }
    case "ply":
      return { root: meshFromGeometry(new PLYLoader().parse(buffer)), clips: [], extensions: [] };
    case "stl":
      return { root: meshFromGeometry(new STLLoader().parse(buffer)), clips: [], extensions: [] };
    case "3mf":
      return { root: new ThreeMFLoader().parse(buffer), clips: [], extensions: [] };
  }
}

function texturesOf(material: Material): Texture[] {
  const out: Texture[] = [];
  for (const value of Object.values(material)) {
    if (value && typeof value === "object" && (value as Texture).isTexture) out.push(value as Texture);
  }
  return out;
}

function disposeMaterial(material: Material | Material[]): void {
  for (const m of Array.isArray(material) ? material : [material]) {
    for (const texture of texturesOf(m)) texture.dispose();
    m.dispose();
  }
}

export function collectStats(root: Object3D, clips: AnimationClip[], extensions: string[]): ModelStats {
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    meshes += 1;
    const geometry = mesh.geometry as BufferGeometry;
    const position = geometry.getAttribute("position");
    if (position) vertices += position.count;
    triangles += geometry.index ? geometry.index.count / 3 : position ? position.count / 3 : 0;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const texture of texturesOf(material)) textures.add(texture);
    }
  });
  const box = new Box3().setFromObject(root);
  const size = box.isEmpty() ? new Vector3() : box.getSize(new Vector3());
  return {
    meshes,
    triangles: Math.round(triangles),
    vertices,
    materials: materials.size,
    textures: textures.size,
    size: [size.x, size.y, size.z],
    animations: clips.map((clip, index) => clip.name || `Animation ${index + 1}`),
    extensions,
  };
}

export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

const SHADOW_TRIANGLE_LIMIT = 400_000;

export async function mountModel(
  container: HTMLElement,
  bytes: Uint8Array,
  format: ModelFormat,
  options: MountOptions = {},
): Promise<ModelViewerHandle> {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  let parsed: Awaited<ReturnType<typeof parseModel>>;
  try {
    parsed = await parseModel(bytes, format, options, renderer);
  } catch (error) {
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
  const { root, clips, extensions } = parsed;
  const stats = collectStats(root, clips, extensions);

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  const shadows = stats.triangles <= SHADOW_TRIANGLE_LIMIT;
  renderer.shadowMap.enabled = shadows;
  renderer.domElement.className = "model-canvas";
  renderer.domElement.setAttribute("aria-label", "Interactive 3D model preview");
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04).texture;
  scene.environment = environment;
  room.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      disposeMaterial(mesh.material);
    }
  });

  const box = new Box3().setFromObject(root);
  const center = box.isEmpty() ? new Vector3() : box.getCenter(new Vector3());
  const pivot = new Group();
  root.position.sub(new Vector3(center.x, box.isEmpty() ? 0 : box.min.y, center.z));
  pivot.add(root);
  scene.add(pivot);

  const sphere = box.isEmpty() ? new Sphere(new Vector3(), 1) : box.getBoundingSphere(new Sphere());
  const radius = Math.max(sphere.radius, 1e-6);
  const height = box.isEmpty() ? 0 : box.max.y - box.min.y;

  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
    }
  });

  const key = new DirectionalLight(0xffffff, 1.2);
  key.position.set(radius * 2, radius * 4, radius * 2.5);
  key.castShadow = shadows;
  if (shadows) {
    key.shadow.mapSize.set(2048, 2048);
    const extent = radius * 1.6;
    Object.assign(key.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: radius * 0.1, far: radius * 12 });
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = radius * 0.002;
  }
  scene.add(key);

  const ground = new Group();
  const shadowPlane = new Mesh(new PlaneGeometry(radius * 8, radius * 8), new ShadowMaterial({ opacity: 0.22 }));
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.receiveShadow = true;
  ground.add(shadowPlane);
  const grid = new GridHelper(radius * 6, 24, 0x888888, 0x888888);
  for (const m of Array.isArray(grid.material) ? grid.material : [grid.material]) {
    m.transparent = true;
    m.opacity = 0.14;
    m.depthWrite = false;
  }
  ground.add(grid);
  scene.add(ground);

  const camera = new PerspectiveCamera(40, 1, radius / 1000, radius * 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotateSpeed = 1.2;
  controls.minDistance = radius * 0.05;
  controls.maxDistance = radius * 20;

  const resetView = (): void => {
    const target = new Vector3(0, height / 2, 0);
    const distance = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.05;
    const direction = new Vector3(1, 0.65, 1.25).normalize();
    camera.position.copy(target).addScaledVector(direction, distance);
    controls.target.copy(target);
    camera.near = distance / 1000;
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    controls.update();
    requestRender();
  };

  const mixer = clips.length > 0 ? new AnimationMixer(root) : null;
  let action: AnimationAction | null = null;
  const clock = new Timer();

  let frame = 0;
  let disposed = false;
  let needsRender = true;

  function requestRender(): void {
    needsRender = true;
    if (!frame && !disposed) frame = requestAnimationFrame(tick);
  }

  function tick(): void {
    frame = 0;
    if (disposed) return;
    clock.update();
    const delta = clock.getDelta();
    const moving = controls.update();
    if (mixer && action) mixer.update(delta);
    if (needsRender || moving || action || controls.autoRotate) {
      renderer.render(scene, camera);
      needsRender = false;
    }
    if (moving || action || controls.autoRotate) frame = requestAnimationFrame(tick);
  }

  controls.addEventListener("change", requestRender);

  const resize = (): void => {
    const width = Math.max(1, container.clientWidth);
    const heightPx = Math.max(1, container.clientHeight);
    renderer.setSize(width, heightPx, false);
    camera.aspect = width / heightPx;
    camera.updateProjectionMatrix();
    requestRender();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  const onVisibility = (): void => {
    if (!document.hidden) {
      clock.update();
      requestRender();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  resize();
  resetView();

  const wireframeOriginal = new Map<Material, boolean>();

  return {
    stats,
    setWireframe(on) {
      root.traverse((node) => {
        const mesh = node as Mesh;
        if (!mesh.isMesh) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const m = material as MeshStandardMaterial;
          if (!("wireframe" in m)) continue;
          if (!wireframeOriginal.has(m)) wireframeOriginal.set(m, m.wireframe);
          m.wireframe = on ? true : (wireframeOriginal.get(m) ?? false);
        }
      });
      requestRender();
    },
    setAutoRotate(on) {
      controls.autoRotate = on;
      clock.update();
      requestRender();
    },
    setGround(on) {
      ground.visible = on;
      requestRender();
    },
    resetView,
    playAnimation(index) {
      if (!mixer) return;
      mixer.stopAllAction();
      action = null;
      if (index !== null && clips[index]) {
        action = mixer.clipAction(clips[index]);
        action.setLoop(LoopRepeat, Infinity).reset().play();
        clock.update();
      }
      requestRender();
    },
    snapshot() {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL("image/png");
    },
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      controls.removeEventListener("change", requestRender);
      controls.dispose();
      clock.dispose();
      mixer?.stopAllAction();
      scene.traverse((node) => {
        const mesh = node as Mesh;
        if (mesh.isMesh || (node as GridHelper).isLineSegments) {
          (mesh.geometry as BufferGeometry | undefined)?.dispose();
          if (mesh.material) disposeMaterial(mesh.material);
        }
      });
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
