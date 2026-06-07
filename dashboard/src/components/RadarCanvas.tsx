import { useRef, useMemo, useEffect, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { EffectComposer, Bloom, Scanline, ChromaticAberration } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import * as THREE from 'three';
import { useTelemetryStore } from '../store/telemetry';

/* ── Constants ─────────────────────────────────────────────────── */
const AMBER = '#FFB000';
const GREEN = '#00FF41';
const PROVIDERS = ['Groq', 'Cerebras', 'Together'] as const;
const ORBIT_RADIUS = 3;
const ORBIT_SPACING = (2 * Math.PI) / PROVIDERS.length; // 120° apart

/* ── Center Monolith ───────────────────────────────────────────── */
function CenterMonolith({ flash }: { flash: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const flashIntensity = useRef(0);

  useFrame((_state, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.3;
      meshRef.current.rotation.x += delta * 0.15;
    }
    // Flash effect on DRIFT_HEALED
    flashIntensity.current *= 0.95;
  });

  useEffect(() => {
    if (flash) {
      flashIntensity.current = 2.0;
    }
  }, [flash]);

  return (
    <mesh ref={meshRef}>
      <boxGeometry args={[1.2, 1.2, 1.2]} />
      <meshStandardMaterial
        color={AMBER}
        emissive={AMBER}
        emissiveIntensity={0.8 + flashIntensity.current}
        roughness={0.3}
        metalness={0.6}
      />
    </mesh>
  );
}

/* ── Provider Node ─────────────────────────────────────────────── */
function ProviderNode({ position }: { position: [number, number, number] }) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((_state, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.5;
    }
  });

  return (
    <group position={position}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.4, 16, 16]} />
        <meshStandardMaterial
          color={GREEN}
          emissive={GREEN}
          emissiveIntensity={0.6}
          roughness={0.4}
          metalness={0.5}
        />
      </mesh>
      {/* Label ring */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.5, 0.55, 32]} />
        <meshBasicMaterial color={GREEN} transparent opacity={0.4} />
      </mesh>
    </group>
  );
}

/* ── Laser Line (primitive-based to avoid SVG collision) ────────── */
function LaserLine({
  start,
  end,
  active,
}: {
  start: [number, number, number];
  end: [number, number, number];
  active: boolean;
}) {
  const materialRef = useRef<THREE.LineBasicMaterial | null>(null);
  const opacity = useRef(0);
  const targetOpacity = active ? 1 : 0;

  useFrame((_state, delta) => {
    opacity.current += (targetOpacity - opacity.current) * delta * 4;
    if (materialRef.current) {
      materialRef.current.opacity = opacity.current;
    }
  });

  const lineObj = useMemo(() => {
    const points = [new THREE.Vector3(...start), new THREE.Vector3(...end)];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: AMBER,
      transparent: true,
      opacity: 0,
    });
    const line = new THREE.Line(geometry, material);
    materialRef.current = material;
    return line;
  }, [start, end]);

  return <primitive object={lineObj} />;
}

/* ── Orbital Ring ──────────────────────────────────────────────── */
function OrbitalRing({ radius, color }: { radius: number; color: string }) {
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]}>
      <ringGeometry args={[radius - 0.02, radius + 0.02, 64]} />
      <meshBasicMaterial color={color} transparent opacity={0.15} />
    </mesh>
  );
}

/* ── Scene ─────────────────────────────────────────────────────── */
function Scene({ activeRoute, flash }: { activeRoute: boolean; flash: boolean }) {
  const groupRef = useRef<THREE.Group>(null);

  // Slow scene rotation for ambient motion
  useFrame((_state, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.05;
    }
  });

  // Calculate provider positions in orbit
  const providerPositions = useMemo(
    () =>
      PROVIDERS.map((_, i) => {
        const angle = i * ORBIT_SPACING;
        return [
          Math.cos(angle) * ORBIT_RADIUS,
          0,
          Math.sin(angle) * ORBIT_RADIUS,
        ] as [number, number, number];
      }),
    []
  );

  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.15} />
      <pointLight position={[0, 5, 0]} intensity={1.5} color={AMBER} distance={15} />
      <pointLight position={[0, -3, 0]} intensity={0.5} color={GREEN} distance={10} />

      {/* Scene group with slow rotation */}
      <group ref={groupRef}>
        {/* Center Monolith */}
        <CenterMonolith flash={flash} />

        {/* Orbital Ring */}
        <OrbitalRing radius={ORBIT_RADIUS} color={GREEN} />

        {/* Provider Nodes */}
        {PROVIDERS.map((name, i) => (
          <ProviderNode key={name} position={providerPositions[i]} />
        ))}

        {/* Laser Lines from center to each provider */}
        {providerPositions.map((pos, i) => (
          <LaserLine key={i} start={[0, 0, 0]} end={pos} active={activeRoute} />
        ))}
      </group>

      {/* CRT Post-Processing */}
      <EffectComposer>
        <Bloom
          blendFunction={BlendFunction.ADD}
          luminanceThreshold={0.1}
          luminanceSmoothing={0.9}
          intensity={1.5}
          mipmapBlur
        />
        <Scanline
          blendFunction={BlendFunction.OVERLAY}
          density={1.5}
          opacity={0.15}
        />
        <ChromaticAberration
          blendFunction={BlendFunction.NORMAL}
          offset={new THREE.Vector2(0.002, 0.002)}
          radialModulation={false}
          modulationOffset={0.0}
        />
      </EffectComposer>
    </>
  );
}

/* ── Exported RadarCanvas ──────────────────────────────────────── */
export default function RadarCanvas() {
  const events = useTelemetryStore((s) => s.events);

  // Activate laser lines on FAST_TRACK_ROUTE events
  const [activeRoute, setActiveRoute] = useState(false);
  const [flash, setFlash] = useState(false);
  const routeTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0];

    if (latest.event_class === 'FAST_TRACK_ROUTE') {
      setActiveRoute(true);
      // Pulse: show laser for 1.5s then fade
      clearTimeout(routeTimeoutRef.current);
      routeTimeoutRef.current = setTimeout(() => setActiveRoute(false), 1500);
    }

    if (latest.event_class === 'DRIFT_HEALED') {
      setFlash(true);
      setTimeout(() => setFlash(false), 200);
    }
  }, [events]);

  return (
    <div className="w-full h-full">
      <Canvas
        camera={{ position: [0, 3, 5], fov: 50, near: 0.1, far: 100 }}
        gl={{ antialias: true, alpha: false }}
        style={{ background: '#050505' }}
      >
        <Scene activeRoute={activeRoute} flash={flash} />
        <OrbitControls
          enablePan={false}
          enableZoom={true}
          minDistance={3}
          maxDistance={10}
          maxPolarAngle={Math.PI * 0.65}
          minPolarAngle={Math.PI * 0.2}
          autoRotate={false}
        />
      </Canvas>
    </div>
  );
}
