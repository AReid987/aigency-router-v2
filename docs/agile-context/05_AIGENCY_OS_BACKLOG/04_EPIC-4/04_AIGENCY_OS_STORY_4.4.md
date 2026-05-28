# Story 4.4: Holo-CRT React/Three.js Canvas

**Overview Description:** Render the 3D center monolith, provider orbits, and Judge pyramid using React Three Fiber.

**Complexity Score:** 13

**Dependencies:** None

**Developer Guidance:** Keep geometries simple (Spheres and Boxes) to maintain 60fps. The heavy lifting should be in the post-processing Bloom passes. Setup the camera with a slight downward angle.

### Checkbox Tasklist:
* [ ] Setup Vite + React + TailwindCSS workspace.
* [ ] Render Three.js base geometries for the Monolith (Center), DB nodes (Inner Orbit), and APIs (Outer Orbit).
* [ ] Implement `EffectComposer` for UnrealBloomPass and custom CRT scanlines.

### Acceptance Criteria:
* Application renders a 60fps 3D environment matching the specific HEX color constraints.

### Resource URLs:
* React Three Fiber: [https://docs.pmnd.rs/react-three-fiber/getting-started/introduction](https://docs.pmnd.rs/react-three-fiber/getting-started/introduction)
* R3F Post Processing: [https://docs.pmnd.rs/react-three-fiber/tutorials/post-processing](https://docs.pmnd.rs/react-three-fiber/tutorials/post-processing)
