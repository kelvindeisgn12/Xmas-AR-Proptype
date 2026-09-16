import * as THREE from "three";

type CameraFacing = "user" | "environment";

export class BodyCameraEngine {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  readonly video = document.createElement("video");
  shouldFaceUser = true;
  userDeviceId: string | null = null;
  environmentDeviceId: string | null = null;
  private stream: MediaStream | null = null;

  constructor(private readonly container: HTMLElement) {
    this.camera.position.set(0, 0, 0);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute("playsinline", "true");
    this.video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-2";
    this.renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:-1";
    this.container.append(this.video, this.renderer.domElement);
  }

  private getFacing(): CameraFacing {
    return this.shouldFaceUser ? "user" : "environment";
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Webcam not supported");
    }

    this.stopStream();
    const facing = this.getFacing();
    const deviceId = facing === "user" ? this.userDeviceId : this.environmentDeviceId;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.video.srcObject = this.stream;
    if (!this.video.isConnected) this.container.prepend(this.video);
    if (!this.renderer.domElement.isConnected) this.container.append(this.renderer.domElement);
    await this.video.play();
    this._resize();
  }

  _resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.camera.userData.coverTransform = true;
    this.camera.userData.sourceAspect = this.video.videoWidth && this.video.videoHeight
      ? this.video.videoWidth / this.video.videoHeight
      : this.camera.aspect;
    this.camera.userData.viewportAspect = this.camera.aspect;
    this.renderer.setSize(width, height, false);
  }

  private stopStream() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  stop() {
    this.renderer.setAnimationLoop(null);
    this.stopStream();
    this.video.remove();
    this.renderer.domElement.remove();
    this.renderer.dispose();
  }
}

