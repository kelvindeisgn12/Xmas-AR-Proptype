// Model IDs are data-driven so a completely new catalogue can be added without
// changing the tracking engine's shared types.
export type ARItemId = string;

export type BodyAnchorName =
  | "head"
  | "neck"
  | "chest"
  | "torso"
  | "leftShoulder"
  | "rightShoulder"
  | "shoulderCenter"
  | "hipCenter"
  | "leftWrist"
  | "rightWrist";

export type WearableTrackingType = "rigid" | "rigged";
export type RigBoneMap = Partial<Record<string, string>>;

export type WearableConfig = {
  id: ARItemId;
  modelUrl: string;
  label: string;
  trackingType: WearableTrackingType;
  bodyAnchor?: BodyAnchorName;
  /** Zero-based person slot after visible poses are sorted from screen-left to screen-right. */
  personSlot?: 0 | 1;
  /** Minimum number of visible people required before this wearable is revealed. */
  minPeople?: 1 | 2;
  faceLandmarks?: number[];
  measureAxis: "x" | "y" | "max";
  mount: [number, number, number];
  scaleMultiplier: number;
  positionOffset: [number, number, number];
  rotationOffset: [number, number, number];
  /** Keep a rigid prop facing the camera instead of inheriting torso pitch/yaw. */
  faceCamera?: boolean;
  wrapDepth?: number;
  boneMap?: RigBoneMap;
  tracking: {
    body: boolean;
    face: boolean;
    hands: boolean;
    ignoreLegs: boolean;
  };
};

export type WearableAdjust = {
  scale: number;
  ox: number;
  oy: number;
  oz: number;
  rx: number;
  ry: number;
  rz: number;
};
