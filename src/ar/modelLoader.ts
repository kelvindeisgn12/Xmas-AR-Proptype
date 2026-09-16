import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { WearableAdjust, WearableConfig } from "./types";

export type LoadedWearable = {
  pivot: THREE.Group;
  model: THREE.Object3D;
  measuredDimension: number;
  hasSkeleton: boolean;
};

const loader = new GLTFLoader();
const modelCache = new Map<string, Promise<THREE.Object3D>>();

const fetchModel = (url: string) => {
  let request = modelCache.get(url);
  if (!request) {
    request = loader.loadAsync(url).then(({ scene }) => scene);
    modelCache.set(url, request);
  }
  return request;
};

export const hasSkinnedMesh = (root: THREE.Object3D) => {
  let found = false;
  root.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) found = true;
  });
  return found;
};

const curveRigidModel = (model: THREE.Object3D, depth: number) => {
  const initialBox = new THREE.Box3().setFromObject(model);
  const centreX = (initialBox.min.x + initialBox.max.x) * 0.5;
  const halfWidth = Math.max((initialBox.max.x - initialBox.min.x) * 0.5, 0.001);

  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || !mesh.geometry?.attributes?.position) return;

    mesh.geometry = mesh.geometry.clone();
    const position = mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let index = 0; index < position.count; index += 1) {
      const normalizedX = THREE.MathUtils.clamp(
        (position.getX(index) - centreX) / halfWidth,
        -1,
        1,
      );
      position.setZ(
        index,
        position.getZ(index) - depth * Math.pow(Math.abs(normalizedX), 1.65),
      );
    }
    position.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
  });
};

export const loadWearableModel = async (config: WearableConfig): Promise<LoadedWearable> => {
  let source: THREE.Object3D;
  try {
    source = await fetchModel(config.modelUrl);
  } catch (error) {
    throw new Error(`Unable to load ${config.label}. Check that its GLB file exists.`, { cause: error });
  }

  const sourceHasSkeleton = hasSkinnedMesh(source);
  const model = sourceHasSkeleton ? cloneSkeleton(source) : source.clone(true);
  model.updateMatrixWorld(true);

  if (config.wrapDepth && !sourceHasSkeleton) {
    curveRigidModel(model, config.wrapDepth);
    model.updateMatrixWorld(true);
  }

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const mountPoint = new THREE.Vector3(
    THREE.MathUtils.lerp(box.min.x, box.max.x, config.mount[0]),
    THREE.MathUtils.lerp(box.min.y, box.max.y, config.mount[1]),
    THREE.MathUtils.lerp(box.min.z, box.max.z, config.mount[2]),
  );
  model.position.sub(mountPoint);
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.renderOrder = 1;
      mesh.frustumCulled = false;
    }
  });

  const measuredDimension = config.measureAxis === "x"
    ? size.x
    : config.measureAxis === "y"
      ? size.y
      : Math.max(size.x, size.y, size.z);

  const pivot = new THREE.Group();
  pivot.name = `wearable:${config.id}`;
  pivot.add(model);
  pivot.visible = false;

  return {
    pivot,
    model,
    measuredDimension: measuredDimension || 1,
    hasSkeleton: sourceHasSkeleton,
  };
};

export const applyFaceAdjust = (
  pivot: THREE.Group,
  measuredDimension: number,
  adjust: WearableAdjust,
) => {
  pivot.scale.setScalar(adjust.scale / measuredDimension);
  pivot.position.set(adjust.ox, adjust.oy, adjust.oz);
  pivot.rotation.set(
    THREE.MathUtils.degToRad(adjust.rx),
    THREE.MathUtils.degToRad(adjust.ry),
    THREE.MathUtils.degToRad(adjust.rz),
  );
};
