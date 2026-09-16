# Wearable model slots

The previous bundled GLB files have been removed. Each replacement model is kept
under `src/assets/models`, with its tracking position configured in
`src/ar/wearables.ts`.

## Current model

- `christmas_bell.glb` — upper-right hair clip; rigid face-landmark attachment.
  Author: giga. Source: Sketchfab model `17ab79bef97e406598b52b31ce57f76e`.
  License: CC BY 4.0.
- `secret_glasses.glb` — centred on the eyes at the nose bridge; rigid face
  attachment. Author: Milene Araujo. Source: Sketchfab model
  `dc314f5b08a244d8b91b3e282326029b`. License: CC BY 4.0.
- `santa_beard.glb` — centred on the chin and lower face; rigid face attachment.
  Author: ThunderxleOJ. Source: Sketchfab model
  `7f88aea736b44af6902b16d75b224141`. License: CC BY 4.0.
- `bow1.glb` — duplicated at runtime and attached to the left and right hairline
  using symmetric face landmarks 103 and 332.

All face-tracked accessories above are instantiated independently for User 1
and User 2 when two faces are visible. The two users are assigned consistently
from screen-left to screen-right. Snowman models keep their separate two-person
shoulder-placement rules and are not duplicated by the face tracker.

- `snowman_1.glb` — User 1 (screen-left person), anatomical left shoulder.
  This is the only snowman shown when one person is detected. Its billboard-style
  body attachment keeps the authored front facing the camera.
- `snowman_2.glb` — User 2 (screen-right person), anatomical right shoulder.
  This model is revealed only after two people are detected and also faces camera.

Additional try-on assets can be placed in this directory and referenced from
`src/ar/wearables.ts`, for example:

- `tshirt.glb` — rigged `SkinnedMesh`
- `backpack.glb` — rigid torso/back anchor
- `necklace.glb` — rigid neck/chest anchor
- `camera.glb` — rigid chest anchor

Rigged garments must contain an authored skeleton whose bone names are mapped in
the wearable configuration. A static mesh is intentionally not treated as rigged
clothing.
