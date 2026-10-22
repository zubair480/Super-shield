import { useEffect, useRef } from "react";
import type React from "react";
import * as THREE from "three";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import land110 from "world-atlas/land-110m.json";
import type { GlobeMarker } from "./globeData";

// Globo de puntos (three.js): continentes como miles de puntos, atmósfera fresnel,
// pulsos en los fabricantes con recall y arcos desde "casa" hacia los recalls del
// paciente. Interactivo: entra con zoom desde el espacio, se arrastra con inercia,
// los marcadores se resaltan al pasar y al hacer clic el globo vuela hacia ellos.

const TONE: Record<GlobeMarker["tone"], number> = {
  I: 0xff6a55,
  II: 0xf2b84b,
  III: 0x9fb4c8,
  bg: 0x5fd3a8,
};

const HOME = { lat: 39.5, lon: -98.35 };
const R = 1;
const CAM_FAR = 11;
const CAM_NEAR = 5.1;
const CAM_FOCUS = 3.4;
const CAM_MIN = 1.75;
const CAM_MAX = 6;

function toVec(lat: number, lon: number, r = R): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

const spinFor = (lon: number) => -((lon + 90) * Math.PI) / 180;
const tiltFor = (lat: number) => ((lat * Math.PI) / 180) * 0.85;

function landMask(w = 720, h = 360): (lat: number, lon: number) => boolean {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const topo = land110 as unknown as Topology<{ land: GeometryCollection }>;
  const geo = feature(topo, topo.objects.land) as unknown as {
    features: { geometry: { type: string; coordinates: number[][][] | number[][][][] } }[];
  };
  g.fillStyle = "#fff";
  const ring = (pts: number[][]) => {
    pts.forEach(([lon, lat], i) => {
      const x = ((lon! + 180) / 360) * w;
      const y = ((90 - lat!) / 180) * h;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.closePath();
  };
  for (const f of geo.features) {
    g.beginPath();
    const polys =
      f.geometry.type === "Polygon"
        ? [f.geometry.coordinates as number[][][]]
        : (f.geometry.coordinates as number[][][][]);
    for (const poly of polys) for (const r of poly) ring(r);
    g.fill("evenodd");
  }
  const data = g.getImageData(0, 0, w, h).data;
  return (lat, lon) => {
    const x = Math.min(w - 1, Math.max(0, Math.floor(((lon + 180) / 360) * w)));
    const y = Math.min(h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * h)));
    return data[(y * w + x) * 4]! > 128;
  };
}

function dotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.45, "rgba(255,255,255,0.9)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const ease = (k: number) => 1 - Math.pow(1 - k, 3);
const lerpAngle = (a: number, b: number, k: number) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};

export interface GlobeProps {
  markers: GlobeMarker[];
  arcs: GlobeMarker[];
  focus?: GlobeMarker | null;
  onPick?: (m: GlobeMarker | null) => void;
  /** Posición horizontal del centro del globo dentro del lienzo (0 = centro, 0.5 = borde derecho). */
  shift?: number;
}

export interface GlobeHandle {
  zoom: (dir: 1 | -1) => void;
  reset: () => void;
}

export default function Globe({ markers, arcs, focus, onPick, shift = 0, control }: GlobeProps & { control?: React.MutableRefObject<GlobeHandle | null> }) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{
    setData: (m: GlobeMarker[], a: GlobeMarker[]) => void;
    flyTo: (m: GlobeMarker | null) => void;
  } | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const shiftRef = useRef(shift);
  shiftRef.current = shift;

  useEffect(() => {
    const el = host.current!;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0.3, reduced ? CAM_NEAR : CAM_FAR);
    camera.lookAt(0, 0, 0);

    const world = new THREE.Group();
    world.rotation.x = tiltFor(HOME.lat) * 0.5;
    scene.add(world);
    const spin = new THREE.Group();
    world.add(spin);
    // Entra girando casi media vuelta y se asienta con EE. UU. de frente.
    spin.rotation.y = spinFor(HOME.lon) + (reduced ? 0 : Math.PI * 0.9);

    spin.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(R * 0.995, 64, 64),
        new THREE.MeshBasicMaterial({ color: 0x0a2620 }),
      ),
    );

    // Graticula tenue (meridianos y paralelos).
    const gratMat = new THREE.LineBasicMaterial({ color: 0x5fd3a8, transparent: true, opacity: 0.07 });
    const gratGeos: THREE.BufferGeometry[] = [];
    const addLine = (pts: THREE.Vector3[]) => {
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      gratGeos.push(g);
      spin.add(new THREE.Line(g, gratMat));
    };
    for (let lat = -60; lat <= 60; lat += 30) {
      const pts: THREE.Vector3[] = [];
      for (let lon = -180; lon <= 180; lon += 4) pts.push(toVec(lat, lon, R * 1.001));
      addLine(pts);
    }
    for (let lon = -180; lon < 180; lon += 30) {
      const pts: THREE.Vector3[] = [];
      for (let lat = -90; lat <= 90; lat += 4) pts.push(toVec(lat, lon, R * 1.001));
      addLine(pts);
    }

    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.1, 64, 64),
      new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexShader: `varying vec3 vN; void main(){ vN = normalize(normalMatrix*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
        fragmentShader: `varying vec3 vN; void main(){ float i = pow(max(0.0, 0.62 - dot(vN, vec3(0.0,0.0,1.0))), 2.6); gl_FragColor = vec4(0.27,0.78,0.58,1.0)*i*0.85; }`,
      }),
    );
    world.add(atmo);

    // Órbita decorativa con un "satélite" (la vigilancia que da vueltas).
    const orbit = new THREE.Group();
    const orbitPts: THREE.Vector3[] = [];
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += Math.PI / 90)
      orbitPts.push(new THREE.Vector3(Math.cos(a) * 1.42, 0, Math.sin(a) * 1.42));
    const orbitLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(orbitPts),
      new THREE.LineDashedMaterial({ color: 0x5fd3a8, dashSize: 0.025, gapSize: 0.04, transparent: true, opacity: 0.35 }),
    );
    orbitLine.computeLineDistances();
    orbit.add(orbitLine);
    const sat = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 16), new THREE.MeshBasicMaterial({ color: 0xb8f0d9 }));
    orbit.add(sat);
    orbit.rotation.set(1.15, 0, 0.35);
    world.add(orbit);

    const isLand = landMask();
    const N = 26000;
    const pos: number[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const rad = Math.sqrt(1 - y * y);
      const th = golden * i;
      const v = new THREE.Vector3(Math.cos(th) * rad, y, Math.sin(th) * rad);
      const lat = 90 - (Math.acos(v.y) * 180) / Math.PI;
      const lon = (((Math.atan2(v.z, -v.x) * 180) / Math.PI + 360) % 360) - 180;
      if (isLand(lat, lon)) pos.push(v.x * R, v.y * R, v.z * R);
    }
    const tex = dotTexture();
    const landGeo = new THREE.BufferGeometry();
    landGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    spin.add(
      new THREE.Points(
        landGeo,
        new THREE.PointsMaterial({ size: 0.03, map: tex, color: 0x9ff0d0, transparent: true, opacity: 0.95, depthWrite: false }),
      ),
    );

    const layer = new THREE.Group();
    spin.add(layer);
    type Pulse = { mesh: THREE.Mesh; t0: number };
    type Arc = { line: THREE.Line; head: THREE.Mesh; curve: THREE.QuadraticBezierCurve3; t0: number; n: number };
    let pulses: Pulse[] = [];
    let arcLines: Arc[] = [];
    let hits: THREE.Mesh[] = [];
    const ringGeo = new THREE.RingGeometry(0.014, 0.019, 40);
    const hitGeo = new THREE.CircleGeometry(0.05, 12);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });

    const clearLayer = () => {
      layer.children.slice().forEach((o) => {
        layer.remove(o);
        const g = (o as THREE.Mesh).geometry;
        if (g && g !== ringGeo && g !== hitGeo) g.dispose();
      });
      pulses = [];
      arcLines = [];
      hits = [];
    };

    const setData = (ms: GlobeMarker[], as: GlobeMarker[]) => {
      clearLayer();
      const now = performance.now();
      ms.forEach((m, i) => {
        const p = toVec(m.lat, m.lon, R * 1.004);
        const out = p.clone().multiplyScalar(2);
        const dot = new THREE.Mesh(
          new THREE.CircleGeometry(m.tone === "bg" ? 0.009 : 0.017, 20),
          new THREE.MeshBasicMaterial({ color: TONE[m.tone], transparent: true, opacity: m.tone === "bg" ? 0.8 : 1 }),
        );
        dot.position.copy(p);
        dot.lookAt(out);
        layer.add(dot);
        const hit = new THREE.Mesh(hitGeo, hitMat);
        hit.position.copy(p);
        hit.lookAt(out);
        hit.userData = { marker: m, dot };
        layer.add(hit);
        hits.push(hit);
        if (m.tone !== "bg" || i % 3 === 0) {
          const ring = new THREE.Mesh(
            ringGeo,
            new THREE.MeshBasicMaterial({ color: TONE[m.tone], transparent: true, side: THREE.DoubleSide, depthWrite: false }),
          );
          ring.position.copy(p);
          ring.lookAt(out);
          layer.add(ring);
          pulses.push({ mesh: ring, t0: now - Math.random() * 2400 });
        }
      });
      const home = toVec(HOME.lat, HOME.lon, R * 1.004);
      const homeDot = new THREE.Mesh(new THREE.CircleGeometry(0.022, 24), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      homeDot.position.copy(home);
      homeDot.lookAt(home.clone().multiplyScalar(2));
      layer.add(homeDot);

      as.forEach((a, i) => {
        const end = toVec(a.lat, a.lon, R * 1.004);
        const dist = home.distanceTo(end);
        const mid = home.clone().add(end).multiplyScalar(0.5).normalize().multiplyScalar(R + 0.12 + dist * 0.35);
        const curve = new THREE.QuadraticBezierCurve3(home, mid, end);
        const n = 64;
        const g = new THREE.BufferGeometry().setFromPoints(curve.getPoints(n));
        g.setDrawRange(0, 0);
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: TONE[a.tone], transparent: true, opacity: 0.9 }));
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.013, 12, 12), new THREE.MeshBasicMaterial({ color: TONE[a.tone] }));
        layer.add(line, head);
        arcLines.push({ line, head, curve, t0: now + 1400 + i * 650, n });
      });
    };

    // Vuelo hacia un marcador (o de vuelta a casa).
    let flight: { t0: number; fromY: number; toY: number; fromX: number; toX: number; fromZ: number; toZ: number } | null =
      null;
    let focused = false;
    const flyTo = (m: GlobeMarker | null, z?: number) => {
      focused = !!m;
      const target = m ?? HOME;
      flight = {
        t0: performance.now(),
        fromY: spin.rotation.y,
        toY: spinFor(target.lon),
        fromX: world.rotation.x,
        toX: tiltFor(target.lat) * (m ? 1 : 0.5),
        fromZ: camera.position.z,
        toZ: z ?? (m ? CAM_FOCUS : CAM_NEAR),
      };
    };
    const zoomTo = (z: number) => {
      const tz = Math.max(CAM_MIN, Math.min(CAM_MAX, z));
      flight = {
        t0: performance.now(),
        fromY: spin.rotation.y,
        toY: spin.rotation.y,
        fromX: world.rotation.x,
        toX: world.rotation.x,
        fromZ: camera.position.z,
        toZ: tz,
      };
      focused = tz < CAM_NEAR - 0.2;
    };
    api.current = { setData, flyTo };
    if (control) {
      control.current = {
        zoom: (dir) => zoomTo(camera.position.z * (dir > 0 ? 0.72 : 1.38)),
        reset: () => {
          flyTo(null);
          pickRef.current?.(null);
        },
      };
    }

    // Puntero: arrastre con inercia, hover y clic sobre marcadores.
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let drag = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;
    let vel = 0;
    let hovered: THREE.Mesh | null = null;
    const pickAt = (e: PointerEvent): THREE.Mesh | null => {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(hits, false)[0];
      if (!hit) return null;
      const wp = hit.object.getWorldPosition(new THREE.Vector3());
      return wp.z > 0.1 ? (hit.object as THREE.Mesh) : null; // solo la cara visible
    };
    const down = (e: PointerEvent) => {
      drag = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (drag) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        moved += Math.abs(dx) + Math.abs(dy);
        lastX = e.clientX;
        lastY = e.clientY;
        vel = dx * 0.005;
        spin.rotation.y += vel;
        world.rotation.x = Math.max(-0.9, Math.min(0.9, world.rotation.x + dy * 0.003));
        flight = null;
        return;
      }
      const h = pickAt(e);
      if (h !== hovered) {
        if (hovered) (hovered.userData.dot as THREE.Mesh).scale.setScalar(1);
        hovered = h;
        if (h) (h.userData.dot as THREE.Mesh).scale.setScalar(1.9);
        el.style.cursor = h ? "pointer" : "";
      }
    };
    const up = (e: PointerEvent) => {
      if (drag && moved < 6) {
        const h = pickAt(e);
        const m = (h?.userData.marker as GlobeMarker | undefined) ?? null;
        if (m) {
          flyTo(m);
          pickRef.current?.(m);
        }
      }
      drag = false;
    };
    const cancel = () => (drag = false);
    const globeHit = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 32), new THREE.MeshBasicMaterial({ visible: false }));
    spin.add(globeHit);
    let deep = false;
    const dbl = (e: MouseEvent) => {
      if (deep) {
        deep = false;
        flyTo(null);
        pickRef.current?.(null);
        return;
      }
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObject(globeHit, false)[0];
      if (!hit) return;
      const local = spin.worldToLocal(hit.point.clone()).normalize();
      const lat = 90 - (Math.acos(local.y) * 180) / Math.PI;
      const lon = (((Math.atan2(local.z, -local.x) * 180) / Math.PI + 360) % 360) - 180;
      deep = true;
      flyTo({ lat, lon, tone: "bg" }, CAM_MIN);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (deep || focused)) {
        deep = false;
        flyTo(null);
        pickRef.current?.(null);
      }
    };
    el.addEventListener("dblclick", dbl);
    window.addEventListener("keydown", key);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);

    const resize = () => {
      const { width, height } = el.getBoundingClientRect();
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let raf = 0;
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    io.observe(el);
    const t0 = performance.now();
    const introY = spin.rotation.y;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (!visible) return;
      const intro = reduced ? 1 : Math.min(1, (t - t0) / 2600);
      if (intro < 1) {
        const e = ease(intro);
        camera.position.z = CAM_FAR + (CAM_NEAR - CAM_FAR) * e;
        spin.rotation.y = introY + (spinFor(HOME.lon) - introY) * e;
      } else if (flight) {
        const k = Math.min(1, (t - flight.t0) / 1300);
        const e = ease(k);
        spin.rotation.y = lerpAngle(flight.fromY, flight.toY, e);
        world.rotation.x = flight.fromX + (flight.toX - flight.fromX) * e;
        camera.position.z = flight.fromZ + (flight.toZ - flight.fromZ) * e;
        if (k >= 1) flight = null;
      } else if (!drag) {
        vel *= 0.94;
        spin.rotation.y += (reduced || focused ? 0 : 0.0009) + vel;
      }
      const halfW = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z * camera.aspect;
      world.position.x = halfW * shiftRef.current * 2 * Math.min(1, camera.position.z / CAM_NEAR);
      orbit.rotation.y += reduced ? 0 : 0.0016;
      const a = t * 0.0004;
      sat.position.set(Math.cos(a) * 1.42, 0, Math.sin(a) * 1.42);
      for (const p of pulses) {
        const k = ((t - p.t0) % 2400) / 2400;
        p.mesh.scale.setScalar(1 + k * 2.6);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
      }
      for (const arc of arcLines) {
        const k = Math.max(0, ((t - arc.t0) % 4200) / 1600);
        const draw = t < arc.t0 ? 0 : Math.min(1, k);
        arc.line.geometry.setDrawRange(0, Math.floor(draw * arc.n) + 1);
        (arc.line.material as THREE.LineBasicMaterial).opacity = k > 2 ? Math.max(0, 1 - (k - 2)) * 0.9 : 0.9;
        arc.head.position.copy(arc.curve.getPoint(draw));
        arc.head.visible = t >= arc.t0 && k < 1.2;
      }
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      el.removeEventListener("dblclick", dbl);
      window.removeEventListener("keydown", key);
      clearLayer();
      gratGeos.forEach((g) => g.dispose());
      landGeo.dispose();
      tex.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      api.current = null;
    };
  }, []);

  useEffect(() => {
    api.current?.setData(markers, arcs);
  }, [markers, arcs]);

  useEffect(() => {
    if (focus !== undefined) api.current?.flyTo(focus);
  }, [focus]);

  return <div ref={host} className="ss-globe" aria-label="Interactive globe of FDA drug recalls" role="img" />;
}
