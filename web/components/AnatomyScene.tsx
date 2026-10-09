"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  ATLAS_SYSTEM_ORDER,
  ATLAS_SYSTEMS,
  HEALTH_HIGHLIGHTS,
  ORGAN_LABELS,
  createPartOrganMap,
  type AtlasPart,
  type AtlasSystemId,
  type HumanAtlas,
} from "@/lib/human-atlas";
import { createExplosionLayout } from "@/lib/explosion-layout";
import type { HealthStatus } from "@/lib/types";
import { BASE_PATH } from "@/lib/base-path";

const MODEL_ROOT = `${BASE_PATH}/models/human-atlas`;
const SELECTED_COLOR = "#3d7a68";

interface AnatomySceneProps {
  selected: string;
  statuses: Record<string, HealthStatus>;
  onSelect: (id: string) => void;
  resetKey: number;
  anatomySex: "female" | "male";
  visibleSystems: AtlasSystemId[];
  explode: number;
}

interface SyntheticOrgan {
  id: string;
  group: THREE.Group;
  material: THREE.MeshStandardMaterial;
  naturalColor: string;
  sex: "female" | "male" | "all";
}

interface SpecialAtlasOrgan {
  id: string;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  naturalColor: string;
  sex: "female" | "male" | "all";
  partIndex: number;
}

function assetUrl(path: string): string {
  return `${MODEL_ROOT}/${path.split("/").at(-1)}`;
}

async function decodeModelResponse(response: Response, expectedBytes: number): Promise<ArrayBuffer> {
  if (!response.ok) throw new Error("人体模型文件加载失败");
  const payload = await response.arrayBuffer();
  const signature = new Uint8Array(payload, 0, Math.min(2, payload.byteLength));
  const isGzip = signature[0] === 0x1f && signature[1] === 0x8b;
  const buffer = isGzip
    ? await new Response(
        new Blob([payload]).stream().pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer()
    : payload;
  if (buffer.byteLength !== expectedBytes) throw new Error("人体模型文件不完整，请刷新后重试");
  return buffer;
}

function markerMaterial(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.58,
    metalness: 0,
    transparent: true,
    opacity: 0.94,
  });
}

function addEllipsoid(
  group: THREE.Group,
  geometry: THREE.SphereGeometry,
  material: THREE.Material,
  position: [number, number, number],
  scale: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.rotation.set(...rotation);
  group.add(mesh);
  return mesh;
}

function createSyntheticOrgans(
  scene: THREE.Scene,
  interactive: THREE.Object3D[],
): { organs: SyntheticOrgan[]; geometries: THREE.BufferGeometry[] } {
  const sphere = new THREE.SphereGeometry(1, 28, 20);
  const organs: SyntheticOrgan[] = [];
  const addOrgan = (
    id: string,
    naturalColor: string,
    sex: SyntheticOrgan["sex"],
    pieces: Array<{
      position: [number, number, number];
      scale: [number, number, number];
      rotation?: [number, number, number];
    }>,
  ) => {
    const group = new THREE.Group();
    const material = markerMaterial(naturalColor);
    group.userData.organId = id;
    pieces.forEach((piece) => {
      const mesh = addEllipsoid(group, sphere, material, piece.position, piece.scale, piece.rotation);
      mesh.userData.organId = id;
      interactive.push(mesh);
    });
    scene.add(group);
    organs.push({ id, group, material, naturalColor, sex });
  };

  addOrgan("thyroid", "#bd766f", "all", [
    { position: [-0.012, 1.445, 0.024], scale: [0.012, 0.024, 0.009], rotation: [0, 0, -0.18] },
    { position: [0.012, 1.445, 0.024], scale: [0.012, 0.024, 0.009], rotation: [0, 0, 0.18] },
    { position: [0, 1.44, 0.024], scale: [0.016, 0.006, 0.007] },
  ]);
  addOrgan("breast", "#c58682", "female", [
    { position: [-0.115, 1.285, 0.105], scale: [0.07, 0.05, 0.025] },
    { position: [0.115, 1.285, 0.105], scale: [0.07, 0.05, 0.025] },
  ]);
  addOrgan("uterus", "#b96f72", "female", [
    { position: [0, 0.91, 0.025], scale: [0.034, 0.04, 0.018] },
    { position: [0, 0.875, 0.022], scale: [0.012, 0.026, 0.01] },
  ]);
  addOrgan("ovary", "#cf9182", "female", [
    { position: [-0.05, 0.92, 0.024], scale: [0.018, 0.012, 0.01], rotation: [0, 0, -0.18] },
    { position: [0.05, 0.92, 0.024], scale: [0.018, 0.012, 0.01], rotation: [0, 0, 0.18] },
  ]);
  return { organs, geometries: [sphere] };
}

function applyOrganMaterial(
  material: THREE.MeshStandardMaterial,
  naturalColor: string,
  status: HealthStatus,
  selected: boolean,
) {
  const riskColor = HEALTH_HIGHLIGHTS[status];
  const color = riskColor || (selected ? SELECTED_COLOR : naturalColor);
  material.color.set(color);
  material.emissive.set(riskColor || (selected ? SELECTED_COLOR : "#000000"));
  material.emissiveIntensity = riskColor ? (selected ? 0.46 : 0.3) : selected ? 0.22 : 0;
  material.opacity = selected ? 1 : 0.94;
  // 有风险的器官（含“关注”）穿透骨骼与肌肉显示，否则女性器官标记会被男性底模的骨盆遮住。
  material.depthTest = !riskColor;
  material.depthWrite = !riskColor;
}

interface ViewerProps {
  atlas: HumanAtlas;
  selectedRef: MutableRefObject<string>;
  statusesRef: MutableRefObject<Record<string, HealthStatus>>;
  anatomySexRef: MutableRefObject<"female" | "male">;
  visibleSystemsRef: MutableRefObject<AtlasSystemId[]>;
  explodeRef: MutableRefObject<number>;
  resetKeyRef: MutableRefObject<number>;
  visualRevisionRef: MutableRefObject<number>;
  onSelectRef: MutableRefObject<(id: string) => void>;
  onProgress: (value: number) => void;
  onError: (message: string) => void;
}

function Viewer({
  atlas, selectedRef, statusesRef, anatomySexRef, visibleSystemsRef, explodeRef, resetKeyRef,
  visualRevisionRef, onSelectRef, onProgress, onError,
}: ViewerProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let animationFrame = 0;
    let lastVisualRevision = -1;
    let lastResetKey = -1;
    const abortController = new AbortController();
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    const interactive: THREE.Object3D[] = [];
    const partPickers: Array<THREE.Mesh | undefined> = [];
    const abnormalOverlays: Array<{ id: string; mesh: THREE.Mesh; partIndex: number }> = [];
    const specialAtlasOrgans: SpecialAtlasOrgan[] = [];
    const partOrgan = createPartOrganMap(atlas);
    let targetsDirty = true;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch {
      onError("当前环境无法启动 3D 人体图谱，请检查 WebGL 设置");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.domElement.setAttribute("aria-label", "可交互人体健康图谱；拖动旋转，滚轮缩放，点击器官查看详情");
    element.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.005, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.085;
    controls.enablePan = false;
    controls.minDistance = 1.2;
    controls.maxDistance = 80;
    controls.minPolarAngle = Math.PI * 0.18;
    controls.maxPolarAngle = Math.PI * 0.82;
    controls.addEventListener("change", () => { targetsDirty = true; });
    const resetCamera = () => {
      controls.target.set(0, 0.9, 0);
      camera.position.set(0.72, 1.04, 2.85);
      controls.update();
    };
    resetCamera();

    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.04);
    scene.environment = environment.texture;
    room.dispose();
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9eb8b3, 1.18));
    const keyLight = new THREE.DirectionalLight(0xfffaf4, 2.45);
    keyLight.position.set(-2, 4, 3);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xdff6f2, 1.8);
    rimLight.position.set(2.5, 2, -3);
    scene.add(rimLight);

    const platformMaterial = new THREE.MeshStandardMaterial({ color: 0xe9eeec, metalness: 0.05, roughness: 0.8 });
    const platformGeometry = new THREE.CylinderGeometry(0.47, 0.5, 0.022, 80);
    const platform = new THREE.Mesh(platformGeometry, platformMaterial);
    platform.position.y = -0.014;
    scene.add(platform);
    const ringGeometry = new THREE.RingGeometry(0.43, 0.433, 100);
    const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x7ea8a1, transparent: true, opacity: 0.42, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0;
    scene.add(ring);
    geometries.push(platformGeometry, ringGeometry);
    materials.push(platformMaterial, ringMaterial);

    const stateWidth = THREE.MathUtils.ceilPowerOfTwo(atlas.parts.length);
    const highlightData = new Uint8Array(stateWidth * 4);
    const highlightTexture = new THREE.DataTexture(highlightData, stateWidth, 1, THREE.RGBAFormat);
    highlightTexture.minFilter = THREE.NearestFilter;
    highlightTexture.magFilter = THREE.NearestFilter;
    highlightTexture.generateMipmaps = false;
    highlightTexture.needsUpdate = true;
    // xyz 保存每个网格的拆解位移，w 保存可见状态；沿用 Human Atlas 的 GPU 状态纹理方案。
    const partStateData = new Float32Array(stateWidth * 4);
    const partStateTexture = new THREE.DataTexture(
      partStateData,
      stateWidth,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    partStateTexture.minFilter = THREE.NearestFilter;
    partStateTexture.magFilter = THREE.NearestFilter;
    partStateTexture.generateMipmaps = false;
    partStateTexture.needsUpdate = true;
    const abnormalOverlayMaterial = new THREE.MeshBasicMaterial({
      color: HEALTH_HIGHLIGHTS.abnormal,
      transparent: true,
      opacity: 0.78,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    materials.push(abnormalOverlayMaterial);
    const markerPositions = new Float32Array(atlas.parts.length * 3);
    markerPositions.fill(10000);
    const markerGeometry = new THREE.BufferGeometry();
    markerGeometry.setAttribute("position", new THREE.BufferAttribute(markerPositions, 3));
    const partMarkerMaterial = new THREE.PointsMaterial({
      color: 0x506e6a,
      size: 4,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.68,
      depthTest: false,
    });
    partMarkerMaterial.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <clipping_planes_fragment>",
        "#include <clipping_planes_fragment>\nif (distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;",
      );
    };
    const partMarkers = new THREE.Points(markerGeometry, partMarkerMaterial);
    partMarkers.frustumCulled = false;
    partMarkers.renderOrder = 18;
    partMarkers.visible = false;
    scene.add(partMarkers);
    geometries.push(markerGeometry);
    materials.push(partMarkerMaterial);

    const materialFor = (system: AtlasSystemId) => {
      const spec = ATLAS_SYSTEMS[system];
      const material = new THREE.MeshStandardMaterial({
        color: spec.color,
        metalness: 0.04,
        roughness: 0.57,
        side: THREE.DoubleSide,
        transparent: spec.opacity < 1,
        opacity: spec.opacity,
        depthWrite: spec.opacity >= 0.75,
      });
      material.onBeforeCompile = (shader) => {
        shader.uniforms.highlightState = { value: highlightTexture };
        shader.uniforms.partState = { value: partStateTexture };
        shader.uniforms.stateWidth = { value: stateWidth };
        shader.vertexShader =
          "attribute float partIndex; uniform sampler2D highlightState; uniform sampler2D partState; uniform float stateWidth; varying vec4 partHighlight; varying float partVisible;\n" + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvec2 stateUv = vec2((partIndex + 0.5) / stateWidth, 0.5); vec4 atlasState = texture2D(partState, stateUv); transformed += atlasState.xyz; partHighlight = texture2D(highlightState, stateUv); partVisible = atlasState.w;",
        );
        shader.fragmentShader = "varying vec4 partHighlight; varying float partVisible;\n" + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <clipping_planes_fragment>",
          "#include <clipping_planes_fragment>\nif (partVisible < 0.5) discard;",
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <color_fragment>",
          "#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, partHighlight.rgb, partHighlight.a); diffuseColor.a = max(diffuseColor.a, partHighlight.a);",
        );
      };
      material.customProgramCacheKey = () => "healthpocket-human-atlas-explosion-v2";
      materials.push(material);
      return material;
    };
    const systemMaterials = new Map(
      (Object.keys(ATLAS_SYSTEMS) as AtlasSystemId[]).map((system) => [system, materialFor(system)]),
    );

    const { organs: syntheticOrgans, geometries: syntheticGeometries } = createSyntheticOrgans(scene, interactive);
    geometries.push(...syntheticGeometries);
    syntheticOrgans.forEach((organ) => materials.push(organ.material));

    const makeGeometry = (part: AtlasPart, buffer: ArrayBuffer, index: number) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(buffer, part.positions, part.vertexCount * 3), 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(new Int16Array(buffer, part.normals, part.vertexCount * 3), 3, true));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(buffer, part.indices, part.indexCount), 1));
      geometry.setAttribute("partIndex", new THREE.BufferAttribute(new Float32Array(part.vertexCount).fill(index), 1));
      geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...part.bounds[0]), new THREE.Vector3(...part.bounds[1]));
      geometry.computeBoundingSphere();
      geometries.push(geometry);
      return geometry;
    };

    const partCenters = atlas.parts.map((part) => new THREE.Vector3(
      (part.bounds[0][0] + part.bounds[1][0]) / 2,
      (part.bounds[0][1] + part.bounds[1][1]) / 2,
      (part.bounds[0][2] + part.bounds[1][2]) / 2,
    ));
    const explosionOffsets = atlas.parts.map(() => new THREE.Vector3());
    const radialOffset = new THREE.Vector3();
    const resolvedOffset = new THREE.Vector3();
    let explosionWidth = 1;
    let explosionHeight = 1.8;
    let currentExplode = THREE.MathUtils.clamp(explodeRef.current, 0, 1);

    const rebuildExplosionLayout = () => {
      const visibleParts = atlas.parts.filter((_, index) => partStateData[index * 4 + 3] > 0.5);
      const layout = createExplosionLayout(visibleParts, camera.aspect);
      explosionWidth = Math.max(0.8, layout.width);
      explosionHeight = Math.max(1.5, layout.height);
      atlas.parts.forEach((part, index) => {
        const cell = layout.cells.get(part.id);
        if (!cell) {
          explosionOffsets[index].set(0, 0, 0);
          return;
        }
        explosionOffsets[index]
          .set(cell.x, cell.y + 0.9, 0)
          .sub(partCenters[index]);
      });
    };

    const systemOffset = (system: AtlasSystemId, centerY: number, amount: number, target: THREE.Vector3) => {
      const systemIndex = Math.max(0, ATLAS_SYSTEM_ORDER.indexOf(system));
      const angle = (systemIndex / ATLAS_SYSTEM_ORDER.length) * Math.PI * 2;
      target.set(
        Math.sin(angle) * amount * 0.48,
        (centerY - 0.9) * amount * 0.28,
        Math.cos(angle) * amount * 0.48,
      );
      return target;
    };

    const updateExplosionState = (amount: number) => {
      const systemPhase = Math.min(1, amount / 0.45);
      const inventoryPhase = Math.max(0, (amount - 0.45) / 0.55);
      atlas.parts.forEach((part, index) => {
        systemOffset(part.system, partCenters[index].y, systemPhase, radialOffset);
        resolvedOffset.copy(radialOffset).lerp(explosionOffsets[index], inventoryPhase);
        const offset = index * 4;
        partStateData[offset] = resolvedOffset.x;
        partStateData[offset + 1] = resolvedOffset.y;
        partStateData[offset + 2] = resolvedOffset.z;
      });
      partStateTexture.needsUpdate = true;

      partPickers.forEach((object, partIndex) => {
        if (!object) return;
        const offset = partIndex * 4;
        object.position.set(partStateData[offset], partStateData[offset + 1], partStateData[offset + 2]);
        object.updateMatrix();
        object.updateMatrixWorld(true);
        markerPositions.set(
          partStateData[offset + 3] > 0.5
            ? [partCenters[partIndex].x + partStateData[offset], partCenters[partIndex].y + partStateData[offset + 1], partCenters[partIndex].z + partStateData[offset + 2]]
            : [10000, 10000, 10000],
          partIndex * 3,
        );
      });
      markerGeometry.attributes.position.needsUpdate = true;
      specialAtlasOrgans.forEach((organ) => {
        const offset = organ.partIndex * 4;
        organ.mesh.position.set(partStateData[offset], partStateData[offset + 1], partStateData[offset + 2]);
      });
      abnormalOverlays.forEach((overlay) => {
        const offset = overlay.partIndex * 4;
        overlay.mesh.position.set(partStateData[offset], partStateData[offset + 1], partStateData[offset + 2]);
        overlay.mesh.updateMatrix();
      });
      syntheticOrgans.forEach((organ) => {
        const system: AtlasSystemId = organ.id === "thyroid" ? "endocrine" : "reproductive";
        systemOffset(system, 0.95, systemPhase, radialOffset);
        organ.group.position.copy(radialOffset);
      });
      platform.visible = amount < 0.46;
      ring.visible = amount < 0.46;
      partMarkers.visible = amount > 0.72;
      controls.enableRotate = amount < 0.82;
      targetsDirty = true;
    };

    const fitExplosionCamera = (amount: number) => {
      const inventoryPhase = Math.max(0, (amount - 0.45) / 0.55);
      const fov = THREE.MathUtils.degToRad(camera.fov);
      const layoutSpan = Math.max(explosionHeight, explosionWidth / Math.max(0.55, camera.aspect));
      const layoutDistance = layoutSpan / (2 * Math.tan(fov / 2)) * 1.16;
      const distance = THREE.MathUtils.lerp(2.94, Math.max(2.94, layoutDistance), inventoryPhase);
      controls.target.set(0, 0.9, 0);
      camera.position.set(
        THREE.MathUtils.lerp(0.72, 0, inventoryPhase),
        THREE.MathUtils.lerp(1.04, 0.9, inventoryPhase),
        distance,
      );
      controls.update();
    };

    let loadedChunks = 0;
    const loadChunk = async (chunkIndex: number) => {
      const chunk = atlas.chunks[chunkIndex];
      if (!chunk.gzip) throw new Error("人体模型缺少压缩资源索引");
      if (typeof DecompressionStream === "undefined") throw new Error("当前浏览器不支持人体模型解压");
      const response = await fetch(assetUrl(chunk.gzip), { signal: abortController.signal });
      const buffer = await decodeModelResponse(response, chunk.bytes);
      if (disposed) return;
      const groups = new Map<AtlasSystemId, THREE.BufferGeometry[]>();

      atlas.parts.forEach((part, index) => {
        if (part.chunk !== chunkIndex) return;
        const organ = partOrgan.get(part.id);
        const geometry = makeGeometry(part, buffer, index);
        const picker = new THREE.Mesh(geometry);
        picker.matrixAutoUpdate = false;
        picker.userData.partIndex = index;
        if (organ) picker.userData.organId = organ;
        picker.updateMatrix();
        partPickers[index] = picker;
        if (organ && organ !== "prostate") interactive.push(picker);
        if (organ === "prostate") {
          const naturalColor = ATLAS_SYSTEMS.reproductive.color;
          const material = markerMaterial(naturalColor);
          const mesh = new THREE.Mesh(geometry, material);
          mesh.userData.organId = organ;
          scene.add(mesh);
          interactive.push(mesh);
          materials.push(material);
          mesh.userData.partIndex = index;
          specialAtlasOrgans.push({ id: organ, mesh, material, naturalColor, sex: "male", partIndex: index });
          return;
        }
        const group = groups.get(part.system) || [];
        group.push(geometry);
        groups.set(part.system, group);
        if (organ) {
          const overlay = new THREE.Mesh(geometry, abnormalOverlayMaterial);
          overlay.matrixAutoUpdate = false;
          overlay.renderOrder = 20;
          overlay.visible = false;
          overlay.updateMatrix();
          scene.add(overlay);
          abnormalOverlays.push({ id: organ, mesh: overlay, partIndex: index });
        }
      });

      groups.forEach((parts, system) => {
        const geometry = mergeGeometries(parts, false);
        if (!geometry) throw new Error("人体模型网格合并失败");
        geometries.push(geometry);
        const mesh = new THREE.Mesh(geometry, systemMaterials.get(system));
        mesh.frustumCulled = false;
        mesh.renderOrder = system === "skeletal" || system === "connective" ? 0 : 1;
        scene.add(mesh);
      });
      loadedChunks += 1;
      updateVisualState();
      onProgress(Math.round((loadedChunks / atlas.chunks.length) * 100));
    };

    void (async () => {
      try {
        let cursor = 0;
        await Promise.all(Array.from({ length: 3 }, async () => {
          while (cursor < atlas.chunks.length) {
            const next = cursor;
            cursor += 1;
            await loadChunk(next);
          }
        }));
      } catch (error) {
        if (!disposed && !(error instanceof DOMException && error.name === "AbortError")) {
          onError(error instanceof Error ? error.message : "人体模型加载失败");
        }
      }
    })();

    const updateVisualState = () => {
      const selected = selectedRef.current;
      const statuses = statusesRef.current;
      const visibleSystems = new Set(visibleSystemsRef.current);
      highlightData.fill(0);
      atlas.parts.forEach((_, index) => { partStateData[index * 4 + 3] = 0; });
      atlas.parts.forEach((part, index) => {
        const organ = partOrgan.get(part.id);
        const compatibleWithSex = part.system !== "reproductive" || anatomySexRef.current === "male";
        const status = organ ? statuses[organ] || "insufficient" : "insufficient";
        const abnormal = status === "abnormal";
        if ((visibleSystems.has(part.system) && compatibleWithSex) || organ === selected || abnormal) {
          partStateData[index * 4 + 3] = 1;
        }
        if (!organ || organ === "prostate") return;
        const riskColor = HEALTH_HIGHLIGHTS[status];
        const selectedPart = organ === selected;
        if (!riskColor && !selectedPart) return;
        const color = new THREE.Color(riskColor || SELECTED_COLOR);
        highlightData[index * 4] = Math.round(color.r * 255);
        highlightData[index * 4 + 1] = Math.round(color.g * 255);
        highlightData[index * 4 + 2] = Math.round(color.b * 255);
        highlightData[index * 4 + 3] = riskColor ? (selectedPart ? 255 : 226) : 205;
      });
      highlightTexture.needsUpdate = true;
      partPickers.forEach((object, partIndex) => {
        if (object) object.visible = partStateData[partIndex * 4 + 3] > 0.5;
      });
      syntheticOrgans.forEach((organ) => {
        const system = organ.id === "thyroid" ? "endocrine" : "reproductive";
        const visibleBySex = organ.sex === "all" || organ.sex === anatomySexRef.current;
        const status = statuses[organ.id] || "insufficient";
        const visible = visibleBySex && (visibleSystems.has(system) || organ.id === selected || Boolean(HEALTH_HIGHLIGHTS[status]));
        organ.group.visible = visible;
        organ.group.children.forEach((child) => { child.visible = visible; });
        applyOrganMaterial(organ.material, organ.naturalColor, status, organ.id === selected);
      });
      specialAtlasOrgans.forEach((organ) => {
        const visibleBySex = organ.sex === "all" || organ.sex === anatomySexRef.current;
        const status = statuses[organ.id] || "insufficient";
        organ.mesh.visible = visibleBySex && (visibleSystems.has("reproductive") || organ.id === selected || Boolean(HEALTH_HIGHLIGHTS[status]));
        applyOrganMaterial(organ.material, organ.naturalColor, status, organ.id === selected);
      });
      abnormalOverlays.forEach((overlay) => {
        const part = atlas.parts[overlay.partIndex];
        const compatibleWithSex = part.system !== "reproductive" || anatomySexRef.current === "male";
        overlay.mesh.visible = compatibleWithSex && statuses[overlay.id] === "abnormal";
      });
      rebuildExplosionLayout();
      updateExplosionState(currentExplode);
    };

    const tooltip = document.createElement("div");
    tooltip.className = "anatomy-organ-tooltip";
    tooltip.hidden = true;
    tooltip.setAttribute("role", "tooltip");
    element.appendChild(tooltip);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pointerStart = new THREE.Vector2();
    type PartTarget = { index: number; x: number; y: number; left: number; right: number; top: number; bottom: number };
    let partTargets: PartTarget[] = [];
    const projected = new THREE.Vector3();
    const refreshPartTargets = () => {
      partTargets = [];
      if (currentExplode <= 0.45) return;
      const hasSolid = atlas.parts.some(
        (part, index) => part.system !== "integumentary" && partStateData[index * 4 + 3] > 0.5,
      );
      atlas.parts.forEach((part, index) => {
        if (!partPickers[index] || partStateData[index * 4 + 3] < 0.5) return;
        if (hasSolid && part.system === "integumentary") return;
        const offset = index * 4;
        let left = Infinity;
        let right = -Infinity;
        let top = Infinity;
        let bottom = -Infinity;
        for (let corner = 0; corner < 8; corner += 1) {
          projected.set(
            part.bounds[(corner & 1) ? 1 : 0][0] + partStateData[offset],
            part.bounds[(corner & 2) ? 1 : 0][1] + partStateData[offset + 1],
            part.bounds[(corner & 4) ? 1 : 0][2] + partStateData[offset + 2],
          ).project(camera);
          const x = (projected.x + 1) * element.clientWidth / 2;
          const y = (1 - projected.y) * element.clientHeight / 2;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
        projected.copy(partCenters[index]).add(new THREE.Vector3(
          partStateData[offset],
          partStateData[offset + 1],
          partStateData[offset + 2],
        )).project(camera);
        if (projected.z < -1 || projected.z > 1) return;
        partTargets.push({
          index,
          x: (projected.x + 1) * element.clientWidth / 2,
          y: (1 - projected.y) * element.clientHeight / 2,
          left,
          right,
          top,
          bottom,
        });
      });
      targetsDirty = false;
    };
    const findPartTarget = (x: number, y: number, radius: number) => {
      let best = -1;
      let score = Infinity;
      partTargets.forEach((target) => {
        const dx = Math.max(target.left - x, 0, x - target.right);
        const dy = Math.max(target.top - y, 0, y - target.bottom);
        const distance = Math.hypot(dx, dy);
        if (distance > radius) return;
        const candidate = distance + Math.hypot(target.x - x, target.y - y) * 0.025;
        if (candidate < score) {
          score = candidate;
          best = target.index;
        }
      });
      return best;
    };
    const showPartTooltip = (index: number, clientX: number, clientY: number) => {
      const part = atlas.parts[index];
      const rect = element.getBoundingClientRect();
      tooltip.textContent = `${part.nameZh || part.name} · ${ATLAS_SYSTEMS[part.system].label}`;
      tooltip.style.left = `${Math.max(8, Math.min(clientX - rect.left + 14, rect.width - 240))}px`;
      tooltip.style.top = `${Math.max(48, Math.min(clientY - rect.top + 16, rect.height - 58))}px`;
      tooltip.hidden = false;
    };
    let pointerDown = false;
    let hoverFrame = 0;
    const hitTest = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(interactive, false).find((hit) => hit.object.visible !== false);
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerDown = true;
      pointerStart.set(event.clientX, event.clientY);
      tooltip.hidden = true;
    };
    const onPointerUp = (event: PointerEvent) => {
      const moved = pointerStart.distanceTo(new THREE.Vector2(event.clientX, event.clientY));
      pointerDown = false;
      if (moved > (event.pointerType === "touch" ? 12 : 6)) return;
      if (currentExplode > 0.45) {
        if (targetsDirty) refreshPartTargets();
        const rect = renderer.domElement.getBoundingClientRect();
        const partIndex = findPartTarget(
          event.clientX - rect.left,
          event.clientY - rect.top,
          event.pointerType === "touch" ? 24 : 16,
        );
        if (partIndex >= 0) {
          showPartTooltip(partIndex, event.clientX, event.clientY);
          const organ = partOrgan.get(atlas.parts[partIndex].id);
          if (organ) onSelectRef.current(organ);
        }
        return;
      }
      const organ = hitTest(event.clientX, event.clientY)?.object.userData.organId as string | undefined;
      if (organ) onSelectRef.current(organ);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (pointerDown || event.pointerType === "touch") return;
      if (hoverFrame) cancelAnimationFrame(hoverFrame);
      hoverFrame = requestAnimationFrame(() => {
        if (currentExplode > 0.45) {
          if (targetsDirty) refreshPartTargets();
          const rect = renderer.domElement.getBoundingClientRect();
          const partIndex = findPartTarget(event.clientX - rect.left, event.clientY - rect.top, 12);
          renderer.domElement.style.cursor = partIndex >= 0 ? "pointer" : "grab";
          tooltip.hidden = partIndex < 0;
          if (partIndex >= 0) showPartTooltip(partIndex, event.clientX, event.clientY);
          return;
        }
        const organ = hitTest(event.clientX, event.clientY)?.object.userData.organId as string | undefined;
        renderer.domElement.style.cursor = organ ? "pointer" : "grab";
        tooltip.hidden = !organ;
        if (organ) {
          const rect = element.getBoundingClientRect();
          tooltip.textContent = ORGAN_LABELS[organ] || organ;
          tooltip.style.left = `${Math.min(event.clientX - rect.left + 14, rect.width - 110)}px`;
          tooltip.style.top = `${Math.max(48, event.clientY - rect.top + 16)}px`;
        }
      });
    };
    const onPointerLeave = () => {
      pointerDown = false;
      tooltip.hidden = true;
      renderer.domElement.style.cursor = "grab";
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);

    const resize = () => {
      const width = Math.max(1, element.clientWidth);
      const height = Math.max(1, element.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, width < 768 ? 1.45 : 1.7));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      rebuildExplosionLayout();
      updateExplosionState(currentExplode);
      if (currentExplode > 0.45) fitExplosionCamera(currentExplode);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(element);
    resize();

    const clock = new THREE.Clock();
    const animate = () => {
      if (disposed) return;
      animationFrame = requestAnimationFrame(animate);
      const delta = Math.min(0.05, clock.getDelta());
      if (lastVisualRevision !== visualRevisionRef.current) {
        updateVisualState();
        lastVisualRevision = visualRevisionRef.current;
      }
      abnormalOverlayMaterial.opacity = 0.7 + Math.sin(clock.elapsedTime * 2.8) * 0.12;
      const targetExplode = THREE.MathUtils.clamp(explodeRef.current, 0, 1);
      if (Math.abs(targetExplode - currentExplode) > 0.0005) {
        currentExplode = THREE.MathUtils.lerp(currentExplode, targetExplode, 1 - Math.exp(-9 * delta));
        if (Math.abs(targetExplode - currentExplode) < 0.001) currentExplode = targetExplode;
        updateExplosionState(currentExplode);
        fitExplosionCamera(currentExplode);
      }
      if (lastResetKey !== resetKeyRef.current) {
        if (currentExplode < 0.001) resetCamera();
        else fitExplosionCamera(currentExplode);
        lastResetKey = resetKeyRef.current;
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onContextLost = (event: Event) => {
      event.preventDefault();
      onError("3D 会话已暂停，请刷新页面后重试");
    };
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);

    return () => {
      disposed = true;
      abortController.abort();
      cancelAnimationFrame(animationFrame);
      if (hoverFrame) cancelAnimationFrame(hoverFrame);
      resizeObserver.disconnect();
      controls.dispose();
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      environment.dispose();
      highlightTexture.dispose();
      partStateTexture.dispose();
      tooltip.remove();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [atlas, anatomySexRef, explodeRef, onError, onProgress, onSelectRef, resetKeyRef, selectedRef, statusesRef, visibleSystemsRef, visualRevisionRef]);

  return <div ref={host} className="human-atlas-viewer" />;
}

export function AnatomyScene({ selected, statuses, onSelect, resetKey, anatomySex, visibleSystems, explode }: AnatomySceneProps) {
  const [atlas, setAtlas] = useState<HumanAtlas | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const selectedRef = useRef(selected);
  const statusesRef = useRef(statuses);
  const anatomySexRef = useRef(anatomySex);
  const visibleSystemsRef = useRef(visibleSystems);
  const explodeRef = useRef(explode);
  const resetKeyRef = useRef(resetKey);
  const onSelectRef = useRef(onSelect);
  const visualRevisionRef = useRef(0);
  selectedRef.current = selected;
  statusesRef.current = statuses;
  anatomySexRef.current = anatomySex;
  visibleSystemsRef.current = visibleSystems;
  explodeRef.current = explode;
  resetKeyRef.current = resetKey;
  onSelectRef.current = onSelect;

  useEffect(() => {
    visualRevisionRef.current += 1;
  }, [selected, statuses, anatomySex, visibleSystems]);

  useEffect(() => {
    const abortController = new AbortController();
    setAtlas(null);
    setProgress(0);
    setError("");
    fetch(`${MODEL_ROOT}/atlas.json`, { signal: abortController.signal })
      .then((response) => {
        if (!response.ok) throw new Error("人体图谱索引加载失败");
        return response.json() as Promise<HumanAtlas>;
      })
      .then(setAtlas)
      .catch((reason) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(reason instanceof Error ? reason.message : "人体图谱加载失败");
        }
      });
    return () => abortController.abort();
  }, []);

  return (
    <div className="human-atlas-root">
      {atlas && (
        <Viewer
          atlas={atlas}
          selectedRef={selectedRef}
          statusesRef={statusesRef}
          anatomySexRef={anatomySexRef}
          visibleSystemsRef={visibleSystemsRef}
          explodeRef={explodeRef}
          resetKeyRef={resetKeyRef}
          visualRevisionRef={visualRevisionRef}
          onSelectRef={onSelectRef}
          onProgress={setProgress}
          onError={setError}
        />
      )}
      {!error && progress < 100 && (
        <div className="human-atlas-loading" role="status">
          <span className="human-atlas-loading-ring" aria-hidden="true" />
          <div><strong>正在准备人体图谱</strong><span>{progress}% · 2,234 个解剖网格</span></div>
        </div>
      )}
      {error && <div className="human-atlas-error" role="alert">{error}</div>}
      <div className="human-atlas-source">Human Atlas · BodyParts3D 4.0</div>
    </div>
  );
}
