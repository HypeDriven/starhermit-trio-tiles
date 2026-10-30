# Trio Tiles — Product and Game Specification

**Document status:** running design document. The game is implemented and shipping; this spec describes both the intended design and the behavior of the code in this repository. Where the two diverge, the code is authoritative and this document is updated to match.
**Game index:** 4  
**Genre:** Selection puzzle  
**Players:** 1 player; optional asynchronous score comparison  
**Targets:** desktop browsers, mobile browsers, landscape and portrait where practical  
**Rendering direction:** a StarHermit engine script game (TypeScript on the host API, engine 1.28.0, `engine.minor=30`): the table on `starhermit:scene`, the interface on `starhermit:ui`; played natively by the StarHermit client and in browsers by the engine's web runtime

## 1. Product vision

Trio Tiles is a game in which players move exposed tiles into a seven-slot tray; three identical symbols remove themselves. Its signature setting is a serene floating tea table with carved tiles. The product should feel immediately understandable, responsive within one input, and polished enough that the board or playfield itself is the visual hero. Sessions should begin quickly, make the next useful action obvious without solving the game for the player, and end with a clear explanation of score and progress.

The experience must be original. Do not copy names, layouts, characters, iconography, writing, audio, progression maps, or level data from an existing title. Use an original visual language, original procedural assets, and internally authored content.

### Design pillars

1. **Readable before spectacular:** legal actions, hazards, selection, ownership, and goals remain legible with effects disabled.
2. **One-input confidence:** every press, tap, drag, key, or pointer action gives immediate visual and sonic acknowledgment.
3. **Short path to play:** a returning player reaches the primary playfield in at most two deliberate actions.
4. **Fair mastery:** randomness is seeded and inspectable; outcomes never depend on hidden purchases or invisible stat boosts.
5. **Scalable beauty:** the same art direction survives low-power mobile hardware and high-resolution desktop displays.

## 2. Core game design

### Objective and rules contract

Move exposed tiles into a seven-slot tray; three identical symbols remove themselves.

The rules engine must represent legal actions independently from rendering. It must expose legal-action queries, deterministic resolution, serializable state, a monotonically increasing turn/tick number, and a terminal-state reason. Tutorials and hints call the same legal-action API used by play rather than duplicating rules.

### Core loop

The repeated loop is: **inspect exposed pieces, select one into the tray, resolve triples, and manage remaining tray capacity**. Input is locked only during the shortest non-interruptible resolution phase. Cosmetic animation may continue after the logical state is ready, but skip/fast-forward must settle every object into the exact deterministic end state.

### Scoring and victory

Win by clearing the layout; lose when every tray slot is occupied without an immediate triple. Results show a component breakdown rather than one unexplained total. Store integers for score and simulation units; format values only in presentation. Ties use, in order: primary objective completion, fewer invalid actions, lower authoritative elapsed time, then stable session identifier.

### Modes

- **Learn:** interactive lessons introduce one rule at a time and require the player to perform the action.
- **Journey:** authored progression with gradually combined mechanics and periodic mastery stages.
- **Daily:** one shared seed and ruleset per UTC day, synchronized to platform time.
- **Practice:** selectable difficulty, restart, undo where rules permit, and no effect on competitive rating.
- **Challenge:** constrained goals such as move limits, speed targets, altered layouts, or restricted tools.
- **Score chase:** asynchronous global and friends comparisons using validated seeds and rulesets.

### Difficulty and content generation

- Represent content as versioned data: identifier, seed, initial state, goals, allowed mechanics, par values, tutorial flags, and presentation theme.
- Run offline validators to prove basic legality, reachable goals, bounded duration, and absence of soft locks. Logic puzzles additionally require a unique or explicitly accepted solution class.
- Difficulty is measured from solution depth, branching factor, time pressure, motor precision, hidden information, and recovery options—not merely larger numbers.
- Introduce one new concept in isolation, combine it with one known concept, then test mastery before adding another.
- Daily seeds are immutable after publication. If content is defective, mark the day excluded from ranking rather than silently replacing it.

### Game-state model

`boot → title → profile-ready → mode-select → preparing → tutorial/countdown → active ↔ paused/reconnecting → resolving → results → progression`.

Every transition has one owner and an explicit reason. Backgrounding pauses solo simulation. In hosted play, the authoritative clock continues where rules require it, while the returning client receives a fresh snapshot and a concise “while you were away” summary.

## 3. Interaction and user-interface design

### Information hierarchy

1. **Primary:** playfield, current objective, legal interaction target, and immediate danger or turn state.
2. **Secondary:** score/progress, remaining moves or time, opponent/party status where applicable.
3. **Tertiary:** settings, social controls, cosmetics, help, and history.

The 3D table fills the window but is never the only UI: screens, HUD, settings and the board mirror are `starhermit:ui` widgets drawn over it (native/screens.ts), with every available tile also a named area over the table for screen readers, play scripts and browser checks.

### Responsive layouts

- **Wide desktop (≥1024 CSS px):** centered playfield, objective/progression rail on the left, contextual actions and social/status rail on the right. Maximum line length is 70 characters.
- **Compact desktop/tablet:** playfield remains central; secondary rails collapse into drawers. Pointer hover may preview but never be required.
- **Portrait mobile:** top safe-area status bar, square or perspective-fit playfield, bottom thumb-zone action tray, and sheet-based secondary panels. Never place critical controls under browser chrome or display cutouts.
- **Landscape mobile:** reserve a narrow status rail; preserve at least 44×44 CSS-pixel targets and 8-pixel separation. The tray/actions column starts below the status pills, the board mirror stays available as a bottom-left drawer, and the tutorial banner hugs the top HUD in every orientation. The table slab's top surface is at y=0 so tiles, tray and rings always sit on it.
- **Large screens:** the runtime's interface scale (window scale × the player's interface size) sizes every widget; the 3D view always fills the window.
- The settings/pause overlay panel is opaque and is headed "Settings" when opened from the title ("Paused" in a round). In portrait the action tray is the bottom thumb zone with the board-mirror drawer directly above it.
- React to resize, orientation, device-pixel-ratio, safe-area insets, virtual keyboard, and visibility changes without losing input or restarting the round.

### Screens and overlays

- **Title/home:** Play is dominant; daily challenge, journey progress, and profile are one level below.
- **Mode setup:** show rules, expected duration, player count, assists, and whether the result is ranked before commitment.
- **Play HUD:** objective, progress, current actor/state, pause, and only context-relevant actions.
- **Pause/settings:** resume first; audio, graphics, controls, accessibility, help, and leave are clearly separated.
- **Results:** outcome headline, score breakdown, progress, achievements, comparison, replay/retry, and next recommended action.
- **Help:** visual rule cards generated from current control mappings and representative legal states.
- Daily challenge, local practice, pause, resume, results, and progression are first-class screens.

### Input

- Pointer/touch: raycast only against explicit interaction layers; use pointer capture for drags; cancel safely on lost capture.
- Touch: distinguish tap, drag, and camera gesture by distance/time thresholds; never require multi-touch for core play.
- Keyboard: directional navigation among legal targets, confirm, cancel, pause, undo/hint where valid, and camera reset.
- Gamepad: focus navigation, primary/secondary actions, pause, and remappable axes/buttons.
- Prevent accidental double commits with action identifiers, not arbitrary long debounce timers. Provide visible drag origin, target preview, and invalid-action explanation.

### Accessibility

- Full keyboard operation and visible focus; the board mirror and named tile areas as equivalents for the 3D tiles; announcements (ui.announce) for objective, turn, score, errors, and results.
- Color is reinforced by shape, texture, icon, or label. Include contrast-safe and common color-vision palettes.
- Reduced-motion mode removes camera swoops, shake, parallax, rapid particles, and large scaling while preserving event timing.
- Independent sliders for music, effects, ambience, and voice; captions/text cues for meaningful audio; no audio-only gameplay.
- Options for larger text, high contrast, left-handed controls, hold-versus-toggle, timing assistance, haptics off, and tutorial replay.
- Announce Three.js board state through a concise navigable model rather than describing every decorative object.

## 4. Visual and audio design

### Visual contract

The subject is the active playfield at near-tabletop to room scale, framed so state changes occupy most of the screen. The scene is a serene floating tea table with carved tiles. Use an authored camera, original procedural geometry, restrained environmental storytelling, and a deterministic visual seed. The no-post-processing baseline must still communicate hierarchy, depth, selection, and state.

### Three.js scene design

- Use physically based lighting and color management with one dominant key, soft environment fill, and contact grounding. Gameplay colors are tested after tone mapping.
- Build reusable semantic meshes for active pieces, board cells, obstacles, targets, and environment modules. Geometry detail follows silhouette importance and camera distance.
- Use instancing for repeated pieces and props, pooled effects, texture atlases where appropriate, and explicit disposal on scene changes.
- Separate render layers for environment, gameplay, selection/ghosts, effects, and UI anchors. Cosmetic particles never intercept raycasts.
- Selection uses a combination of lift/pose, outline or rim, and grounded marker—not bloom alone. Legal targets preview before commit; invalid targets explain why.
- Event hierarchy: input acknowledgment < legal move < combo/goal < round completion. Reserve camera motion, strong emission, and dense particles for the highest tier.
- Audio uses original short transients tied to logical events, layered material impacts, quiet ambience, and adaptive music stems. Randomized pitch/variant is seeded for replay consistency where recording matters.

### Camera and motion

- Choose orthographic or low-distortion perspective according to depth requirements; expose framing constants rather than magic offsets.
- Camera transitions use authored duration/easing or critically damped springs and remain interruptible. Never animate by cumulative per-frame lerp.
- Decorative motion is paused or reduced when hidden. Gameplay animation derives from simulation state and interpolation alpha, not frame count.
- Camera shake is low-amplitude, event-tiered, disabled by reduced motion, and never changes raycast truth.
- Play framing: the authored anchors keep their position and angle, and a lens shift + zoom (`setViewOffset`) fits the level's board and the tray into the part of the canvas that the play HUD leaves free. Full-width bars and side rails are always kept clear, and small corner pieces such as the collapsed board mirror only when the board or tray would sit under them. Framing is re-fitted on resize, on a new level and whenever HUD chrome changes size. It springs with the camera and is off on the title and for the win close-up.
- The round-end cue caption is cleared when the results panel opens.

### Graphics-skill routing

During implementation, begin with `threejs-skill-router` and load only the following retained skills because they materially affect this visual target:

- `threejs-camera-direction` for deliberate framing and input-safe camera transitions
- `threejs-procedural-geometry` for authored, inspectable meshes instead of primitive-only placeholders
- `threejs-procedural-materials` for coherent PBR surfaces, perceptual parameters, and readable state masks
- `threejs-procedural-animation` for deterministic motion phases, springs, and interruption-safe transitions
- `threejs-procedural-vfx` for bounded particles, trails, impact accents, and event hierarchy
- `threejs-exposure-color-grading` for tone mapping, adaptation limits, and accessible color separation
- `threejs-image-pipeline` for explicit depth/color ownership and pass ordering
- `threejs-visual-validation` for fixed-view captures, seed sweeps, and performance evidence

Follow the skill pack's acceptance gate: deterministic seeds, debug views for controlling fields, perceptually grouped parameters, mechanism-backed quality tiers, and a readable no-post baseline. Do not add an effect merely because a skill exists.

### Performance budgets

- Target 60 fps at the default tier and a stable 30 fps fallback on constrained mobile hardware.
- Default active gameplay: ≤150 draw calls desktop, ≤90 mobile; ≤350k visible triangles desktop, ≤140k mobile; transient particles ≤20k desktop and ≤5k mobile.
- Cap device pixel ratio by quality tier; dynamically lower render scale before dropping simulation rate. UI text remains native resolution.
- Avoid runtime shader compilation during active play by prewarming required variants. Avoid per-frame allocations in simulation/render loops.
- Quality tiers independently control shadows, environment detail, particles, post effects, antialiasing, and render scale; they never alter rules or visibility of hazards.

### Graphics

The table is lit as the r164 browser build lit it, with its own values (engine minor 23 follows three.js r185's physical light units and shadows, so no ÷π or bias re-tuning): ACES filmic tone mapping, a warm key directional light (2.6, theme-coloured; its orthographic shadow camera fitted to the table, tray and props; bias −0.0004, normal bias 0.02, radius 3) with a slow, very small breath when the background moves, a hemisphere sky fill and a faint ambient. Reflections as the page set them: with reflections on, `RoomEnvironment(renderer)` through PMREM (σ 0.04) at environment intensity 0.35, else a small generated sky-and-glow room at 1. The sky dome is a WGSL gradient (not tone mapped), fog 22–70.

The runtime's Options choose the graphics level (Auto from the device, render scale, adaptive resolution, frame-rate limit and readout). `native/quality.ts` maps its tier onto the browser build's presets and budgets:

| | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Shadows | off | 1024² | 2048² | 4096² |
| Ambient occlusion (GTAO) | off | off | on | high |
| Bloom (0.4 / 0.4 / 1.25, bloom model "r160" at the page strength 0.4, minor 30) · linear grade (over-range kept) + vignette | off | on | on | on |
| Antialiasing | off | FXAA | SMAA | MSAA |
| Room reflections · islands · table bump/roughness · lacquered tiles | off | on | on | on |
| Particles (petals, mist, steam, bursts) | low ×0.75 | medium | high | high ×1.25 |
| Shading | Lambert | Standard | Physical | Physical |
| Tile textures / bevel–corner segments / prop segments | 128 · 1/3 · 0.6× | 256 · 2/4 · 0.8× | 256 · 2/6 · 1× | 512 · 3/8 · 1.5× |

Within a tier the particle multiplier grows with the level index (≤ 2×). The old per-category overrides are not offered. Reduced motion (the runtime's) stops petals, mist, islands, clouds and steam and shortens flights and bursts. The lacquer roughness grain is baked (`tools/bake-grain.mjs` → `assets/grain.png`; the per-pixel canvas loop is too slow natively). Teapot steam is additive soft points whose colour fades with life (engine points take no shader).

## 5. Technical architecture

### Client modules

- `js/rules/*` (engine, content, layout, solver, rng), `js/session/*` (session, checksummed save document): the browser build's pure modules, shared with the node tests. `js/rules/engine.js` clones state by JSON (the interpreter has no `structuredClone`).
- `native/main.ts`: the state machine, the 250 ms rules clock on 60 Hz fixed steps, input, lessons, results.
- `native/render.ts` (+ `native/paint.js`, the tile painters): the table, tiles, tray, camera rig and framing, effects.
- `native/screens.ts` + `native/style.ts` (`tools/ui-style.css` → `assets/ui-style.json` via `npm run css`): every screen and the HUD.
- `native/platform.ts` (+ `js/migrate.js`): save, legacy settings, player, clock, leaderboard. `native/audio.ts`: clips and the rendered bed/music. `native/hint.ts` + `native/hint-worker.js`: the hint search on a script worker. `native/i18n.ts`.

### Localization

- Every string ships in nine locales (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT): `js/ui/strings.js`, `js/ui/platform-strings.js`, `js/ui/engine-strings.js` (strings the engine client added) and `js/ui/gfx-strings.js` (the Graphics heading). The language is the runtime's interface language (Options › Language, else the account's preferred language or the device's); a change shows on the next frame without restarting the round.

No module may mutate rules state except through a validated command. Rendering consumes immutable snapshots plus interpolation data. UI state and simulation state are separate so closing a drawer cannot affect a match.

### Determinism, replay, and security

- Fixed simulation step where physics exists; quantize authoritative inputs and define stable collision/order rules.
- Use separate seeded random streams for rules, content decoration, and audiovisual variants. Cosmetic randomness never changes rules.
- Replay envelope: schema version, build/content version, seed, initial hash, timestamp offset, ordered commands, periodic state hashes, terminal result.
- Validate all network input for identity, session membership, turn/tick, bounds, rate, payload size, and legal action. Reject duplicates idempotently by command ID.
- Treat client clocks, scores, inventories, roles, physics outcomes, and completion claims as untrusted in competitive contexts.

### Loading and resilience

- Show useful progress by asset group; load core rules/UI first and scenic assets lazily. Provide procedural low-detail substitutes if optional assets fail.
- Cache immutable hashed assets and the last safe local snapshot. Updates activate between rounds, never during one.
- Recover WebGL context by rebuilding GPU resources from retained CPU descriptors. If 3D is unavailable, present a clear compatibility message and preserve account/session state.
- Background tabs reduce rendering to zero or a low heartbeat while preserving required network lifecycle.

## 6. StarHermit integration

### Packaging and launch
- `starhermit.txt`: `launch=index.html` (the engine's web loader, written by `npm run package` with `starhermit-files.json`), `engine.entry=native/main.ts`, `engine.version=1.28.0`, `engine.minor=30`, capabilities platform, storage, clipboard; `server=score-script.js`.
- Controls: `control.*` actions focus_left/right/up/down (arrows), pick (Enter, Space, Numpad Enter), undo (U), hint (H), camera (C), pause (Esc); pads: D-pad / left stick focus, South picks, West hints, North undoes, right shoulder resets the camera, Start or East pauses. Players rebind in the runtime's Options. Pointer / touch: tap or click an uncovered tile (taps over 12 px or 600 ms are camera gestures and ignored; with Hold to confirm a 400 ms press picks); presses that start on the interface never reach the table (`ui.pointerCaptured()`).
- Signed out the game makes no platform calls beyond the runtime's own; the Daily Steep's day comes from the platform clock (`serverNow`) when it answered, else the device's UTC date.

### Identity, profile, presence, and preferences
- Guests play under a renameable local name (the title's name button opens a text field). Signed out, the title offers **Sign in with StarHermit**; signed in it shows the account name and **Invite a friend** (copies the invite link).
- The save is the checksummed SaveStore document in the engine save (device + the player's cloud slot); conflicts merge with `mergeSaveDocs`; the browser build's cloud slot (`game:<slug>`) shows as foreign and is merged in once (`SaveStore.mergeCloud`) and replaced.
- The game's own options live in the save (captions for sound cues, symbol palette, left-handed layout, hold to confirm, timing assistance, camera view, table theme). The browser build's settings KV keys are read once (those options carry over) and removed. Volumes, mute, voice limit, graphics, language, larger text, high contrast, reduced motion and haptics are the runtime's Options (Settings links to them and to key bindings).
- Ranked rounds (Journey, Daily, Challenge) signed in post their total to the `high-score` board through `score-script.js` (range-checked solo score, a practice session socket's `result`); the results show the rank. Achievements stay in the save (local, as before).

### Discovery, activity, and social layer
- The game sends no presence, activity or telemetry calls (no route is reachable with a launch token). Entitlement or catalog state belongs to host-owned chrome; the game stays playable without promotional interruption.
- The invite link is the social entry point; friends-only leaderboard filtering is offered on the platform board.
- No gameplay chat or voice: they are not relevant to the core solo loop.

### Achievements and leaderboards
- Declare a small static achievement set: first completion, mechanic mastery, a sustained streak, a difficult content milestone, and an accessibility-neutral long-term goal. Keys are stable, lowercase identifiers; unlocks are idempotent and local-only (a pure browser game has no server-authoritative unlock path); they ride in the cloud-saved document.
- Provide global and friends-filtered boards for the primary metric plus a fair daily/weekly board. The platform owns the global leaderboard, read via `StarHermit.leaderboard()` (friends filter passes `scope=friends`), and the game keeps personal bests locally and in the cloud-saved document. When signed in, every finished ranked round (Journey, Daily, Challenge — not Practice or Learn) posts its score through `StarHermit.submitScores` (a practice session whose platform script `score-script.js` posts it to the `high-score` board: integer, higher is better, 0–1,000,000); the results board line shows "Posting score…", then "Leaderboard rank: #N" (or posted / not posted), localized in the nine locales (`js/ui/platform-strings.js`). Standalone the line says the local best was recorded and nothing is sent. The game's own `server.js` still offers replay-validated boards for its dev deployment, but the client no longer calls it.

### Sessions and transport
- The initial game is solo. The shipped `server.js` remains the game's own dev backend (seeded daily descriptors, replay validation, durable daily sessions) and is not a platform game script (the platform runs `score-script.js`), so there are no platform matchmaking, achievements or replays and the only platform session is the score post's practice session; the client calls only platform routes, and only when hosted.
- A daily session records content version, seed, settings affecting difficulty, an ordered input log, score components, and final checksum. Reconnect from the durable session snapshot rather than trusting cached client state.
- Realtime rooms, peer relay, matchmaking, backfill, and voice are intentionally not used because they add no value to this ruleset.

### Publishing and operations
- The platform script is `score-script.js` (canonical copy in the games repo's `tools/score-script.js`), declared with `server=score-script.js`; `server.js` is the local dev server. Choose a digest-pinned container only if profiling proves the sandbox unsuitable; no initial design here requires one.
- Define control defaults, achievement metadata, and versioned settings before release. Publish immutable build assets, verify the launch path, maintain migration tests for saves, and expose no secret configuration to the client.
- Capture anonymous funnel events only for start, tutorial step, round end, retry, settings change, and error category. Avoid raw text, precise personal data, and cross-title tracking.

## 7. Content, economy, and retention

- Launch scope: tutorial sequence, at least 40 authored stages or equivalent procedural depth, daily challenge, practice, five visual themes, and a mastery track.
- Cosmetic rewards may alter materials, trails, board surrounds, ambience, or profile flourishes, but never hitboxes, timing windows, information, or power.
- Reward cadence: early feedback every session, meaningful unlock every 3–5 sessions, and long-term goals visible without manipulative countdowns.
- No real-money wagering, paid random rewards, forced advertising, energy pressure, punitive streak loss, or purchases that affect competitive outcomes.
- Notifications, if ever added by the host, are opt-in, frequency-capped, quiet-hour aware, and never use false urgency.

## 8. Analytics and privacy

Measure tutorial completion, first meaningful action time, session duration bands, level attempts, quit state, input modality, performance tier, reconnect success, and accessibility feature usage only in aggregate. Use random session identifiers, short retention, and explicit consent where required. Never collect message content, drawings, voice, private board notes, or exact pointer trails as analytics.

Success targets for the first public test: median first-play time under 20 seconds, tutorial completion above 80%, crash-free sessions above 99.5%, p95 input acknowledgment below 100 ms locally, and at least 95% of supported mobile sessions holding their selected frame-rate tier.

## 9. Testing and acceptance criteria

### Rules and content

- Unit-test every legal action, invalid-action reason, scoring component, terminal state, and serialization migration.
- Property-test deterministic replay: the same version, seed, and commands produce identical state hashes.
- Fuzz malformed commands and generated content; prove no hangs, NaN physics, impossible mandatory states, or unbounded loops.
- Golden-test representative easy, medium, hard, interrupted, resumed, and terminal sessions.

### Interface and accessibility

- Test pointer, coarse touch, keyboard-only, gamepad, screen reader, zoom to 200%, reduced motion, high contrast, safe areas, and both mobile orientations.
- Verify focus restoration after every modal, meaningful live announcements, no keyboard traps, and no hover-only instructions.
- Confirm all critical labels fit translated strings at 30% expansion and support right-to-left layout where localized.

### Graphics and performance

- Produce fixed-camera captures for every quality tier, deterministic seed sweeps, no-post baselines, debug-view mosaics, and 10-minute temporal stability runs.
- Profile CPU, GPU, memory, shader compilation, draw calls, triangles, texture memory, and garbage collection on representative desktop and mobile classes.
- Verify effects cannot obscure legal targets, alter picking, leak resources, or continue expensive updates while hidden.

### Platform and network

- Test expired/rotated tokens, privacy settings, rate limits, offline start, reconnect at each game state, duplicate commands, out-of-order events, server restart, and version mismatch.
- Verify achievement idempotency, leaderboard validation, friends-only filtering, cloud-save conflict handling, activity start/end pairing, and server-time countdown accuracy.
- For hosted sessions, test disconnect/rejoin, abandonment, timeout, invitation expiry, result reconciliation, replay access, moderation controls, and authoritative cheat attempts.

## 10. Definition of done and non-goals

Acceptance is automated in `tests/` (`npm test`): the rules, replay determinism, content validation, fuzz and i18n node tests, `tests/save.test.mjs` (save, foreign merge, conflict merge, legacy options, baked grain), and `tests/native.mjs` — tsc, `starhermit check` with no warnings, the web index up to date, and render-check play scripts (`tools/gen-plays.mjs`, from the solver) that drive the real UI: every menu screen, Journey 1 on a desktop (tiles clicked on the table, hint, results, next stage), Lesson 1 on a DPR-3 phone through the board mirror, Six Cups lost on a phone held sideways, and today's Daily Steep (generated at test time). `npm run test:browser` (`tools/browser-play.mjs`) plays the packaged loader in GPU Chrome at desktop, phone and landscape sizes.

### Known limitations
- The Daily Steep's server-side snapshot resume and excluded days were never served by the platform (the old client's stubs always answered nothing); they are not shown.
- The How to Play card says ranked scores are verified by replaying moves on the server; the score script range-checks the total only (unchanged from the browser build).
- Teapot steam is drawn as additive points, not the old per-point shader.

Non-goals remain unchanged: no monetization work, no native wrappers, no real-money systems, and no copying of any existing product. Future changes favor one excellent core loop and a coherent original visual identity over feature breadth.
