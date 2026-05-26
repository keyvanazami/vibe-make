"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport, Grid, Line, Html } from "@react-three/drei";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Data emitted when the user clicks a surface. worldPoint is in the centered
// viewer frame (for drawing the marker); modelPoint adds back the centering
// offset so it matches the SCAD's own coordinate system (what we tell the LLM).
export type PickData = {
  worldPoint: [number, number, number];
  modelPoint: [number, number, number];
  normal: [number, number, number];
};

export type ViewerSelection = {
  worldPoint: [number, number, number];
  normal: [number, number, number];
};

// A dimension annotation drawn alongside the model (centered viewer frame).
export type DimLine = {
  from: [number, number, number];
  to: [number, number, number];
  label: string;
};

const DIM_COLOR = "#22d3ee";

function DimensionLines({ lines }: { lines: DimLine[] }) {
  return (
    <>
      {lines.map((d, i) => {
        const mid: [number, number, number] = [
          (d.from[0] + d.to[0]) / 2,
          (d.from[1] + d.to[1]) / 2,
          (d.from[2] + d.to[2]) / 2,
        ];
        return (
          <group key={i}>
            <Line points={[d.from, d.to]} color={DIM_COLOR} lineWidth={2.5} depthTest={false} renderOrder={1100} />
            {/* DOM label avoids font/suspense issues and stays crisp; it is an
                overlay, so it is not baked into capturePng (preview/export). */}
            <Html position={mid} center zIndexRange={[100, 0]} pointerEvents="none">
              <div
                style={{
                  background: "rgba(10,10,10,0.8)",
                  color: DIM_COLOR,
                  border: `1px solid ${DIM_COLOR}`,
                  borderRadius: 6,
                  padding: "1px 6px",
                  fontSize: 12,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  userSelect: "none",
                }}
              >
                {d.label}
              </div>
            </Html>
          </group>
        );
      })}
    </>
  );
}

function STLMesh({
  stlBase64,
  onPick,
  onSize,
  onBounds,
}: {
  stlBase64: string;
  onPick?: (d: PickData | null) => void;
  onSize?: (radius: number) => void;
  onBounds?: (dims: [number, number, number]) => void;
}) {
  const { geometry, offset, radius, dims } = useMemo(() => {
    const loader = new STLLoader();
    const geom = loader.parse(base64ToArrayBuffer(stlBase64));
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    const bb = geom.boundingBox!;
    const c = bb.getCenter(new THREE.Vector3());
    const sz = bb.getSize(new THREE.Vector3());
    geom.center(); // shift so the bounding-box center sits at the origin
    geom.computeBoundingSphere();
    const r = geom.boundingSphere?.radius ?? 50;
    return { geometry: geom, offset: c, radius: r, dims: [sz.x, sz.y, sz.z] as [number, number, number] };
  }, [stlBase64]);

  useEffect(() => { onSize?.(radius); }, [radius, onSize]);
  useEffect(() => { onBounds?.(dims); }, [dims, onBounds]);

  return (
    <mesh
      geometry={geometry}
      castShadow
      receiveShadow
      onClick={(e) => {
        if (!onPick) return;
        e.stopPropagation();
        const p = e.point;
        // The mesh has only a translation (no rotation/scale), so the geometry
        // face normal already matches world/model orientation.
        const n = e.face
          ? e.face.normal.clone().normalize()
          : new THREE.Vector3(0, 0, 1);
        onPick({
          worldPoint: [p.x, p.y, p.z],
          modelPoint: [p.x + offset.x, p.y + offset.y, p.z + offset.z],
          normal: [n.x, n.y, n.z],
        });
      }}
      onPointerOver={() => { document.body.style.cursor = "crosshair"; }}
      onPointerOut={() => { document.body.style.cursor = "default"; }}
    >
      <meshStandardMaterial color="#9aa7ff" metalness={0.15} roughness={0.55} />
    </mesh>
  );
}

const MARKER_COLOR = "#ff7a1a";

function SelectionMarker({
  selection,
  modelRadius,
}: {
  selection: ViewerSelection;
  modelRadius: number;
}) {
  const pos = useMemo(
    () => new THREE.Vector3(...selection.worldPoint),
    [selection.worldPoint]
  );
  // Orient a ring/disc so it lies flat against the picked surface (its axis,
  // local +Z, aligned to the surface normal).
  const quat = useMemo(() => {
    const n = new THREE.Vector3(...selection.normal).normalize();
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  }, [selection.normal]);

  // Scale every element to the model so the marker reads the same on a 10mm
  // trinket or a 200mm bracket.
  const s = Math.max(modelRadius, 6);
  const ringR = s * 0.16;
  const tube = s * 0.022;
  const sphereR = s * 0.045;
  const arrowLen = s * 0.5;

  const arrow = useMemo(() => {
    const dir = new THREE.Vector3(...selection.normal).normalize();
    const a = new THREE.ArrowHelper(dir, pos, arrowLen, MARKER_COLOR, arrowLen * 0.32, arrowLen * 0.2);
    (a.line.material as THREE.Material).depthTest = false;
    (a.cone.material as THREE.Material).depthTest = false;
    a.renderOrder = 1001;
    return a;
  }, [pos, selection.normal, arrowLen]);

  // Gentle pulse to draw the eye.
  const pulse = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (pulse.current) {
      pulse.current.scale.setScalar(1 + 0.16 * Math.sin(clock.elapsedTime * 4.5));
    }
  });

  return (
    <group>
      <group position={pos} quaternion={quat}>
        <group ref={pulse}>
          <mesh renderOrder={1000}>
            <torusGeometry args={[ringR, tube, 16, 64]} />
            <meshBasicMaterial color={MARKER_COLOR} depthTest={false} transparent opacity={0.95} />
          </mesh>
          <mesh renderOrder={999}>
            <circleGeometry args={[ringR, 64]} />
            <meshBasicMaterial
              color={MARKER_COLOR}
              depthTest={false}
              transparent
              opacity={0.22}
              side={THREE.DoubleSide}
            />
          </mesh>
        </group>
      </group>
      <mesh position={pos} renderOrder={1002}>
        <sphereGeometry args={[sphereR, 24, 24]} />
        <meshBasicMaterial color="#ffd089" depthTest={false} />
      </mesh>
      <primitive object={arrow} />
    </group>
  );
}

function CaptureBridge({ onReady }: { onReady: (capture: () => string | null) => void }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    onReady(() => {
      try {
        gl.render(scene, camera);
        const url = gl.domElement.toDataURL("image/png");
        const idx = url.indexOf(",");
        return idx >= 0 ? url.slice(idx + 1) : null;
      } catch {
        return null;
      }
    });
  }, [gl, scene, camera, onReady]);
  return null;
}

export type ViewerHandle = { capturePng: () => string | null };

export default function Viewer({
  stlBase64,
  onReady,
  selection,
  onPick,
  onBounds,
  dimensions,
}: {
  stlBase64: string | null;
  onReady?: (handle: ViewerHandle) => void;
  selection?: ViewerSelection | null;
  onPick?: (d: PickData | null) => void;
  onBounds?: (dims: [number, number, number]) => void;
  dimensions?: DimLine[];
}) {
  const captureRef = useRef<(() => string | null) | null>(null);
  const [modelRadius, setModelRadius] = useState(50);

  useEffect(() => {
    if (onReady) {
      onReady({
        capturePng: () => (captureRef.current ? captureRef.current() : null),
      });
    }
  }, [onReady]);

  return (
    <div className="w-full h-full bg-neutral-950 rounded-xl overflow-hidden border border-neutral-800/80 shadow-xl shadow-black/30">
      <Canvas
        shadows
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        camera={{ position: [80, 80, 80], fov: 45, near: 0.1, far: 5000 }}
        onPointerMissed={() => onPick?.(null)}
      >
        <color attach="background" args={["#0a0a0a"]} />
        <ambientLight intensity={0.45} />
        <directionalLight
          position={[100, 150, 100]}
          intensity={1.1}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />
        <directionalLight position={[-80, 40, -60]} intensity={0.4} />

        <Grid
          args={[400, 400]}
          cellSize={5}
          cellThickness={0.5}
          sectionSize={25}
          sectionThickness={1}
          sectionColor="#444"
          cellColor="#2a2a2a"
          fadeDistance={300}
          fadeStrength={1.2}
          infiniteGrid
        />

        <Suspense fallback={null}>
          {stlBase64 ? (
            <STLMesh stlBase64={stlBase64} onPick={onPick} onSize={setModelRadius} onBounds={onBounds} />
          ) : null}
        </Suspense>
        {selection ? (
          <SelectionMarker selection={selection} modelRadius={modelRadius} />
        ) : null}
        {dimensions && dimensions.length > 0 ? (
          <DimensionLines lines={dimensions} />
        ) : null}

        <OrbitControls makeDefault enableDamping />
        <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
          <GizmoViewport axisColors={["#ff5a5a", "#5aff7d", "#5aaaff"]} labelColor="black" />
        </GizmoHelper>

        <CaptureBridge onReady={(fn) => { captureRef.current = fn; }} />
      </Canvas>
    </div>
  );
}
