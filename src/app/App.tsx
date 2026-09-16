import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, RotateCcw, ScanFace, SlidersHorizontal, Sparkles, SwitchCamera, X } from "lucide-react";
import * as THREE from "three";
import {
  FilesetResolver,
  PoseLandmarker,
  type Landmark,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { applyFaceAdjust, loadWearableModel } from "../ar/modelLoader";
import type { ARItemId, WearableAdjust } from "../ar/types";
import { AR_CATALOGUE, defaultAdjust, getTrackingNeeds, WEARABLES } from "../ar/wearables";
import { WearableManager } from "../ar/wearableManager";
import { BodyCameraEngine } from "../ar/bodyCameraEngine";
import {
  enableTwoFaceTracking,
  hideSecondaryFaceAnchors,
  updateFaceAnchorsFromEstimate,
  updateSecondaryFaceAnchors,
  type SecondaryFaceAnchor,
} from "../ar/secondaryFace";
// MindAR face-tracking engine (three.js flavour). The prod bundle ships its own
// TensorFlow face-mesh model, so no extra model URLs are needed.
import { MindARThree } from "mind-ar/dist/mindar-face-three.prod.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type AppScreen = "select" | "camera";
type CameraFacing = "user" | "environment";

type CameraDeviceMap = {
  count: number;
  userDeviceId: string | null;
  environmentDeviceId: string | null;
};

// Changing this value intentionally remounts the complete camera/Three.js graph.
// Vite Fast Refresh otherwise preserves an old MindAR animation loop and its old
// model transforms even though the React labels have already updated.
const AR_ENGINE_REVISION = "two-user-face-accessories-v20";
const POSE_WASM_PATH = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const POSE_MODEL_PATH = `${import.meta.env.BASE_URL}mediapipe/models/pose_landmarker_lite.task`;

// Browser facingMode is only a preference on some mobile browsers. Once camera
// permission has exposed device labels, resolve concrete front/back IDs so a switch
// cannot silently reopen the same camera.
const resolveCameraDevices = async (mindar: any, currentFacing: CameraFacing): Promise<CameraDeviceMap> => {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { count: 0, userDeviceId: null, environmentDeviceId: null };
  }

  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
    (device) => device.kind === "videoinput"
  );
  const currentTrack: MediaStreamTrack | undefined = mindar.video?.srcObject?.getVideoTracks?.()[0];
  const currentDeviceId = currentTrack?.getSettings?.().deviceId || null;

  const isFront = (label: string) => /front|user|facetime|前置|前鏡/i.test(label);
  const isBack = (label: string) => /back|rear|environment|後置|后置|後鏡|背面/i.test(label);
  const isSpecialLens = (label: string) => /ultra|tele|macro|depth|超廣角|长焦|長焦/i.test(label);

  let userDeviceId: string | null = mindar.userDeviceId || inputs.find((d) => isFront(d.label))?.deviceId || null;
  let environmentDeviceId: string | null = mindar.environmentDeviceId
    || inputs.find((d) => isBack(d.label) && !isSpecialLens(d.label))?.deviceId
    || inputs.find((d) => isBack(d.label))?.deviceId
    || null;

  if (currentDeviceId) {
    if (currentFacing === "user") userDeviceId = currentDeviceId;
    else environmentDeviceId = currentDeviceId;
  }

  // Labels may still be blank on some iOS versions. After permission is granted,
  // the current device is known; use another physical input as the opposite camera.
  if (!userDeviceId && currentFacing === "environment") {
    userDeviceId = inputs.find((d) => d.deviceId !== currentDeviceId)?.deviceId || null;
  }
  if (!environmentDeviceId && currentFacing === "user") {
    const alternatives = inputs.filter((d) => d.deviceId !== currentDeviceId);
    environmentDeviceId = alternatives[alternatives.length - 1]?.deviceId || null;
  }

  mindar.userDeviceId = userDeviceId;
  mindar.environmentDeviceId = environmentDeviceId;
  return { count: inputs.length, userDeviceId, environmentDeviceId };
};

const getActiveCameraTrack = (mindar: any): MediaStreamTrack | null =>
  mindar.video?.srcObject?.getVideoTracks?.()[0] || null;

// MindAR's stop() assumes that video/srcObject always exist. During a rapid
// mobile switch that is not guaranteed, so release the stream defensively.
const releaseMindARCamera = (mindar: any) => {
  const video: HTMLVideoElement | undefined = mindar.video;
  const stream = video?.srcObject as MediaStream | null | undefined;
  stream?.getTracks().forEach((track) => track.stop());
  if (video) {
    try { video.pause(); } catch { /* noop */ }
    video.srcObject = null;
    video.remove();
  }
  try { mindar.controller?.stopProcessVideo?.(); } catch { /* noop */ }
};

type TrackedPose = {
  landmarks: NormalizedLandmark[];
  worldLandmarks: Landmark[] | undefined;
  centreX: number;
};

/**
 * MediaPipe does not guarantee a stable array order for multiple poses. Sorting
 * by the shoulder midpoint makes User 1 the screen-left person and User 2 the
 * screen-right person on every frame, matching the requested placement rule.
 */
const sortVisiblePosesLeftToRight = (
  landmarks: NormalizedLandmark[][],
  worldLandmarks: Landmark[][],
): TrackedPose[] => landmarks
  .map((pose, index) => ({
    landmarks: pose,
    worldLandmarks: worldLandmarks[index],
    centreX: ((pose[11]?.x ?? 0) + (pose[12]?.x ?? 0)) * 0.5,
  }))
  .filter(({ landmarks: pose }) => {
    if (pose.length < 33) return false;
    const leftVisibility = pose[11]?.visibility ?? 1;
    const rightVisibility = pose[12]?.visibility ?? 1;
    return (leftVisibility + rightVisibility) * 0.5 >= 0.5;
  })
  .sort((a, b) => a.centreX - b.centreX)
  .slice(0, 2);

// ─── Tuning panel slider ──────────────────────────────────────────────────────

function TuneSlider({
  label, value, min, max, step, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-white/55">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-white/15 accent-[#ffc65b]"
      />
      <span className="w-11 shrink-0 text-right font-mono text-[10px] tabular-nums text-white/80">{value.toFixed(2)}</span>
    </label>
  );
}

// ─── Selection screen ─────────────────────────────────────────────────────────

function SelectionScreen({
  selected,
  onToggle,
  onStart,
}: {
  selected: Set<ARItemId>;
  onToggle: (id: ARItemId) => void;
  onStart: () => void;
}) {
  return (
    <main className="flex min-h-screen w-full items-center justify-center overflow-hidden bg-[#101112] p-0 text-white sm:p-8">
      <section className="relative flex h-[100dvh] w-full max-w-[430px] flex-col overflow-hidden bg-[#141414] shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_30px_90px_rgba(0,0,0,0.65)] sm:h-auto sm:max-h-[900px] sm:aspect-[9/16] sm:rounded-[32px]">

        {/* Ambient top glow */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(ellipse_80%_50%_at_50%_0%,rgba(255,198,91,0.13),transparent)]" />

        {/* Header */}
        <div className="relative z-10 shrink-0 px-7 pt-[max(3rem,calc(env(safe-area-inset-top)+1.5rem))] pb-2">
          <div className="mb-1 flex items-center gap-2">
            <Sparkles size={14} className="text-[#ffc65b]" />
            <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-[#ffc65b]">AR Studio</span>
          </div>
          <h1 className="text-[1.75rem] font-bold leading-tight tracking-tight text-white">
            Pick your<br />accessories
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-white/45">
            Choose one or more items to wear in AR
          </p>
        </div>

        {/* Item grid — scrolls when it can't fit, centers when it can */}
        <div className="relative z-10 min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="flex min-h-full flex-col justify-center gap-3">
          {AR_CATALOGUE.length === 0 && (
            <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.025] px-6 py-9 text-center">
              <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full border border-[#ffc65b]/25 bg-[#ffc65b]/[0.06]">
                <Sparkles size={19} className="text-[#ffc65b]/80" />
              </div>
              <p className="text-[15px] font-semibold text-white/75">No 3D objects installed</p>
              <p className="mx-auto mt-2 max-w-[240px] text-[12px] leading-5 text-white/35">
                Your new accessories will appear here after they are added.
              </p>
            </div>
          )}
          {AR_CATALOGUE.map((item) => {
            const isSelected = selected.has(item.id);
            return (
              <button
                key={item.id}
                onClick={() => onToggle(item.id)}
                className={`group relative flex items-center gap-4 overflow-hidden rounded-2xl border p-3 text-left transition-all duration-200 active:scale-[0.98] ${
                  isSelected
                    ? "border-[#ffc65b]/60 bg-[#ffc65b]/8 shadow-[0_0_0_1px_rgba(255,198,91,0.2),inset_0_1px_0_rgba(255,198,91,0.12)]"
                    : "border-white/8 bg-white/4 hover:border-white/15 hover:bg-white/6"
                }`}
              >
                {/* Thumbnail */}
                <div
                  className={`relative flex size-[56px] shrink-0 items-center justify-center overflow-hidden rounded-xl border text-[26px] transition-colors duration-200 ${
                    isSelected ? "border-[#ffc65b]/30 bg-[#1c1a14]" : "border-white/8 bg-[#1a1a1a]"
                  }`}
                >
                  <span aria-hidden="true">{item.emoji}</span>
                </div>

                {/* Label */}
                <div className="flex-1 min-w-0">
                  <p className={`text-[15px] font-semibold leading-snug transition-colors ${isSelected ? "text-white" : "text-white/80"}`}>
                    {item.label}
                  </p>
                  <div className="mt-0.5 flex items-center gap-2">
                    <p className="text-[12px] text-white/35">{item.sublabel}</p>
                    <span className={`rounded-full border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.1em] ${
                      item.tracking === "Body"
                        ? "border-[#ffc65b]/35 text-[#ffc65b]/80"
                        : "border-white/10 text-white/30"
                    }`}>
                      {item.tracking} tracking
                    </span>
                  </div>
                </div>

                {/* Checkmark */}
                <div
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full border transition-all duration-200 ${
                    isSelected
                      ? "border-[#ffc65b] bg-[#ffc65b]"
                      : "border-white/20 bg-transparent"
                  }`}
                >
                  {isSelected && (
                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                      <path d="M1 4l2.5 2.5L9 1" stroke="#0a0a0a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>

                {/* Selected shimmer edge */}
                {isSelected && (
                  <div className="pointer-events-none absolute inset-0 rounded-2xl bg-[linear-gradient(135deg,rgba(255,198,91,0.06)_0%,transparent_60%)]" />
                )}
              </button>
            );
          })}
          </div>
        </div>

        {/* CTA */}
        <div className="relative z-10 shrink-0 px-5 pb-[max(4rem,calc(env(safe-area-inset-bottom)+1.5rem))] pt-2">
          <p className="mb-3 text-center font-mono text-[9px] uppercase tracking-[0.18em] text-white/30">
            {selected.size === 0
              ? "Select at least one item"
              : `${selected.size} item${selected.size > 1 ? "s" : ""} selected · ${getTrackingNeeds([...selected]).body ? "Body tracking on" : "Face tracking only"}`}
          </p>
          <button
            disabled={selected.size === 0}
            onClick={onStart}
            className="flex w-full items-center justify-center gap-2.5 rounded-2xl bg-[#ffc65b] py-4 text-[15px] font-semibold tracking-tight text-[#0d0c08] transition-all duration-200 hover:bg-[#ffd37a] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Camera size={17} strokeWidth={2.2} />
            Start AR Camera
          </button>
        </div>
      </section>
    </main>
  );
}

// ─── App root ─────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState<AppScreen>("select");
  const [selectedItems, setSelectedItems] = useState<Set<ARItemId>>(
    new Set(AR_CATALOGUE.map((item) => item.id)),
  );

  const toggleItem = (id: ARItemId) =>
    setSelectedItems((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  if (screen === "select") {
    return (
      <SelectionScreen
        selected={selectedItems}
        onToggle={toggleItem}
        onStart={() => setScreen("camera")}
      />
    );
  }

  return (
    <CameraScreen
      key={`${AR_ENGINE_REVISION}:${[...selectedItems].sort().join(",")}`}
      selectedItems={selectedItems}
      onBack={() => setScreen("select")}
    />
  );
}

// ─── Camera screen (MindAR face tracking) ─────────────────────────────────────

function CameraScreen({
  selectedItems,
  onBack,
}: {
  selectedItems: Set<ARItemId>;
  onBack: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const compositeCanvasRef = useRef<HTMLCanvasElement>(null);

  const mindarRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const recordingRef = useRef(false);
  const hasFaceRef = useRef(false);
  const hasBodyRef = useRef(false);
  const stableFrameCountRef = useRef(0);
  const bodyStableFrameCountRef = useRef<Record<ARItemId, number>>({});
  const detectedPeopleRef = useRef(0);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const lastPoseVideoTimeRef = useRef(-1);
  const lastPoseRunRef = useRef(0);
  const latestPosesRef = useRef<TrackedPose[]>([]);
  const bodyWearableManagersRef = useRef<Map<ARItemId, WearableManager>>(new Map());

  // Built accessory pivots, grouped by item id, for live tuning.
  const pivotsRef = useRef<Partial<Record<ARItemId, { pivot: THREE.Group; measuredDimension: number }[]>>>({});
  const primaryFaceAnchorsRef = useRef<Partial<Record<ARItemId, SecondaryFaceAnchor[]>>>({});
  const secondaryFaceAnchorsRef = useRef<Partial<Record<ARItemId, SecondaryFaceAnchor[]>>>({});
  const latestFaceLandmarksRef = useRef<NormalizedLandmark[][]>([]);
  const secondaryFaceStableFrameCountRef = useRef(0);
  const detectedFacesRef = useRef(0);
  const hasSecondaryFaceRef = useRef(false);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [hasFace, setHasFace] = useState(false);
  const [hasBody, setHasBody] = useState(false);
  const [detectedPeople, setDetectedPeople] = useState(0);
  const [detectedFaces, setDetectedFaces] = useState(0);
  const [hasSecondaryFace, setHasSecondaryFace] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>("user");
  const [switchingCamera, setSwitchingCamera] = useState(false);
  const [cameraNotice, setCameraNotice] = useState("");

  // Snapshot the selection once when the camera opens (Set identity is unstable).
  const itemsKey = [...selectedItems].join(",");
  const selectedList = itemsKey.split(",").filter(Boolean) as ARItemId[];
  const trackingNeeds = getTrackingNeeds(selectedList);
  const needsBodyTracking = trackingNeeds.body;
  const needsFaceTracking = trackingNeeds.face;

  // Live per-item transform adjustments (edited via the on-screen tuning panel).
  const [adjust, setAdjust] = useState<Record<ARItemId, WearableAdjust>>(() => {
    const init = {} as Record<ARItemId, WearableAdjust>;
    (Object.keys(WEARABLES) as ARItemId[]).forEach((id) => {
      init[id] = defaultAdjust(WEARABLES[id]);
    });
    return init;
  });
  const adjustRef = useRef(adjust);
  adjustRef.current = adjust;

  const [panelOpen, setPanelOpen] = useState(false);
  const [editItem, setEditItem] = useState<ARItemId>(selectedList[0] ?? "");

  // Re-apply adjustments to the live pivots whenever a slider moves.
  useEffect(() => {
    (Object.keys(pivotsRef.current) as ARItemId[]).forEach((id) => {
      if (WEARABLES[id]?.tracking.body) return;
      const a = adjust[id];
      pivotsRef.current[id]?.forEach(({ pivot, measuredDimension }) => applyFaceAdjust(pivot, measuredDimension, a));
      secondaryFaceAnchorsRef.current[id]?.forEach(({ pivot, measuredDimension }) =>
        applyFaceAdjust(pivot, measuredDimension, a)
      );
    });
  }, [adjust]);

  // Composite the mirrored camera feed + the WebGL overlay onto one canvas so the
  // recording matches exactly what's on screen.
  const compositeFrame = useCallback(() => {
    const mindar = mindarRef.current;
    const comp = compositeCanvasRef.current;
    if (!mindar || !comp) return;
    const video: HTMLVideoElement = mindar.video;
    const gl: HTMLCanvasElement = mindar.renderer.domElement;
    if (!video?.videoWidth) return;
    if (comp.width !== video.videoWidth) {
      comp.width = video.videoWidth;
      comp.height = video.videoHeight;
    }
    const ctx = comp.getContext("2d");
    if (!ctx) return;
    // Video + GL overlay are both un-mirrored and pixel-aligned; draw straight so the
    // recording matches the on-screen view exactly.
    ctx.drawImage(video, 0, 0, comp.width, comp.height);
    ctx.drawImage(gl, 0, 0, comp.width, comp.height);
  }, []);

  // ── Boot MindAR ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let mindar: any = null;
    let poseLandmarker: PoseLandmarker | null = null;
    const bodyWearableManagers = new Map<ARItemId, WearableManager>();

    const boot = async () => {
      try {
        setStatus("loading");
        // Body-only try-on does not load MindAR's face model. Mixed/face wearables
        // keep the established MindAR path and all existing face attachments.
        mindar = needsFaceTracking
          ? new MindARThree({
              container,
              uiLoading: "no",
              uiScanning: "no",
              uiError: "no",
              disableFaceMirror: true,
            })
          : new BodyCameraEngine(container);
        mindarRef.current = mindar;

        if (needsFaceTracking) {
          enableTwoFaceTracking(mindar, (faces) => {
            latestFaceLandmarksRef.current = faces;
            if (faces.length !== detectedFacesRef.current) {
              detectedFacesRef.current = faces.length;
              setDetectedFaces(faces.length);
            }
          });
        }

        const { renderer, scene, camera } = mindar;
        renderer.outputColorSpace = THREE.SRGBColorSpace;

        // GLB models use PBR materials, which render black without lighting.
        const ambient = new THREE.AmbientLight(0xffffff, 1.4);
        const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
        keyLight.position.set(0.5, 1, 2);
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.8);
        fillLight.position.set(-1, 0.5, 1);
        scene.add(ambient, keyLight, fillLight);

        // Depth-only face mesh makes earrings, hats and earmuffs pass naturally
        // behind the face instead of looking pasted on top of it.
        if (needsFaceTracking) {
          const faceOccluder = mindar.addFaceMesh();
          faceOccluder.material.dispose();
          faceOccluder.material = new THREE.MeshBasicMaterial({
            colorWrite: false,
            depthWrite: true,
            side: THREE.DoubleSide,
          });
          faceOccluder.renderOrder = 0;
          scene.add(faceOccluder);
        }

        pivotsRef.current = {};
        primaryFaceAnchorsRef.current = {};
        secondaryFaceAnchorsRef.current = {};
        latestFaceLandmarksRef.current = [];
        secondaryFaceStableFrameCountRef.current = 0;
        for (const id of itemsKey.split(",").filter(Boolean) as ARItemId[]) {
          const cfg = WEARABLES[id];
          if (!cfg) continue;
          const built: { pivot: THREE.Group; measuredDimension: number }[] = [];
          if (cfg.tracking.body) {
            const manager = new WearableManager(scene, camera, cfg);
            const { pivot, measuredDimension } = await manager.load();
            if (disposed) return;
            bodyWearableManagers.set(id, manager);
            bodyWearableManagersRef.current = bodyWearableManagers;
            built.push({ pivot, measuredDimension });
          } else {
            // Both users use app-owned groups. MindAR's built-in anchor parent is
            // single-face only and can hide User 1 when a second face appears.
            const primaryBuilt: SecondaryFaceAnchor[] = [];
            const secondaryBuilt: SecondaryFaceAnchor[] = [];
            for (const landmark of cfg.faceLandmarks ?? []) {
              const { pivot, measuredDimension } = await loadWearableModel(cfg);
              if (disposed) return;
              applyFaceAdjust(pivot, measuredDimension, adjustRef.current[id]);
              const primaryGroup = new THREE.Group();
              primaryGroup.name = `primary-face:${id}:${landmark}`;
              primaryGroup.visible = false;
              primaryGroup.matrixAutoUpdate = false;
              primaryGroup.add(pivot);
              scene.add(primaryGroup);
              built.push({ pivot, measuredDimension });
              primaryBuilt.push({
                group: primaryGroup,
                pivot,
                measuredDimension,
                landmarkIndex: landmark,
                initialized: false,
              });

              // User 2 uses the second face returned by the same MediaPipe
              // detector. Keep a separate anchor group so its transform can be
              // updated without interfering with MindAR's User 1 anchors.
              const secondary = await loadWearableModel(cfg);
              if (disposed) return;
              applyFaceAdjust(secondary.pivot, secondary.measuredDimension, adjustRef.current[id]);
              const secondaryGroup = new THREE.Group();
              secondaryGroup.name = `secondary-face:${id}:${landmark}`;
              secondaryGroup.visible = false;
              secondaryGroup.matrixAutoUpdate = false;
              secondaryGroup.add(secondary.pivot);
              scene.add(secondaryGroup);
              secondaryBuilt.push({
                group: secondaryGroup,
                pivot: secondary.pivot,
                measuredDimension: secondary.measuredDimension,
                landmarkIndex: landmark,
                initialized: false,
              });
            }
            primaryFaceAnchorsRef.current[id] = primaryBuilt;
            secondaryFaceAnchorsRef.current[id] = secondaryBuilt;
          }
          pivotsRef.current[id] = built;
        }

        if (needsBodyTracking) {
          try {
            const vision = await FilesetResolver.forVisionTasks(POSE_WASM_PATH);
            poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
              baseOptions: { modelAssetPath: POSE_MODEL_PATH },
              runningMode: "VIDEO",
              numPoses: 2,
              minPoseDetectionConfidence: 0.55,
              minPosePresenceConfidence: 0.55,
              minTrackingConfidence: 0.6,
              outputSegmentationMasks: false,
            });
            if (disposed) {
              poseLandmarker.close();
              return;
            }
            poseLandmarkerRef.current = poseLandmarker;
          } catch {
            setCameraNotice("Body tracking could not be loaded");
          }
        }

        await mindar.start();
        if (disposed) return;

        // Camera labels and device IDs normally become available only after the
        // first permission-approved stream starts. Cache both physical cameras now
        // so the switch button can target a different device instead of relying on
        // the browser's best-effort facingMode preference.
        const initialTrack = getActiveCameraTrack(mindar);
        const initialFacingMode = initialTrack?.getSettings?.().facingMode;
        const initialFacing: CameraFacing = initialFacingMode === "environment" ? "environment" : "user";
        mindar.shouldFaceUser = initialFacing === "user";
        setCameraFacing(initialFacing);
        try { await resolveCameraDevices(mindar, initialFacing); } catch { /* facingMode remains the fallback */ }

        setStatus("ready");

        // MindAR fits the video/canvas to the container size *at start time*, but on
        // iOS the 100dvh container may not be at full height yet (Safari toolbar),
        // leaving part of the frame black. Re-fit a few times as the layout settles —
        // but ONLY when the container has a real, non-zero size, so a transient 0px
        // measurement can never shrink the video to nothing.
        const safeResize = () => {
          if (disposed) return;
          if (container.clientWidth > 0 && container.clientHeight > 0) {
            try { mindar._resize(); } catch { /* noop */ }
          }
        };
        [200, 600, 1200].forEach((ms) => window.setTimeout(safeResize, ms));

        renderer.setAnimationLoop(() => {
          const primaryAnchors = Object.values(primaryFaceAnchorsRef.current)
            .flatMap((anchors) => anchors ?? []);
          const primaryTracked = primaryAnchors.length > 0 && updateFaceAnchorsFromEstimate(
            primaryAnchors,
            mindar.getLatestEstimate?.(),
            true,
          );

          // Wait for a few consecutive valid frames before revealing the models.
          // This avoids the visible jump caused by the tracker's first rough pose.
          stableFrameCountRef.current = primaryTracked
            ? Math.min(stableFrameCountRef.current + 1, 6)
            : 0;
          const faceVisible = stableFrameCountRef.current >= 6;
          primaryAnchors.forEach(({ group }) => { group.visible = faceVisible; });

          const secondaryAnchors = Object.values(secondaryFaceAnchorsRef.current)
            .flatMap((anchors) => anchors ?? []);
          const secondaryTracked = secondaryAnchors.length > 0 && updateSecondaryFaceAnchors(
            secondaryAnchors,
            latestFaceLandmarksRef.current[1],
            mindar.controller?.estimator,
            true,
          );
          secondaryFaceStableFrameCountRef.current = secondaryTracked
            ? Math.min(secondaryFaceStableFrameCountRef.current + 1, 6)
            : 0;
          const secondaryVisible = secondaryFaceStableFrameCountRef.current >= 6;
          secondaryAnchors.forEach(({ group }) => { group.visible = secondaryVisible; });
          if (secondaryVisible !== hasSecondaryFaceRef.current) {
            hasSecondaryFaceRef.current = secondaryVisible;
            setHasSecondaryFace(secondaryVisible);
          }

          if (faceVisible !== hasFaceRef.current) {
            hasFaceRef.current = faceVisible;
            setHasFace(faceVisible);
          }

          // Pose detection is intentionally throttled: the lite model supplies
          // stable shoulder updates without competing with face tracking every frame.
          const pose = poseLandmarkerRef.current;
          const video: HTMLVideoElement | undefined = mindar.video;
          const now = performance.now();
          if (pose && video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
            && video.currentTime !== lastPoseVideoTimeRef.current
            && now - lastPoseRunRef.current >= 75) {
            lastPoseVideoTimeRef.current = video.currentTime;
            lastPoseRunRef.current = now;
            try {
              const poseResult = pose.detectForVideo(video, now);
              latestPosesRef.current = sortVisiblePosesLeftToRight(
                poseResult.landmarks,
                poseResult.worldLandmarks,
              );
            } catch {
              latestPosesRef.current = [];
            }
          }

          const visiblePeople = pose ? latestPosesRef.current : [];
          const peopleCount = visiblePeople.length;
          if (peopleCount !== detectedPeopleRef.current) {
            detectedPeopleRef.current = peopleCount;
            setDetectedPeople(peopleCount);
          }

          for (const [id, manager] of bodyWearableManagers) {
            const config = WEARABLES[id];
            const personSlot = config.personSlot ?? 0;
            const requiredPeople = config.minPeople ?? personSlot + 1;
            const person = peopleCount >= requiredPeople ? visiblePeople[personSlot] : undefined;
            const tracked = !!person && manager.update(
              person.landmarks,
              person.worldLandmarks,
              adjustRef.current[id],
            );
            const stableFrames = tracked
              ? Math.min((bodyStableFrameCountRef.current[id] ?? 0) + 1, 4)
              : 0;
            bodyStableFrameCountRef.current[id] = stableFrames;
            manager.setVisible(stableFrames >= 4);
          }

          const bodyVisible = peopleCount > 0;
          if (bodyVisible !== hasBodyRef.current) {
            hasBodyRef.current = bodyVisible;
            setHasBody(bodyVisible);
          }

          renderer.render(scene, camera);
          if (recordingRef.current) compositeFrame();
        });
      } catch (err) {
        if (disposed) return;
        console.error("[AR] Camera boot failed", err);
        try { mindar?.stop(); } catch { /* noop */ }
        setStatus("error");
        const detail = err instanceof Error ? `${err.name} ${err.message}` : String(err);
        setErrorMessage(
          /NotAllowed|permission/i.test(detail)
            ? "Camera permission was not granted."
            : /NotFound|no camera/i.test(detail)
              ? "No camera is available on this device."
              : /NotReadable|in use/i.test(detail)
                ? "The camera is being used by another app."
                : /Unable to load|GLB file/i.test(detail)
                  ? detail.replace(/^Error\s*/, "")
                  : "We couldn't start the AR camera on this device."
        );
      }
    };

    void boot();

    return () => {
      disposed = true;
      try { mindar?.renderer?.setAnimationLoop(null); } catch { /* noop */ }
      try { mindar?.stop(); } catch { /* noop */ }
      try { poseLandmarker?.close(); } catch { /* noop */ }
      bodyWearableManagers.forEach((manager) => manager.dispose());
      bodyWearableManagers.clear();
      bodyWearableManagersRef.current = new Map();
      poseLandmarkerRef.current = null;
      if (mediaRecorderRef.current?.state === "recording") {
        try { mediaRecorderRef.current.stop(); } catch { /* noop */ }
      }
      audioStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioStreamRef.current = null;
      stableFrameCountRef.current = 0;
      secondaryFaceStableFrameCountRef.current = 0;
      bodyStableFrameCountRef.current = {};
      detectedPeopleRef.current = 0;
      detectedFacesRef.current = 0;
      hasSecondaryFaceRef.current = false;
      hasFaceRef.current = false;
      hasBodyRef.current = false;
      latestPosesRef.current = [];
      latestFaceLandmarksRef.current = [];
      setDetectedFaces(0);
      setHasSecondaryFace(false);
      Object.values(primaryFaceAnchorsRef.current).forEach((anchors) => {
        hideSecondaryFaceAnchors(anchors ?? []);
        anchors?.forEach(({ group }) => group.parent?.remove(group));
      });
      primaryFaceAnchorsRef.current = {};
      Object.values(secondaryFaceAnchorsRef.current).forEach((anchors) => {
        hideSecondaryFaceAnchors(anchors ?? []);
        anchors?.forEach(({ group }) => group.parent?.remove(group));
      });
      secondaryFaceAnchorsRef.current = {};
      mindarRef.current = null;
    };
  }, [itemsKey, retryKey, compositeFrame]);

  // Recording timer
  useEffect(() => {
    if (!recording) return;
    const ticker = window.setInterval(() => setSeconds((v) => v + 1), 1000);
    return () => window.clearInterval(ticker);
  }, [recording]);

  const startRecording = useCallback(async () => {
    const mindar = mindarRef.current;
    const comp = compositeCanvasRef.current;
    if (!mindar || !comp || !window.MediaRecorder) return;
    const video: HTMLVideoElement = mindar.video;
    if (!video?.videoWidth) return;

    comp.width = video.videoWidth;
    comp.height = video.videoHeight;

    const stream = comp.captureStream(30);
    // MindAR's camera stream is video-only; grab a microphone track separately.
    try {
      const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = audio;
      audio.getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch { /* record silently if mic is unavailable */ }

    chunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : "video/webm";
    const recorder = new MediaRecorder(
      stream,
      MediaRecorder.isTypeSupported(mimeType) ? { mimeType } : undefined
    );
    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => {
      audioStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioStreamRef.current = null;
      const clip = new Blob(chunksRef.current, { type: recorder.mimeType || "video/webm" });
      const url = URL.createObjectURL(clip);
      const link = document.createElement("a");
      link.href = url;
      link.download = `ar-camera-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      link.click();
      URL.revokeObjectURL(url);
    };
    recorder.start();
    recordingRef.current = true;
    setSeconds(0);
    setRecording(true);
  }, []);

  const stopRecording = useCallback(() => {
    recordingRef.current = false;
    setRecording(false);
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
  }, []);

  const toggleRecording = () => {
    if (recording) stopRecording();
    else void startRecording();
  };

  const switchFacingMode = useCallback(async () => {
    const mindar = mindarRef.current;
    if (!mindar || status !== "ready" || switchingCamera || recording) return;

    const nextFacing = cameraFacing === "user" ? "environment" : "user";
    const previousTrack = getActiveCameraTrack(mindar);
    const previousDeviceId = previousTrack?.getSettings?.().deviceId || null;
    let devices: CameraDeviceMap;

    try {
      devices = await resolveCameraDevices(mindar, cameraFacing);
    } catch {
      devices = { count: 0, userDeviceId: null, environmentDeviceId: null };
    }

    if (devices.count === 1) {
      setCameraNotice("Only one camera is available on this device");
      return;
    }

    // When labels are unavailable, force any physical input other than the active
    // one. Exact deviceId is considerably more reliable than facingMode on mobile.
    let targetDeviceId = nextFacing === "user" ? devices.userDeviceId : devices.environmentDeviceId;
    if (devices.count > 1 && (!targetDeviceId || targetDeviceId === previousDeviceId)) {
      try {
        const alternate = (await navigator.mediaDevices.enumerateDevices()).find(
          (device) => device.kind === "videoinput" && device.deviceId !== previousDeviceId
        );
        targetDeviceId = alternate?.deviceId || targetDeviceId;
        if (nextFacing === "user") mindar.userDeviceId = targetDeviceId;
        else mindar.environmentDeviceId = targetDeviceId;
      } catch { /* facingMode remains the fallback */ }
    }

    setSwitchingCamera(true);
    setCameraNotice("");
    setPanelOpen(false);
    stableFrameCountRef.current = 0;
    secondaryFaceStableFrameCountRef.current = 0;
    bodyStableFrameCountRef.current = {};
    detectedPeopleRef.current = 0;
    detectedFacesRef.current = 0;
    hasSecondaryFaceRef.current = false;
    hasFaceRef.current = false;
    hasBodyRef.current = false;
    latestPosesRef.current = [];
    latestFaceLandmarksRef.current = [];
    bodyWearableManagersRef.current.forEach((manager) => manager.reset());
    setHasFace(false);
    setHasBody(false);
    setDetectedPeople(0);
    setDetectedFaces(0);
    setHasSecondaryFace(false);
    Object.values(primaryFaceAnchorsRef.current).forEach((anchors) =>
      hideSecondaryFaceAnchors(anchors ?? [])
    );
    Object.values(secondaryFaceAnchorsRef.current).forEach((anchors) =>
      hideSecondaryFaceAnchors(anchors ?? [])
    );

    try {
      releaseMindARCamera(mindar);
      mindar.latestEstimate = null;
      mindar.shouldFaceUser = nextFacing === "user";
      // Give Safari a short moment to release the hardware before requesting the
      // opposite lens. Without this, it can satisfy the request with the old stream.
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      await mindar.start();

      const activeTrack = getActiveCameraTrack(mindar);
      const activeDeviceId = activeTrack?.getSettings?.().deviceId || null;
      if (previousDeviceId && activeDeviceId === previousDeviceId && devices.count > 1) {
        throw new Error("SAME_CAMERA");
      }

      if (containerRef.current?.clientWidth && containerRef.current?.clientHeight) {
        mindar._resize();
      }
      try { await resolveCameraDevices(mindar, nextFacing); } catch { /* IDs already selected */ }
      setCameraFacing(nextFacing);
      setCameraNotice(`${nextFacing === "user" ? "Front" : "Back"} camera active`);
    } catch {
      // Restore the previous camera so one failed switch does not strand the user
      // on an error screen with no live preview.
      try {
        releaseMindARCamera(mindar);
        mindar.latestEstimate = null;
        mindar.shouldFaceUser = cameraFacing === "user";
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        await mindar.start();
        if (containerRef.current?.clientWidth && containerRef.current?.clientHeight) {
          mindar._resize();
        }
        setCameraNotice(`Could not switch to the ${nextFacing === "user" ? "front" : "back"} camera`);
      } catch {
        setStatus("error");
        setErrorMessage(`We couldn't start the ${nextFacing === "user" ? "front" : "back"} camera on this device.`);
      }
    } finally {
      setSwitchingCamera(false);
    }
  }, [cameraFacing, recording, status, switchingCamera]);

  const formattedTime = `00:${String(seconds).padStart(2, "0")}`;
  const activeLabel = [...selectedItems]
    .map((id) => AR_CATALOGUE.find((c) => c.id === id)?.label)
    .filter(Boolean)
    .join(" · ");
  // One person is already a complete valid state; the second snowman appears
  // opportunistically when a second person enters the frame.
  const trackingComplete = (!needsFaceTracking || hasFace) && (!needsBodyTracking || hasBody);
  const waitingForSecondPerson = detectedPeople === 1 && selectedItems.has("snowman_2");
  const bodyTrackingLabel = detectedPeople >= 2
    ? "2 people tracked"
    : detectedPeople === 1
      ? waitingForSecondPerson ? "1 person · find another" : "1 person tracked"
      : "Find shoulders";
  const faceTrackingLabel = hasSecondaryFace
    ? "2 faces tracked"
    : detectedFaces >= 1
      ? "1 face tracked"
      : "Find a face";
  const trackingBadgeLabel = switchingCamera
    ? "Switching camera"
    : needsFaceTracking && needsBodyTracking
      ? hasFace && hasBody ? `Face + ${bodyTrackingLabel}` : hasBody ? "Find a face" : bodyTrackingLabel
      : needsBodyTracking
        ? bodyTrackingLabel
        : faceTrackingLabel;

  return (
    <main className="flex min-h-screen w-full items-center justify-center overflow-hidden bg-[#101112] p-0 text-white sm:p-8">
      <section
        aria-label="Live camera with AR accessories"
        className="relative h-[100dvh] w-full max-w-[430px] overflow-hidden bg-[#141414] shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_30px_90px_rgba(0,0,0,0.65)] sm:h-auto sm:max-h-[900px] sm:aspect-[9/16] sm:rounded-[32px]"
      >
        {/* MindAR injects the camera <video> and WebGL <canvas> in here. `isolate`
            gives the container its own stacking context so MindAR's z-index:-2 on the
            video stays inside the container (above its transparent background) instead
            of disappearing behind the section's dark background. */}
        <div
          ref={containerRef}
          className="mindar-media absolute inset-0 isolate z-0 [&_canvas]:!bg-transparent [&_video]:object-cover"
        />

        {/* Hidden compositor used only for recording */}
        <canvas ref={compositeCanvasRef} className="hidden" />

        {/* Cinematic vignette */}
        <div className="pointer-events-none absolute inset-0 z-[5] bg-[linear-gradient(180deg,rgba(7,8,8,0.58)_0%,rgba(7,8,8,0.03)_28%,rgba(7,8,8,0.04)_58%,rgba(7,8,8,0.74)_100%)]" />

        {/* Loading overlay */}
        {status === "loading" && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#141414]">
            <div className="text-center">
              <div className="mx-auto mb-4 size-9 animate-spin rounded-full border-2 border-white/15 border-t-[#ffc65b]" />
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/60">Loading 3D models</p>
            </div>
          </div>
        )}

        {/* Header */}
        <header className="absolute inset-x-0 top-0 z-20 grid grid-cols-[1fr_auto_1fr] items-center px-5 pt-[max(1.1rem,env(safe-area-inset-top))]">
          <button
            onClick={onBack}
            className="justify-self-start rounded-full p-2.5 transition hover:bg-white/12"
            aria-label="Back to selection"
          >
            <X size={24} strokeWidth={1.8} />
          </button>
          <div className="flex items-center gap-2 rounded-full border border-white/15 bg-black/25 px-3.5 py-2 font-mono text-[10px] font-medium uppercase tracking-[0.16em] backdrop-blur-md">
            <span className={`size-1.5 rounded-full ${recording ? "animate-pulse bg-[#ff453a]" : status === "ready" && !switchingCamera ? "bg-[#ffc65b]" : "bg-white/45"}`} />
            {recording
              ? formattedTime
              : switchingCamera
                ? "Switching"
                : status === "ready"
                  ? cameraFacing === "user" ? "Front camera" : "Back camera"
                  : "Connecting"}
          </div>
          <div className="flex justify-self-end">
            <button
              type="button"
              disabled={status !== "ready" || switchingCamera || recording}
              onClick={() => { void switchFacingMode(); }}
              className="rounded-full p-2.5 text-white transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-35"
              aria-label={`Switch to ${cameraFacing === "user" ? "back" : "front"} camera`}
              title={`Switch to ${cameraFacing === "user" ? "back" : "front"} camera`}
            >
              <SwitchCamera size={22} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              className={`rounded-full p-2.5 transition hover:bg-white/12 ${panelOpen ? "text-[#ffc65b]" : "text-white"}`}
              aria-label="Adjust accessory fit"
            >
              <SlidersHorizontal size={22} strokeWidth={1.8} />
            </button>
          </div>
        </header>

        {/* Tracking badge */}
        {status === "ready" && (
          <div className="absolute left-1/2 top-[calc(1.1rem+env(safe-area-inset-top)+3.1rem)] z-20 -translate-x-1/2 rounded-full border border-white/15 bg-black/20 px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-white/75 backdrop-blur-md">
            <ScanFace size={12} className="mr-1 inline text-[#ffc65b]" />
            {trackingBadgeLabel}
          </div>
        )}

        {cameraNotice && status === "ready" && !switchingCamera && (
          <div
            role="status"
            className="absolute left-1/2 top-[calc(1.1rem+env(safe-area-inset-top)+5.45rem)] z-20 w-max max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-full border border-[#ffc65b]/30 bg-black/55 px-3 py-1.5 text-center font-mono text-[9px] uppercase tracking-[0.1em] text-[#ffd37a] backdrop-blur-md"
          >
            {cameraNotice}
          </div>
        )}

        {/* Error overlay */}
        {status === "error" && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#141414] p-7 text-center">
            <div>
              <Camera className="mx-auto mb-5 text-[#ffc65b]" size={34} strokeWidth={1.5} />
              <p className="text-lg font-semibold">Camera unavailable</p>
              <p className="mx-auto mt-2 max-w-[250px] text-sm leading-6 text-white/60">{errorMessage}</p>
              <div className="mt-6 flex items-center justify-center gap-3">
                <button
                  onClick={onBack}
                  className="rounded-full border border-white/15 px-4 py-2.5 text-sm text-white/65 transition hover:bg-white/10"
                >
                  Back
                </button>
                <button
                  onClick={() => { setErrorMessage(""); setRetryKey((k) => k + 1); }}
                  className="flex items-center gap-2 rounded-full border border-white/20 px-4 py-2.5 text-sm transition hover:bg-white/10"
                >
                  <RotateCcw size={16} /> Try again
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Live tuning panel */}
        {panelOpen && status === "ready" && (
          <div className="absolute inset-x-0 bottom-0 z-40 max-h-[70%] overflow-y-auto rounded-t-3xl border-t border-white/12 bg-[#0e0e0f]/95 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4 backdrop-blur-xl">
            <div className="mb-3 flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#ffc65b]">Fit tuner</p>
              <button onClick={() => setPanelOpen(false)} className="rounded-full p-1.5 text-white/60 hover:bg-white/10" aria-label="Close tuner">
                <X size={18} />
              </button>
            </div>

            {/* Item tabs */}
            <div className="mb-4 flex flex-wrap gap-2">
              {selectedList.map((id) => {
                const item = AR_CATALOGUE.find((c) => c.id === id);
                return (
                  <button
                    key={id}
                    onClick={() => setEditItem(id)}
                    className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] transition ${
                      editItem === id
                        ? "border-[#ffc65b]/60 bg-[#ffc65b]/12 text-white"
                        : "border-white/10 bg-white/5 text-white/60"
                    }`}
                  >
                    <span aria-hidden="true">{item?.emoji}</span>
                    {item?.label}
                  </button>
                );
              })}
            </div>

            {(() => {
              const a = adjust[editItem];
              const config = WEARABLES[editItem];
              if (!a || !config) return null;
              const set = (patch: Partial<WearableAdjust>) =>
                setAdjust((prev) => ({ ...prev, [editItem]: { ...prev[editItem], ...patch } }));
              return (
                <div className="space-y-2.5">
                  <TuneSlider label="Size"  value={a.scale} min={0.05} max={8}   step={0.05} onChange={(v) => set({ scale: v })} />
                  <TuneSlider label="X"     value={a.ox}    min={-3}   max={3}    step={0.02} onChange={(v) => set({ ox: v })} />
                  <TuneSlider label="Y"     value={a.oy}    min={-4}   max={4}    step={0.02} onChange={(v) => set({ oy: v })} />
                  <TuneSlider label="Z"     value={a.oz}    min={-3}   max={3}    step={0.02} onChange={(v) => set({ oz: v })} />
                  <TuneSlider label="Rot X" value={a.rx}    min={-180} max={180}  step={1}    onChange={(v) => set({ rx: v })} />
                  <TuneSlider label="Rot Y" value={a.ry}    min={-180} max={180}  step={1}    onChange={(v) => set({ ry: v })} />
                  <TuneSlider label="Rot Z" value={a.rz}    min={-180} max={180}  step={1}    onChange={(v) => set({ rz: v })} />
                  <div className="flex items-center justify-between pt-1.5">
                    <button
                      onClick={() => setAdjust((prev) => ({ ...prev, [editItem]: defaultAdjust(config) }))}
                      className="flex items-center gap-1.5 rounded-full border border-white/15 px-3 py-1.5 text-[11px] text-white/70 hover:bg-white/10"
                    >
                      <RotateCcw size={13} /> Reset
                    </button>
                    <code className="max-w-[60%] truncate font-mono text-[9px] text-white/40">
                      {`{scale:${a.scale}, offset:[${a.ox},${a.oy},${a.oz}], rotDeg:[${a.rx},${a.ry},${a.rz}]}`}
                    </code>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Footer controls */}
        <div className="absolute inset-x-0 bottom-0 z-20 px-5 pb-[max(1.75rem,env(safe-area-inset-bottom))]">
          <p className="mb-2 truncate px-4 text-center font-mono text-[9px] uppercase tracking-[0.14em] text-[#ffc65b]/70">
            {activeLabel}
          </p>
          <p className="mb-5 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-white/50">
            {switchingCamera
              ? "Switching camera"
              : status === "ready"
              ? trackingComplete
                ? waitingForSecondPerson ? "Bring a second person into frame" : "AR locked on"
                : needsBodyTracking && !hasBody
                  ? "Move your shoulders into frame"
                  : "Move your face into frame"
              : status === "loading"
              ? needsFaceTracking ? "Loading face tracker" : "Loading body tracker"
              : "Allow camera access to continue"}
          </p>
          <button
            disabled={status !== "ready" || switchingCamera}
            onClick={toggleRecording}
            className="mx-auto flex size-[88px] items-center justify-center rounded-full border-[3px] border-white/90 bg-white/10 p-1.5 transition hover:scale-[1.035] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={recording ? "Stop recording" : "Start recording"}
          >
            <span className={`block bg-[#ff453a] transition-all duration-200 ${recording ? "size-8 rounded-[9px]" : "size-[67px] rounded-full"}`} />
          </button>
          <p className="mt-4 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-white/75">
            {recording ? "Recording AR clip" : switchingCamera ? "Switching" : status === "ready" ? "Ready" : "Waiting for camera"}
          </p>
        </div>

        {recording && (
          <div className="pointer-events-none absolute left-0 top-0 z-30 h-1 w-full animate-[pulse_2s_ease-in-out_infinite] bg-[#ff453a]" />
        )}
      </section>
    </main>
  );
}
