import type { BindingHandler, TrackerHandler, VideoHandler } from "three-mediapipe-rig";
import { setupTracker } from "three-mediapipe-rig";
import type * as THREE from "three";
import type { RigBoneMap } from "./types";

export type RigTrackerOptions = {
  ignoreLegs?: boolean;
  enableFace?: boolean;
  poseModelPath?: string;
  wasmPath?: string;
};

export class RigTracker {
  private tracker: TrackerHandler | null = null;
  private videoHandle: VideoHandler | null = null;

  async initialize(options: RigTrackerOptions = {}) {
    if (this.tracker) return this.tracker;

    this.tracker = await setupTracker({
      ignoreLegs: options.ignoreLegs ?? true,
      ignoreFace: !(options.enableFace ?? false),
      displayScale: 0.01,
      drawLandmarksOverlay: false,
      modelPaths: {
        vision: options.wasmPath ?? `${import.meta.env.BASE_URL}mediapipe/wasm`,
        pose: options.poseModelPath ?? `${import.meta.env.BASE_URL}mediapipe/models/pose_landmarker_lite.task`,
        // three-mediapipe-rig 0.1.41 initializes its hand binder together with
        // skeletal rigs. Keep its documented model available for that pathway;
        // the rigid body-only prototype never initializes this class.
        hand: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        face: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      },
    });

    // The package owns a diagnostic DOM layer. The existing app owns the visible
    // camera and UI, so keep diagnostics inert unless a developer enables them.
    if (this.tracker.domElement) {
      this.tracker.domElement.hidden = true;
      this.tracker.domElement.setAttribute("aria-hidden", "true");
    }
    if (this.tracker.video) {
      this.tracker.video.playsInline = true;
      this.tracker.video.muted = true;
    }
    return this.tracker;
  }

  async start() {
    if (!this.tracker) throw new Error("Body tracker has not been initialized.");
    if (this.videoHandle) return this.videoHandle;
    this.videoHandle = await this.tracker.start(false);
    return this.videoHandle;
  }

  bind(rig: THREE.Object3D, boneMap?: RigBoneMap): BindingHandler {
    if (!this.tracker) throw new Error("Body tracker has not been initialized.");
    return this.tracker.bind(rig, boneMap as never);
  }

  update(binding: BindingHandler | null, deltaSeconds: number) {
    binding?.update(deltaSeconds);
  }

  stop() {
    this.videoHandle?.stop();
    this.videoHandle = null;
    this.tracker?.domElement?.remove();
    this.tracker = null;
  }
}

export const getTrackerErrorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|notallowed/i.test(message)) return "Camera permission was not granted.";
  if (/no camera|notfound/i.test(message)) return "No camera is available on this device.";
  if (/in use|notreadable/i.test(message)) return "The camera is being used by another app.";
  if (/webcam not supported/i.test(message)) return "This browser does not support camera tracking.";
  return "Body tracking could not be initialized on this device.";
};
