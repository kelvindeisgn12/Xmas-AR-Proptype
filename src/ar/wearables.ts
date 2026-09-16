import * as THREE from "three";
import type { ARItemId, WearableAdjust, WearableConfig } from "./types";

const CHRISTMAS_BELL_URL = new URL(
  "../assets/models/christmas_bell.glb",
  import.meta.url,
).href;
const SNOWMAN_1_URL = new URL(
  "../assets/models/snowman_1.glb",
  import.meta.url,
).href;
const SNOWMAN_2_URL = new URL(
  "../assets/models/snowman_2.glb",
  import.meta.url,
).href;
const SECRET_GLASSES_URL = new URL(
  "../assets/models/secret_glasses.glb",
  import.meta.url,
).href;
const SANTA_BEARD_URL = new URL(
  "../assets/models/santa_beard.glb",
  import.meta.url,
).href;
const BOW_1_URL = new URL(
  "../assets/models/bow1.glb",
  import.meta.url,
).href;

export const BODY_ITEMS: readonly ARItemId[] = ["snowman_1", "snowman_2"];
export const WEARABLES: Record<ARItemId, WearableConfig> = {
  christmas_bell: {
    id: "christmas_bell",
    modelUrl: CHRISTMAS_BELL_URL,
    label: "Christmas Bell Hair Clip",
    trackingType: "rigid",
    // MediaPipe face oval point 338 sits at the upper-right hairline in the
    // mirrored front-camera view used by this screen.
    faceLandmarks: [338],
    measureAxis: "max",
    mount: [0.5, 0.5, 0.5],
    scaleMultiplier: 0.26,
    positionOffset: [0.1, 0.08, 0.03],
    rotationOffset: [0, 0, THREE.MathUtils.degToRad(-12)],
    tracking: { body: false, face: true, hands: false, ignoreLegs: true },
  },
  secret_glasses: {
    id: "secret_glasses",
    modelUrl: SECRET_GLASSES_URL,
    label: "Secret Glasses",
    trackingType: "rigid",
    // Nose-bridge centre: stable for eyewear across head translation and yaw.
    faceLandmarks: [168],
    measureAxis: "x",
    // The GLB's front plane is at its maximum Z; its temple arms extend behind it.
    mount: [0.5, 0.5, 1],
    scaleMultiplier: 0.95,
    positionOffset: [0, -0.02, 0.05],
    rotationOffset: [0, 0, 0],
    tracking: { body: false, face: true, hands: false, ignoreLegs: true },
  },
  santa_beard: {
    id: "santa_beard",
    modelUrl: SANTA_BEARD_URL,
    label: "Santa Beard",
    trackingType: "rigid",
    // MediaPipe point 152 is the centre-bottom of the chin.
    faceLandmarks: [152],
    measureAxis: "x",
    // Keep most of the beard below the chin while allowing its upper edge to
    // cover the lower lip area. The model front is its maximum-Z surface.
    mount: [0.5, 0.68, 1],
    scaleMultiplier: 0.78,
    positionOffset: [-0.1, 0.2, -0.12],
    rotationOffset: [
      THREE.MathUtils.degToRad(-4),
      THREE.MathUtils.degToRad(-158),
      THREE.MathUtils.degToRad(-5),
    ],
    tracking: { body: false, face: true, hands: false, ignoreLegs: true },
  },
  bow1: {
    id: "bow1",
    modelUrl: BOW_1_URL,
    label: "Twin Hair Bows",
    trackingType: "rigid",
    // Symmetric upper face-oval points at the left and right hairline. The face
    // engine creates one independent bow instance for every landmark listed.
    faceLandmarks: [103, 332],
    measureAxis: "x",
    // Centre each bow on its hairline anchor and keep the front face toward camera.
    mount: [0.5, 0.5, 1],
    scaleMultiplier: 0.18,
    positionOffset: [0, 0.1, 0.05],
    rotationOffset: [0, 0, 0],
    tracking: { body: false, face: true, hands: false, ignoreLegs: true },
  },
  snowman_1: {
    id: "snowman_1",
    modelUrl: SNOWMAN_1_URL,
    label: "Snowman 1",
    trackingType: "rigid",
    bodyAnchor: "leftShoulder",
    personSlot: 0,
    minPeople: 1,
    measureAxis: "y",
    // Anchor the snowman's feet to the shoulder instead of centring its body.
    mount: [0.5, 0, 0.5],
    scaleMultiplier: 0.35,
    positionOffset: [0, 0.04, 0.06],
    // The imported model's authored front points along local -X. Rotate it into
    // camera space, then suppress torso pitch/yaw so its face never turns sideways.
    rotationOffset: [0, THREE.MathUtils.degToRad(90), 0],
    faceCamera: true,
    tracking: { body: true, face: false, hands: false, ignoreLegs: true },
  },
  snowman_2: {
    id: "snowman_2",
    modelUrl: SNOWMAN_2_URL,
    label: "Snowman 2",
    trackingType: "rigid",
    bodyAnchor: "rightShoulder",
    personSlot: 1,
    minPeople: 2,
    measureAxis: "y",
    mount: [0.5, 0, 0.5],
    scaleMultiplier: 0.35,
    positionOffset: [0, 0.04, 0.06],
    rotationOffset: [0, THREE.MathUtils.degToRad(90), 0],
    faceCamera: true,
    tracking: { body: true, face: false, hands: false, ignoreLegs: true },
  },
};

export type ARCatalogueItem = {
  id: ARItemId;
  label: string;
  sublabel: string;
  emoji: string;
  tracking: "Body" | "Face";
};

export const AR_CATALOGUE: readonly ARCatalogueItem[] = [
  {
    id: "christmas_bell",
    label: "Christmas Bell Hair Clip",
    sublabel: "Upper-right hair",
    emoji: "🔔",
    tracking: "Face",
  },
  {
    id: "secret_glasses",
    label: "Secret Glasses",
    sublabel: "Eyes · nose bridge",
    emoji: "🕶️",
    tracking: "Face",
  },
  {
    id: "santa_beard",
    label: "Santa Beard",
    sublabel: "Chin · lower face",
    emoji: "🎅",
    tracking: "Face",
  },
  {
    id: "bow1",
    label: "Twin Hair Bows",
    sublabel: "Left + right hair",
    emoji: "🎀",
    tracking: "Face",
  },
  {
    id: "snowman_1",
    label: "Snowman 1",
    sublabel: "User 1 · left shoulder",
    emoji: "⛄",
    tracking: "Body",
  },
  {
    id: "snowman_2",
    label: "Snowman 2",
    sublabel: "User 2 · right shoulder",
    emoji: "☃️",
    tracking: "Body",
  },
];

export const defaultAdjust = (config: WearableConfig): WearableAdjust => ({
  scale: config.scaleMultiplier,
  ox: config.positionOffset[0],
  oy: config.positionOffset[1],
  oz: config.positionOffset[2],
  rx: THREE.MathUtils.radToDeg(config.rotationOffset[0]),
  ry: THREE.MathUtils.radToDeg(config.rotationOffset[1]),
  rz: THREE.MathUtils.radToDeg(config.rotationOffset[2]),
});

export const getTrackingNeeds = (ids: ARItemId[]) => ids.reduce(
  (needs, id) => {
    const config = WEARABLES[id];
    if (!config) return needs;
    return {
      body: needs.body || config.tracking.body,
      face: needs.face || config.tracking.face,
      hands: needs.hands || config.tracking.hands,
      ignoreLegs: needs.ignoreLegs && config.tracking.ignoreLegs,
      rigged: needs.rigged || config.trackingType === "rigged",
    };
  },
  { body: false, face: false, hands: false, ignoreLegs: true, rigged: false },
);
