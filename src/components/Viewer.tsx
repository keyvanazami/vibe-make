"use client";

import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport, Grid } from "@react-three/drei";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function STLMesh({ stlBase64 }: { stlBase64: string }) {
  const geometry = useMemo(() => {
    const loader = new STLLoader();
    const geom = loader.parse(base64ToArrayBuffer(stlBase64));
    geom.computeVertexNormals();
    geom.center();
    return geom;
  }, [stlBase64]);

  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial color="#9aa7ff" metalness={0.15} roughness={0.55} />
    </mesh>
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
}: {
  stlBase64: string | null;
  onReady?: (handle: ViewerHandle) => void;
}) {
  const captureRef = useRef<(() => string | null) | null>(null);

  useEffect(() => {
    if (onReady) {
      onReady({
        capturePng: () => (captureRef.current ? captureRef.current() : null),
      });
    }
  }, [onReady]);

  return (
    <div className="w-full h-full bg-neutral-950 rounded-lg overflow-hidden border border-neutral-800">
      <Canvas
        shadows
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        camera={{ position: [80, 80, 80], fov: 45, near: 0.1, far: 5000 }}
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
          {stlBase64 ? <STLMesh stlBase64={stlBase64} /> : null}
        </Suspense>

        <OrbitControls makeDefault enableDamping />
        <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
          <GizmoViewport axisColors={["#ff5a5a", "#5aff7d", "#5aaaff"]} labelColor="black" />
        </GizmoHelper>

        <CaptureBridge onReady={(fn) => { captureRef.current = fn; }} />
      </Canvas>
    </div>
  );
}
