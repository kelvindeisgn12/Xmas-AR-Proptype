import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import * as THREE from "three";

export type SecondaryFaceAnchor = {
  group: THREE.Group;
  pivot: THREE.Group;
  measuredDimension: number;
  landmarkIndex: number;
  initialized: boolean;
};

type FaceLandmarkerResultLike = {
  faceLandmarks?: NormalizedLandmark[][];
  faceBlendshapes?: unknown[];
  facialTransformationMatrixes?: unknown[];
};

/**
 * MindAR creates MediaPipe's FaceLandmarker internally with numFaces=1. Upgrade
 * that same detector to two faces and sort its output by screen position so the
 * first face remains User 1 and the second face remains User 2.
 */
export const enableTwoFaceTracking = (
  mindar: any,
  onFaces: (faces: NormalizedLandmark[][]) => void,
) => {
  const controller = mindar.controller;
  const originalSetup = controller.setup.bind(controller);

  controller.setup = async (flipFace: boolean) => {
    await originalSetup(flipFace);
    const helper = controller.faceMeshHelper;
    await helper.faceLandmarker.setOptions({ numFaces: 2 });
    const originalDetect = helper.detect.bind(helper);

    helper.detect = async (input: HTMLVideoElement | HTMLCanvasElement) => {
      const result = await originalDetect(input) as FaceLandmarkerResultLike;
      const faces = result.faceLandmarks ?? [];
      const order = faces
        .map((face, index) => ({ index, centreX: face[1]?.x ?? face[0]?.x ?? 0 }))
        .sort((a, b) => a.centreX - b.centreX)
        .map(({ index }) => index);

      result.faceLandmarks = order.map((index) => faces[index]);
      if (result.faceBlendshapes?.length) {
        const blendshapes = result.faceBlendshapes;
        result.faceBlendshapes = order.map((index) => blendshapes[index]);
      }
      if (result.facialTransformationMatrixes?.length) {
        const matrices = result.facialTransformationMatrixes;
        result.facialTransformationMatrixes = order.map((index) => matrices[index]);
      }
      onFaces(result.faceLandmarks);
      return result;
    };
  };
};

const landmarkMatrix = (estimate: any, landmarkIndex: number) => {
  const { metricLandmarks, faceMatrix, faceScale } = estimate;
  const fm = faceMatrix as number[];
  const t = metricLandmarks[landmarkIndex] as number[];
  const s = faceScale as number;
  return new THREE.Matrix4().set(
    fm[0] * s, fm[1] * s, fm[2] * s, fm[0] * t[0] + fm[1] * t[1] + fm[2] * t[2] + fm[3],
    fm[4] * s, fm[5] * s, fm[6] * s, fm[4] * t[0] + fm[5] * t[1] + fm[6] * t[2] + fm[7],
    fm[8] * s, fm[9] * s, fm[10] * s, fm[8] * t[0] + fm[9] * t[1] + fm[10] * t[2] + fm[11],
    fm[12] * s, fm[13] * s, fm[14] * s, fm[12] * t[0] + fm[13] * t[1] + fm[14] * t[2] + fm[15],
  );
};

export const updateFaceAnchorsFromEstimate = (
  anchors: SecondaryFaceAnchor[],
  estimate: any,
  visible: boolean,
) => {
  const usable = Number.isFinite(estimate?.faceScale)
    && estimate.faceScale > 0
    && [10, 103, 109, 152, 168, 332, 338].every((index) =>
      estimate.metricLandmarks?.[index]?.every(Number.isFinite)
    );

  if (!usable) {
    anchors.forEach(({ group }) => { group.visible = false; });
    return false;
  }

  for (const anchor of anchors) {
    // Match MindAR's own anchor implementation exactly. Keeping the complete
    // matrix preserves its handedness; decomposing it into position/quaternion/
    // scale can lose the reflected axis and place User 2 off-screen.
    anchor.group.matrix.copy(landmarkMatrix(estimate, anchor.landmarkIndex));
    anchor.group.matrixWorldNeedsUpdate = true;
    anchor.initialized = true;
    anchor.pivot.visible = visible;
    anchor.group.visible = visible;
  }
  return true;
};

export const updateSecondaryFaceAnchors = (
  anchors: SecondaryFaceAnchor[],
  landmarks: NormalizedLandmark[] | undefined,
  estimator: any,
  visible: boolean,
) => {
  if (!landmarks || landmarks.length < 468 || !estimator) {
    anchors.forEach(({ group }) => { group.visible = false; });
    return false;
  }

  const estimate = estimator.estimate(landmarks.map(({ x, y, z }) => [x, y, z]));
  return updateFaceAnchorsFromEstimate(anchors, estimate, visible);
};

export const hideSecondaryFaceAnchors = (anchors: SecondaryFaceAnchor[]) => {
  anchors.forEach((anchor) => {
    anchor.pivot.visible = false;
    anchor.group.visible = false;
    anchor.initialized = false;
  });
};
