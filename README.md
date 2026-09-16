
# Create 9:16 Camera Screen (Right）

This is a code bundle for Create 9:16 Camera Screen (Right）. The original project is available at https://www.figma.com/design/GYjas7cvdEzyjN81pE8eUU/Create-9-16-Camera-Screen--Right%EF%BC%89.

## Quick start on this Mac

Double-click `start-local.command`. It installs missing dependencies and opens the Vite development server at <http://127.0.0.1:5173/>.

Keep the Terminal window open while editing. Vite refreshes the preview after each saved change. Press **Control-C** in that Terminal window to stop the server.

In AR Camera, use the camera-switch icon in the top-right corner to change between the phone's front (`user`) and back (`environment`) cameras. The app selects a different physical camera by device ID after permission is granted, releases the old stream before switching, and shows the active side in the header. Camera switching is disabled while a recording is active. If the browser exposes only one camera, the app keeps the live preview running and shows an explanatory message.

## Main editing locations

- `src/app/App.tsx`: screen content, accessory list, camera and AR behaviour
- `src/styles/`: global styles and Tailwind theme
- `src/imports/`: local image assets

The 3D `.glb` accessories are bundled locally under `src/assets/models/`. The browser will ask for camera permission when AR mode starts.

Face accessories use MindAR face landmarks. `Xmas Cape` uses the local MediaPipe Pose Landmarker model instead: landmarks 11 and 12 drive the left/right shoulder position, garment width, roll and body yaw. The cape's side geometry is curved backwards at runtime so it wraps around the shoulders with visible 3D depth instead of remaining a flat overlay. Its model bundle and WASM runtime are stored under `public/mediapipe/`, so body tracking does not fetch those files from a CDN at runtime. For the best fit, keep both shoulders visible in the camera frame.

## Command-line alternative

If Node and pnpm are already installed:

```sh
pnpm install
pnpm dev
```

Use `pnpm build` to verify a production build.
