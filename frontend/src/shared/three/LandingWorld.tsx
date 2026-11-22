/** The product's 3D world: one continuous scene that the camera travels through.
 *
 *  What it shows is what the product does (PRD section 6):
 *    - a river of coins: the customer's real AI calls, flowing straight on to the provider. Nothing stops them ("observe, never intercept");
 *    - a glass branch: a COPY of each call leaves the river, is checked at a gate (passed: cyan, failed: magenta, failures included);
 *    - the layers of evidence the copies land on, the newest on top, older ones fading ("evidence ages by relevance");
 *    - a verdict: the dearer coin and the cheaper one that does the same work.
 *  It shows no real figure. Every number on the page is ordinary text beside it. Loaded only on a browser that can draw it.
 *
 *  `premium` adds the cinematic finish: a glow on the bright parts, a light film grain, a vignette and a trace of lens fringing. It is left
 *  off on small machines, where the same world is drawn plainly. */
import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, ChromaticAberration, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const CYAN_HI = "#4cc3e3";
const MAGENTA = "#d3249b";
const GOLD = "#f2c14e";
const MIST = "#e4f5fa";
const DEEP = "#07102b";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/* The river: where real calls flow. */
const STREAM = new THREE.CatmullRomCurve3([v(-2.4, 1.2, 8), v(1.7, 0.5, 1), v(-1.3, 0.1, -10), v(1.5, -0.1, -26), v(-0.4, 0, -48), v(0, 0, -72)], false, "centripetal");
const STREAM_SAMPLES = STREAM.getSpacedPoints(700);
const BRANCH_FROM = STREAM.getPointAt(0.36);

/* The branch: a copy leaves the river, passes the gate, and lands on the evidence. */
const BRANCH = new THREE.CatmullRomCurve3(
  [BRANCH_FROM.clone(), v(BRANCH_FROM.x - 0.9, BRANCH_FROM.y - 1.6, BRANCH_FROM.z - 1.2), v(-2.5, -4.2, -17.5), v(-2.7, -9.4, -16.8), v(-2.5, -13.1, -16.4)],
  false,
  "centripetal",
);
const GATE_U = 0.36;
const GATE = BRANCH.getPointAt(GATE_U);
const GATE_QUAT = new THREE.Quaternion().setFromUnitVectors(v(0, 0, 1), BRANCH.getTangentAt(GATE_U).normalize());

/* The evidence: slabs stacked downward, the newest at the top. */
const STACK_TOP = -13.7;
const STACK_AT = v(-2.5, STACK_TOP, -16.4);
const LAYERS = 9;

/* The camera: where it stands and what it looks at, from the first screen to the verdict. */
const CAM = new THREE.CatmullRomCurve3([v(0.2, 1.0, 13), v(0.5, 1.1, 7), v(-2.2, -1.3, -9.5), v(1.9, -3.7, -15.5), v(8.4, -11.2, -3.5), v(11.5, -8.5, 6)], false, "centripetal");
const LOOK = new THREE.CatmullRomCurve3([v(-3, 0.1, -9), v(0, 0, -16), v(0, -5, -24), v(-2.2, -5.4, -19), v(-1.6, -16.5, -17.5), v(-1.8, -12, -17)], false, "centripetal");

interface Quality {
  lite: boolean;
}

type Caps = { map: THREE.CanvasTexture; bump: THREE.CanvasTexture };

/** A gold coin face: a ring, an inner ring and a mark, drawn once. Embossed by a matching bump map. */
function makeCoinTextures(): Caps {
  const draw = (bumpOnly: boolean) => {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    if (!g) throw new Error("no 2d context");
    if (bumpOnly) {
      g.fillStyle = "#808080";
      g.fillRect(0, 0, 256, 256);
    } else {
      const grad = g.createRadialGradient(110, 100, 8, 128, 128, 140);
      grad.addColorStop(0, "#fff3c2");
      grad.addColorStop(0.55, GOLD);
      grad.addColorStop(1, "#a9780c");
      g.fillStyle = grad;
      g.fillRect(0, 0, 256, 256);
    }
    const ink = bumpOnly ? "#ffffff" : "rgba(110,72,0,0.6)";
    g.strokeStyle = ink;
    g.fillStyle = ink;
    g.lineWidth = 7;
    g.beginPath();
    g.arc(128, 128, 112, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 3;
    g.beginPath();
    g.arc(128, 128, 90, 0, Math.PI * 2);
    g.stroke();
    g.font = "600 104px Georgia, 'Times New Roman', serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("M", 128, 136);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    if (!bumpOnly) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { map: draw(false), bump: draw(true) };
}

function Env() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = texture;
    scene.environmentIntensity = 0.85;
    return () => {
      scene.environment = null;
      texture.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

/** Moves the camera along its path to where the scroll has got to, with weight, a breath of hand-held drift, and a lean toward the pointer. */
function Rig({ progress, snap }: { progress: React.RefObject<number>; snap: boolean }) {
  const s = useRef(0);
  const camPos = useMemo(() => new THREE.Vector3(), []);
  const lookAt = useMemo(() => new THREE.Vector3(), []);
  useFrame((state, dt) => {
    const target = THREE.MathUtils.clamp(progress.current ?? 0, 0, 1);
    s.current = snap ? target : THREE.MathUtils.damp(s.current, target, 3.4, dt);
    CAM.getPoint(s.current, camPos);
    LOOK.getPoint(s.current, lookAt);
    const t = snap ? 0 : state.clock.elapsedTime;
    state.camera.position.set(camPos.x + state.pointer.x * 0.35 + Math.sin(t * 0.37) * 0.07, camPos.y + state.pointer.y * 0.22 + Math.sin(t * 0.51 + 1) * 0.05, camPos.z);
    state.camera.lookAt(lookAt);
    // a slow dolly-zoom into the verdict
    const cam = state.camera as THREE.PerspectiveCamera;
    const fov = 42 - 7 * THREE.MathUtils.smoothstep(s.current, 0.84, 1);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  });
  return null;
}

/** The river of coins. One draw call for all of them. */
function River({ lite, caps }: Quality & { caps: Caps }) {
  const N = lite ? 130 : 240;
  const mesh = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const seeds = useMemo(
    () => Array.from({ length: N }, (_, i) => ({ off: [(Math.sin(i * 12.9898) * 43758.5453) % 1, (Math.sin(i * 78.233) * 43758.5453) % 1, (Math.sin(i * 39.346) * 43758.5453) % 1] as const, scale: 0.7 + (Math.abs(Math.sin(i * 5.17)) % 1) * 0.6, spin: 0.6 + (i % 7) * 0.25, phase: i / N })),
    [N],
  );
  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const c = new THREE.Color();
    seeds.forEach((_, i) => m.setColorAt(i, c.set("#ffffff").multiplyScalar(0.82 + (i % 5) * 0.045)));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [seeds]);
  useFrame((state) => {
    const m = mesh.current;
    if (!m) return;
    const t = state.clock.elapsedTime;
    seeds.forEach((sd, i) => {
      const u = (sd.phase + t * 0.011) % 1;
      const p = STREAM_SAMPLES[Math.min(STREAM_SAMPLES.length - 1, Math.floor(u * STREAM_SAMPLES.length))];
      dummy.position.set(p.x + sd.off[0] * 1.2, p.y + sd.off[1] * 0.7, p.z + sd.off[2] * 1.0);
      dummy.rotation.set(t * sd.spin * 0.6 + i, t * sd.spin, 0);
      dummy.scale.setScalar(sd.scale);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, N]} frustumCulled={false}>
      <cylinderGeometry args={[0.15, 0.15, 0.04, 28]} />
      <meshStandardMaterial attach="material-0" color={GOLD} metalness={1} roughness={0.3} />
      <meshStandardMaterial attach="material-1" map={caps.map} bumpMap={caps.bump} bumpScale={2.2} metalness={1} roughness={0.28} envMapIntensity={1.1} />
      <meshStandardMaterial attach="material-2" map={caps.map} bumpMap={caps.bump} bumpScale={2.2} metalness={1} roughness={0.28} envMapIntensity={1.1} />
    </instancedMesh>
  );
}

/** A line of light running along a path: bright bands travelling in the direction of flow. */
function Flow({ curve, radius, segments, color, repeat, speed, strength = 1 }: { curve: THREE.Curve<THREE.Vector3>; radius: number; segments: number; color: string; repeat: number; speed: number; strength?: number }) {
  const geometry = useMemo(() => new THREE.TubeGeometry(curve, segments, radius, 6, false), [curve, segments, radius]);
  const material = useRef<THREE.ShaderMaterial>(null);
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uRepeat: { value: repeat }, uSpeed: { value: speed }, uStrength: { value: strength } }), [color, repeat, speed, strength]);
  useFrame((state) => {
    if (material.current) material.current.uniforms.uTime.value = state.clock.elapsedTime;
  });
  return (
    <mesh geometry={geometry}>
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
        vertexShader={"varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }"}
        fragmentShader={
          "uniform float uTime; uniform float uRepeat; uniform float uSpeed; uniform float uStrength; uniform vec3 uColor; varying vec2 vUv;" +
          "void main(){ float x = fract(vUv.x * uRepeat - uTime * uSpeed); float band = smoothstep(0.0, 0.06, x) * (1.0 - smoothstep(0.06, 0.55, x));" +
          "float a = (0.16 + band * 1.5) * uStrength; gl_FragColor = vec4(uColor * a * 2.2, a); }"
        }
      />
    </mesh>
  );
}

/** The glass branch, its gate, and the copies passing through it. */
function Branch({ lite }: Quality) {
  const tube = useMemo(() => new THREE.TubeGeometry(BRANCH, lite ? 80 : 160, 0.22, lite ? 10 : 16, false), [lite]);
  const M = lite ? 14 : 26;
  const copies = useRef<THREE.InstancedMesh>(null);
  const gate = useRef<THREE.Mesh>(null);
  const flash = useRef<THREE.PointLight>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const gold = useMemo(() => new THREE.Color(GOLD), []);
  const pass = useMemo(() => new THREE.Color(CYAN_HI).multiplyScalar(1.5), []);
  const fail = useMemo(() => new THREE.Color(MAGENTA).multiplyScalar(1.6), []);
  const tmp = useMemo(() => new THREE.Color(), []);
  useFrame((state) => {
    const m = copies.current;
    if (!m) return;
    const t = state.clock.elapsedTime;
    let near = 0;
    for (let j = 0; j < M; j++) {
      const raw = j / M + t * 0.045;
      const u = raw % 1;
      const failed = (Math.floor(raw) * 5 + j * 3) % 8 === 0; // failures are shown too: about one in eight
      BRANCH.getPointAt(u, dummy.position);
      dummy.rotation.set(t * 1.5 + j, t * 2 + j, 0);
      dummy.scale.setScalar(0.62);
      dummy.updateMatrix();
      m.setMatrixAt(j, dummy.matrix);
      const k = THREE.MathUtils.smoothstep(u, GATE_U, GATE_U + 0.05);
      tmp.copy(gold).lerp(failed ? fail : pass, k);
      m.setColorAt(j, tmp);
      near = Math.max(near, 1 - Math.min(1, Math.abs(u - GATE_U) * 12));
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    if (gate.current) {
      (gate.current.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.6 + near * 4.2;
      gate.current.scale.setScalar(1 + near * 0.1);
    }
    if (flash.current) flash.current.intensity = near * 16;
  });
  return (
    <>
      <mesh geometry={tube}>
        <meshPhysicalMaterial color={MIST} transparent opacity={0.12} roughness={0.08} clearcoat={1} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Flow curve={BRANCH} radius={0.05} segments={lite ? 120 : 260} color={CYAN_HI} repeat={9} speed={0.7} />
      <instancedMesh ref={copies} args={[undefined, undefined, M]} frustumCulled={false}>
        <cylinderGeometry args={[0.2, 0.2, 0.045, 20]} />
        <meshStandardMaterial metalness={0.5} roughness={0.35} toneMapped={false} />
      </instancedMesh>
      <mesh ref={gate} position={GATE} quaternion={GATE_QUAT}>
        <torusGeometry args={[0.55, 0.045, 16, 72]} />
        <meshStandardMaterial color={MAGENTA} emissive={MAGENTA} emissiveIntensity={1.6} toneMapped={false} />
      </mesh>
      <pointLight ref={flash} position={GATE} color={CYAN_HI} distance={6} intensity={0} />
    </>
  );
}

/** The evidence: nine slabs, the newest glowing at the top, each older one fainter. */
function Evidence() {
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(7, 0.22, 4.6)), []);
  return (
    <group position={STACK_AT} rotation={[0, 0.35, 0]}>
      {Array.from({ length: LAYERS }, (_, i) => {
        const o = Math.max(0.1, 1 - i * 0.11);
        return (
          <group key={i} position={[0, -i * 1.05, 0]}>
            <mesh>
              <boxGeometry args={[7 - i * 0.12, 0.22, 4.6 - i * 0.08]} />
              <meshStandardMaterial color={i === 0 ? "#0a5f7d" : DEEP} emissive={i === 0 ? CYAN_HI : MAGENTA} emissiveIntensity={i === 0 ? 0.14 : 0.05} transparent opacity={i === 0 ? 0.72 : o} metalness={0.4} roughness={0.4} />
            </mesh>
            <lineSegments geometry={edges}>
              <lineBasicMaterial color={i === 0 ? CYAN_HI : "#2a4a85"} transparent opacity={Math.min(1, o + 0.1)} toneMapped={false} />
            </lineSegments>
          </group>
        );
      })}
    </group>
  );
}

/** A large embossed gold coin. */
function Disc({ r, caps }: { r: number; caps: Caps }) {
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[r, r, r * 0.2, 64]} />
      <meshStandardMaterial attach="material-0" color={GOLD} metalness={1} roughness={0.28} />
      <meshStandardMaterial attach="material-1" map={caps.map} bumpMap={caps.bump} bumpScale={3} metalness={1} roughness={0.26} envMapIntensity={1.2} />
      <meshStandardMaterial attach="material-2" map={caps.map} bumpMap={caps.bump} bumpScale={3} metalness={1} roughness={0.26} envMapIntensity={1.2} />
    </mesh>
  );
}

/** The verdict: the dearer coin, and the cheaper one that does the same work, resting on the newest evidence. */
function Verdict({ caps }: { caps: Caps }) {
  const big = useRef<THREE.Group>(null);
  const small = useRef<THREE.Group>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (big.current) {
      big.current.rotation.y = t * 0.6;
      big.current.position.y = STACK_TOP + 1.5 + Math.sin(t * 0.9) * 0.1;
    }
    if (small.current) {
      small.current.rotation.y = -t * 0.9;
      small.current.position.y = STACK_TOP + 1.2 + Math.cos(t * 1.1) * 0.08;
    }
  });
  return (
    <group position={[STACK_AT.x, 0, STACK_AT.z]}>
      <group ref={big} position={[-1.4, STACK_TOP + 1.5, 0]}>
        <Disc r={0.9} caps={caps} />
      </group>
      <group ref={small} position={[1.2, STACK_TOP + 1.2, 0.4]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.45, 0.45, 0.09, 48]} />
          <meshStandardMaterial color={CYAN_HI} emissive={CYAN_HI} emissiveIntensity={1.6} metalness={0.7} roughness={0.25} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

/** The opening's focal point: one large coin, turning slowly, at the head of the river. */
function HeroCoin({ caps }: { caps: Caps }) {
  const g = useRef<THREE.Group>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (g.current) {
      g.current.rotation.y = t * 0.5;
      g.current.rotation.x = 0.35 + Math.sin(t * 0.4) * 0.1;
      g.current.position.y = 0.2 + Math.sin(t * 0.8) * 0.12;
    }
  });
  return (
    <group ref={g} position={[1.1, 0.2, 5.6]}>
      <Disc r={1.05} caps={caps} />
    </group>
  );
}

function Specks({ lite }: Quality) {
  const count = lite ? 180 : 460;
  const positions = useMemo(() => {
    const a = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      a[i * 3] = (Math.random() - 0.5) * 40;
      a[i * 3 + 1] = Math.random() * -34 + 6;
      a[i * 3 + 2] = Math.random() * -80 + 20;
    }
    return a;
  }, [count]);
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.06} color={MIST} transparent opacity={0.7} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
}

export interface LandingWorldProps {
  /** Scroll position through the film, 0 to 1. A ref, so scrolling never re-renders the scene. */
  progress: React.RefObject<number>;
  lite: boolean;
  /** Off screen, nothing is drawn at all. */
  active: boolean;
  /** Calm motion: draw one still frame and stop. */
  still?: boolean;
  /** The cinematic finish: glow, grain, vignette. Off on small machines and in small windows. */
  premium?: boolean;
}

export default function LandingWorld({ progress, lite, active, still = false, premium = false }: LandingWorldProps) {
  const caps = useMemo(() => makeCoinTextures(), []);
  useEffect(() => () => { caps.map.dispose(); caps.bump.dispose(); }, [caps]);
  return (
    <Canvas dpr={lite ? [1, 1] : [1, 1.5]} camera={{ position: [0.2, 1, 13], fov: 42, near: 0.1, far: 120 }} gl={{ antialias: !premium && !lite, powerPreference: "high-performance", stencil: false }} frameloop={still ? "demand" : active ? "always" : "never"} style={{ width: "100%", height: "100%" }}>
      <color attach="background" args={[DEEP]} />
      <fog attach="fog" args={[DEEP, 16, 62]} />
      <Env />
      <ambientLight intensity={0.3} />
      <directionalLight position={[-5, 8, 6]} intensity={1.1} color="#fff4de" />
      <pointLight position={[4, -3, 4]} intensity={20} distance={18} color={MAGENTA} />
      <pointLight position={[-2.5, -12, -12]} intensity={26} distance={16} color={CYAN_HI} />
      <Rig progress={progress} snap={still} />
      <River lite={lite} caps={caps} />
      <Flow curve={STREAM} radius={0.03} segments={lite ? 180 : 420} color="#ffffff" repeat={26} speed={0.9} strength={0.75} />
      <Branch lite={lite} />
      <Evidence />
      <Verdict caps={caps} />
      <HeroCoin caps={caps} />
      <Specks lite={lite} />
      {premium && !still && (
        <EffectComposer multisampling={2}>
          <Bloom intensity={0.95} luminanceThreshold={0.7} luminanceSmoothing={0.25} mipmapBlur radius={0.7} />
          <ChromaticAberration offset={new THREE.Vector2(0.0005, 0.0007)} radialModulation={false} modulationOffset={0} />
          <Noise opacity={0.05} blendFunction={BlendFunction.SOFT_LIGHT} />
          <Vignette offset={0.3} darkness={0.75} eskil={false} />
        </EffectComposer>
      )}
    </Canvas>
  );
}
