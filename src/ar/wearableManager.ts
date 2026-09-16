import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import * as THREE from "three";
import type { BindingHandler } from "three-mediapipe-rig";
import { applyRigidBodyAnchor, BodyAnchorSolver } from "./bodyAnchors";
import { loadWearableModel, type LoadedWearable } from "./modelLoader";
import type { WearableAdjust, WearableConfig } from "./types";
import type { RigTracker } from "./tracker";

export class WearableManager {
  private readonly solver = new BodyAnchorSolver();
  private lastUpdateTime = performance.now();
  private wearable: LoadedWearable | null = null;
  private binding: BindingHandler | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly config: WearableConfig,
  ) {}

  async load() {
    this.wearable = await loadWearableModel(this.config);
    this.scene.add(this.wearable.pivot);
    return this.wearable;
  }

  bindRig(tracker: RigTracker) {
    if (!this.wearable) throw new Error(`${this.config.label} has not finished loading.`);
    if (this.config.trackingType !== "rigged") return;
    if (!this.wearable.hasSkeleton) {
      throw new Error(`${this.config.label} needs an authored SkinnedMesh skeleton for clothing tracking.`);
    }
    this.binding = tracker.bind(this.wearable.model, this.config.boneMap);
  }

  update(
    landmarks: NormalizedLandmark[] | undefined,
    worldLandmarks: Landmark[] | undefined,
    adjust: WearableAdjust,
  ) {
    if (!this.wearable || !this.config.bodyAnchor) return false;
    const now = performance.now();
    const delta = Math.min(Math.max((now - this.lastUpdateTime) / 1000, 1 / 120), 0.1);
    this.lastUpdateTime = now;
    const anchors = this.solver.update(landmarks, worldLandmarks, this.camera, delta);
    const anchor = anchors.get(this.config.bodyAnchor)!;

    // A rigged garment still needs its root positioned and scaled in camera space;
    // its SkinnedMesh bones are then updated independently by the rig binding.
    applyRigidBodyAnchor(
      this.wearable.pivot,
      this.wearable.measuredDimension,
      anchor,
      adjust,
      this.config.faceCamera,
    );
    this.binding?.update(delta);
    return anchor.visible;
  }

  setVisible(visible: boolean) {
    if (this.wearable) this.wearable.pivot.visible = visible;
  }

  getRenderable() {
    return this.wearable;
  }

  reset() {
    this.solver.reset();
    this.lastUpdateTime = performance.now();
    this.setVisible(false);
  }

  dispose() {
    this.binding = null;
    this.solver.reset();
    if (this.wearable) {
      this.scene.remove(this.wearable.pivot);
      this.wearable = null;
    }
  }
}
