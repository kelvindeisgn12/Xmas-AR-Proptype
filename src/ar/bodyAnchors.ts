import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import * as THREE from "three";
import type { BodyAnchorName, WearableAdjust } from "./types";

export type BodyAnchorPose = {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  bodyScale: number;
  confidence: number;
  visible: boolean;
};

const ANCHOR_NAMES: BodyAnchorName[] = [
  "head",
  "neck",
  "chest",
  "torso",
  "leftShoulder",
  "rightShoulder",
  "shoulderCenter",
  "hipCenter",
  "leftWrist",
  "rightWrist",
];

const lerpAngle = (from: number, to: number, amount: number) => {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * amount;
};

const averageVisibility = (points: Array<NormalizedLandmark | undefined>) => {
  if (points.some((point) => !point)) return 0;
  return points.reduce((total, point) => total + (point?.visibility ?? 1), 0) / points.length;
};

const averagePoint = (
  output: NormalizedLandmark,
  points: NormalizedLandmark[],
  indices: number[],
) => {
  output.x = 0;
  output.y = 0;
  output.z = 0;
  output.visibility = 0;
  for (const index of indices) {
    const point = points[index];
    output.x += point.x;
    output.y += point.y;
    output.z += point.z;
    output.visibility! += point.visibility ?? 1;
  }
  const divisor = Math.max(indices.length, 1);
  output.x /= divisor;
  output.y /= divisor;
  output.z /= divisor;
  output.visibility! /= divisor;
  return output;
};

const posePointToWorld = (
  landmark: NormalizedLandmark,
  camera: THREE.PerspectiveCamera,
  output: THREE.Vector3,
  planeZ = -10,
) => {
  let mappedX = landmark.x;
  let mappedY = landmark.y;
  if (camera.userData.coverTransform) {
    const sourceAspect = Number(camera.userData.sourceAspect) || camera.aspect;
    const viewportAspect = Number(camera.userData.viewportAspect) || camera.aspect;
    if (sourceAspect > viewportAspect) {
      const visibleFraction = viewportAspect / sourceAspect;
      mappedX = (mappedX - (1 - visibleFraction) * 0.5) / visibleFraction;
    } else if (sourceAspect < viewportAspect) {
      const visibleFraction = sourceAspect / viewportAspect;
      mappedY = (mappedY - (1 - visibleFraction) * 0.5) / visibleFraction;
    }
  }
  output.set(mappedX * 2 - 1, 1 - mappedY * 2, 0.5).unproject(camera);
  output.sub(camera.position).normalize();
  const distance = (planeZ - camera.position.z) / output.z;
  return output.multiplyScalar(distance).add(camera.position);
};

const makeAnchorPose = (): BodyAnchorPose => ({
  position: new THREE.Vector3(),
  rotation: new THREE.Euler(),
  bodyScale: 0,
  confidence: 0,
  visible: false,
});

/**
 * Converts MediaPipe pose landmarks into reusable body attachment points.
 * Image-space landmarks provide correct overlay position/scale while world-space
 * landmarks provide torso yaw. Each anchor keeps its own smoothed state.
 */
export class BodyAnchorSolver {
  private readonly anchors = new Map<BodyAnchorName, BodyAnchorPose>(
    ANCHOR_NAMES.map((name) => [name, makeAnchorPose()]),
  );

  private readonly initialized = new Set<BodyAnchorName>();
  private readonly scratchNormalized: NormalizedLandmark[] = Array.from(
    { length: 6 },
    () => ({ x: 0, y: 0, z: 0, visibility: 0 }),
  );
  private readonly scratchWorld = Array.from({ length: 4 }, () => new THREE.Vector3());

  reset() {
    this.initialized.clear();
    this.anchors.forEach((anchor) => {
      anchor.visible = false;
      anchor.confidence = 0;
    });
  }

  get(name: BodyAnchorName) {
    return this.anchors.get(name)!;
  }

  update(
    landmarks: NormalizedLandmark[] | undefined,
    worldLandmarks: Landmark[] | undefined,
    camera: THREE.PerspectiveCamera,
    deltaSeconds: number,
  ) {
    if (!landmarks || landmarks.length < 33) {
      this.anchors.forEach((anchor) => { anchor.visible = false; });
      return this.anchors;
    }

    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];
    const leftHip = landmarks[23];
    const rightHip = landmarks[24];
    const shoulderConfidence = averageVisibility([leftShoulder, rightShoulder]);
    const torsoConfidence = averageVisibility([leftShoulder, rightShoulder, leftHip, rightHip]);

    const shoulderCenter = averagePoint(this.scratchNormalized[0], landmarks, [11, 12]);
    const hipCenter = averagePoint(this.scratchNormalized[1], landmarks, [23, 24]);
    const earCenter = averagePoint(this.scratchNormalized[2], landmarks, [7, 8]);
    // MediaPipe has shoulder joints but no explicit base-of-neck point. Place a
    // synthetic neck point just above the shoulder line so a garment's authored
    // collar seam sits on the wearer instead of drifting down over the chest.
    const shoulderSpan2D = Math.hypot(
      rightShoulder.x - leftShoulder.x,
      rightShoulder.y - leftShoulder.y,
    );
    const neck = this.scratchNormalized[5];
    neck.x = shoulderCenter.x;
    neck.y = shoulderCenter.y - shoulderSpan2D * 0.065;
    neck.z = shoulderCenter.z;
    neck.visibility = shoulderConfidence;
    const chest = this.scratchNormalized[3];
    chest.x = THREE.MathUtils.lerp(shoulderCenter.x, hipCenter.x, 0.3);
    chest.y = THREE.MathUtils.lerp(shoulderCenter.y, hipCenter.y, 0.3);
    chest.z = THREE.MathUtils.lerp(shoulderCenter.z, hipCenter.z, 0.3);
    chest.visibility = torsoConfidence;
    const torso = this.scratchNormalized[4];
    torso.x = THREE.MathUtils.lerp(shoulderCenter.x, hipCenter.x, 0.52);
    torso.y = THREE.MathUtils.lerp(shoulderCenter.y, hipCenter.y, 0.52);
    torso.z = THREE.MathUtils.lerp(shoulderCenter.z, hipCenter.z, 0.52);
    torso.visibility = torsoConfidence;

    const anatomicalLeft = posePointToWorld(leftShoulder, camera, this.scratchWorld[0]);
    const anatomicalRight = posePointToWorld(rightShoulder, camera, this.scratchWorld[1]);
    const leftIsScreenLeft = leftShoulder.x <= rightShoulder.x;
    const screenLeft = leftIsScreenLeft ? anatomicalLeft : anatomicalRight;
    const screenRight = leftIsScreenLeft ? anatomicalRight : anatomicalLeft;
    const bodyScale = Math.max(screenLeft.distanceTo(screenRight), 0.001);
    const roll = Math.atan2(screenRight.y - screenLeft.y, screenRight.x - screenLeft.x);

    const worldLeft = worldLandmarks?.[11];
    const worldRight = worldLandmarks?.[12];
    const worldLeftHip = worldLandmarks?.[23];
    const worldRightHip = worldLandmarks?.[24];
    const yaw = worldLeft && worldRight
      ? THREE.MathUtils.clamp(
        Math.atan2(worldRight.z - worldLeft.z, Math.abs(worldRight.x - worldLeft.x)) * 1.18,
        -Math.PI * 0.48,
        Math.PI * 0.48,
      )
      : 0;
    const pitch = worldLeft && worldRight && worldLeftHip && worldRightHip
      ? THREE.MathUtils.clamp(
        -Math.atan2(
          (worldLeft.z + worldRight.z - worldLeftHip.z - worldRightHip.z) * 0.5,
          Math.abs((worldLeft.y + worldRight.y - worldLeftHip.y - worldRightHip.y) * 0.5),
        ),
        -Math.PI * 0.28,
        Math.PI * 0.28,
      )
      : 0;

    const targets: Array<[
      BodyAnchorName,
      NormalizedLandmark,
      number,
      number,
      number,
      number,
    ]> = [
      ["head", earCenter, averageVisibility([landmarks[7], landmarks[8]]), pitch, yaw, roll],
      ["neck", neck, shoulderConfidence, pitch, yaw, roll],
      ["chest", chest, torsoConfidence, pitch, yaw, roll],
      ["torso", torso, torsoConfidence, pitch, yaw, roll],
      ["leftShoulder", leftShoulder, leftShoulder.visibility ?? 1, pitch, yaw, roll],
      ["rightShoulder", rightShoulder, rightShoulder.visibility ?? 1, pitch, yaw, roll],
      ["shoulderCenter", shoulderCenter, shoulderConfidence, pitch, yaw, roll],
      ["hipCenter", hipCenter, averageVisibility([leftHip, rightHip]), pitch, yaw, roll],
      ["leftWrist", landmarks[15], landmarks[15].visibility ?? 1, pitch, yaw, roll],
      ["rightWrist", landmarks[16], landmarks[16].visibility ?? 1, pitch, yaw, roll],
    ];

    const amount = 1 - Math.exp(-Math.min(Math.max(deltaSeconds, 1 / 120), 0.1) * 12);
    for (const [name, point, confidence, targetPitch, targetYaw, targetRoll] of targets) {
      const anchor = this.anchors.get(name)!;
      anchor.confidence = confidence;
      anchor.visible = confidence >= 0.5;
      if (!anchor.visible) continue;

      const targetPosition = posePointToWorld(point, camera, this.scratchWorld[2]);
      if (!this.initialized.has(name)) {
        anchor.position.copy(targetPosition);
        anchor.rotation.set(targetPitch, targetYaw, targetRoll);
        anchor.bodyScale = bodyScale;
        this.initialized.add(name);
      } else {
        anchor.position.lerp(targetPosition, amount);
        anchor.rotation.x = lerpAngle(anchor.rotation.x, targetPitch, amount * 0.75);
        anchor.rotation.y = lerpAngle(anchor.rotation.y, targetYaw, amount * 0.8);
        anchor.rotation.z = lerpAngle(anchor.rotation.z, targetRoll, amount);
        anchor.bodyScale = THREE.MathUtils.lerp(anchor.bodyScale, bodyScale, amount * 0.9);
      }
    }

    return this.anchors;
  }
}

export const applyRigidBodyAnchor = (
  pivot: THREE.Group,
  measuredDimension: number,
  anchor: BodyAnchorPose,
  adjust: WearableAdjust,
  faceCamera = false,
) => {
  const width = anchor.bodyScale;
  const cos = Math.cos(anchor.rotation.z);
  const sin = Math.sin(anchor.rotation.z);

  pivot.position.copy(anchor.position);
  pivot.position.x += cos * adjust.ox * width - sin * adjust.oy * width;
  pivot.position.y += sin * adjust.ox * width + cos * adjust.oy * width;
  pivot.position.z += adjust.oz * width;
  pivot.scale.setScalar((width * adjust.scale) / Math.max(measuredDimension, 0.001));
  pivot.rotation.set(
    (faceCamera ? 0 : anchor.rotation.x) + THREE.MathUtils.degToRad(adjust.rx),
    (faceCamera ? 0 : anchor.rotation.y) + THREE.MathUtils.degToRad(adjust.ry),
    anchor.rotation.z + THREE.MathUtils.degToRad(adjust.rz),
  );
  pivot.visible = anchor.visible;
};
