# Storm the Shore: asset credits

Every file in this folder is **CC0 1.0** (public domain dedication,
https://creativecommons.org/publicdomain/zero/1.0/). Credit isn't required, but it's deserved.
Files were resized (sprites, 512 px → 64–128 px) or trimmed and re-encoded (sounds, mono OGG Vorbis).

| Files | Pack | Author | Link | License |
|---|---|---|---|---|
| `fx/*.png` (smoke4, smoke7, smoke10, fire1, scorch1, muzzle2, star6, star8, star9, flare1, trace7, circle2, dirt1) | Particle Pack | Kenney | https://kenney.nl/assets/particle-pack | CC0 |
| `sfx/pop.ogg` (impactPunch_medium_000), `sfx/hit.ogg` (impactPlate_light_000), `sfx/clank.ogg` (impactMetal_light_000), `sfx/smash.ogg` (impactPunch_heavy_000), `sfx/glass.ogg` (impactGlass_light_000), `sfx/shatter.ogg` (impactGlass_heavy_000) | Impact Sounds | Kenney | https://kenney.nl/assets/impact-sounds | CC0 |
| `sfx/boom.ogg` (explosionCrunch_000), `sfx/bigboom.ogg` (lowFrequency_explosion_000) | Sci-Fi Sounds | Kenney | https://kenney.nl/assets/sci-fi-sounds | CC0 |
| `sfx/coin.ogg` (confirmation_001), `sfx/powerup.ogg` (maximize_006), `sfx/bad.ogg` (error_006) | Interface Sounds | Kenney | https://kenney.nl/assets/interface-sounds | CC0 |
| `sfx/shot.ogg` (one shot from "22 Pistol"), `sfx/shot-heavy.ogg` (one shot from "Unkown") | Gunshots | kurt | https://opengameart.org/content/gunshots | CC0 |
| `sfx/rocket.ogg` (the first blast of shotty.wav) | Gunshot Sounds | Tabasco | https://opengameart.org/content/gunshot-sounds | CC0 |

Not bundled: the **Luckiest Guy** font (Astigmatic, SIL Open Font License 1.1) is loaded from Google
Fonts and cached by the service worker; the game falls back to heavy system type without it.
The Kenney Fonts pack (CC0) was tried first, but its thin, square letters didn't give the chunky look.

If any of these files fails to load, the game uses its own drawn effects and synthesized sounds instead.
