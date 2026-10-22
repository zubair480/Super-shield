import { useEffect, useRef } from "react";
import * as THREE from "three";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import land110 from "world-atlas/land-110m.json";

// Globo de puntos (three.js): continentes como miles de puntos, atmósfera con
// fresnel, pulsos en los estados de los fabricantes con recall y arcos desde
// "casa" (centro de EE. UU.) hacia los recalls del paciente.

import type { GlobeMarker } from "./globeData";

const TONE: Record<GlobeMarker["tone"], number> = {
  I: 0xff6a55,
  II: 0xf2b84b,
  III: 0x9fb4c8,
  bg: 0x5fd3a8,
};

const HOME = { lat: 39.5, lon: -98.35 };
const R = 1;

function toVec(lat: number, lon: number, r = R): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

/** Máscara equirectangular de tierra firme (1 = tierra). */
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

export default function Globe({ markers, arcs }: { markers: GlobeMarker[]; arcs: GlobeMarker[] }) {
  const host = useRef<HTMLDivElement>(null);
  const dyn = useRef<{ setData: (m: GlobeMarker[], a: GlobeMarker[]) => void } | null>(null);

  useEffect(() => {
    const el = host.current!;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0.35, 4.4);
    camera.lookAt(0, 0, 0);

    const world = new THREE.Group();
    world.rotation.x = 0.38;
    scene.add(world);
    const spin = new THREE.Group();
    world.add(spin);
    // Arranca con EE. UU. de frente.
    spin.rotation.y = -((HOME.lon + 90) * Math.PI) / 180;

    // Esfera base (oscura) para ocultar los puntos traseros.
    spin.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(R * 0.995, 64, 64),
        new THREE.MeshBasicMaterial({ color: 0x0a2620 }),
      ),
    );

    // Atmósfera fresnel.
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

    // Continentes como puntos (esfera de Fibonacci filtrada por la máscara).
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
      const lon = ((Math.atan2(v.z, -v.x) * 180) / Math.PI + 360) % 360 - 180;
      if (isLand(lat, lon)) pos.push(v.x * R, v.y * R, v.z * R);
    }
    const tex = dotTexture();
    const landGeo = new THREE.BufferGeometry();
    landGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    spin.add(
      new THREE.Points(
        landGeo,
        new THREE.PointsMaterial({
          size: 0.03,
          map: tex,
          color: 0x9ff0d0,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
        }),
      ),
    );

    // Capa dinámica: pulsos + arcos.
    const layer = new THREE.Group();
    spin.add(layer);
    type Pulse = { mesh: THREE.Mesh; t0: number };
    type Arc = { line: THREE.Line; head: THREE.Mesh; curve: THREE.QuadraticBezierCurve3; t0: number; n: number };
    let pulses: Pulse[] = [];
    let arcLines: Arc[] = [];
    const ringGeo = new THREE.RingGeometry(0.014, 0.019, 40);

    const clearLayer = () => {
      layer.children.slice().forEach((o) => {
        layer.remove(o);
        (o as THREE.Mesh).geometry?.dispose?.();
      });
      pulses = [];
      arcLines = [];
    };

    const setData = (ms: GlobeMarker[], as: GlobeMarker[]) => {
      clearLayer();
      const now = performance.now();
      ms.forEach((m, i) => {
        const p = toVec(m.lat, m.lon, R * 1.004);
        const dot = new THREE.Mesh(
          new THREE.CircleGeometry(m.tone === "bg" ? 0.008 : 0.016, 20),
          new THREE.MeshBasicMaterial({ color: TONE[m.tone], transparent: true, opacity: m.tone === "bg" ? 0.75 : 1 }),
        );
        dot.position.copy(p);
        dot.lookAt(p.clone().multiplyScalar(2));
        layer.add(dot);
        if (m.tone !== "bg" || i % 3 === 0) {
          const ring = new THREE.Mesh(
            ringGeo,
            new THREE.MeshBasicMaterial({ color: TONE[m.tone], transparent: true, side: THREE.DoubleSide, depthWrite: false }),
          );
          ring.position.copy(p);
          ring.lookAt(p.clone().multiplyScalar(2));
          layer.add(ring);
          pulses.push({ mesh: ring, t0: now - Math.random() * 2400 });
        }
      });
      const home = toVec(HOME.lat, HOME.lon, R * 1.004);
      const homeDot = new THREE.Mesh(
        new THREE.CircleGeometry(0.02, 24),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
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
        const line = new THREE.Line(
          g,
          new THREE.LineBasicMaterial({ color: TONE[a.tone], transparent: true, opacity: 0.9 }),
        );
        const head = new THREE.Mesh(
          new THREE.SphereGeometry(0.012, 12, 12),
          new THREE.MeshBasicMaterial({ color: TONE[a.tone] }),
        );
        layer.add(line, head);
        arcLines.push({ line, head, curve, t0: now + i * 650, n });
      });
    };
    dyn.current = { setData };

    // Arrastre con inercia.
    let drag = false;
    let lastX = 0;
    let vel = 0;
    const down = (e: PointerEvent) => {
      drag = true;
      lastX = e.clientX;
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      vel = dx * 0.005;
      spin.rotation.y += vel;
    };
    const up = () => (drag = false);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);

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
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (!visible) return;
      // Entrada: el globo "sube" y se abre.
      const intro = Math.min(1, (t - t0) / 1600);
      const e = 1 - Math.pow(1 - intro, 3);
      world.scale.setScalar(0.86 + 0.14 * e);
      world.position.y = -0.25 * (1 - e);
      if (!drag) {
        vel *= 0.94;
        spin.rotation.y += reduced ? 0 : 0.0009 + vel;
      }
      for (const p of pulses) {
        const k = ((t - p.t0) % 2400) / 2400;
        p.mesh.scale.setScalar(1 + k * 2.6);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
      }
      for (const a of arcLines) {
        const k = Math.max(0, ((t - a.t0) % 4200) / 1600);
        const draw = Math.min(1, k);
        a.line.geometry.setDrawRange(0, Math.floor(draw * a.n) + 1);
        (a.line.material as THREE.LineBasicMaterial).opacity = k > 2 ? Math.max(0, 1 - (k - 2)) * 0.9 : 0.9;
        a.head.position.copy(a.curve.getPoint(draw));
        a.head.visible = k < 1.2;
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
      el.removeEventListener("pointercancel", up);
      clearLayer();
      landGeo.dispose();
      tex.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      dyn.current = null;
    };
  }, []);

  useEffect(() => {
    dyn.current?.setData(markers, arcs);
  }, [markers, arcs]);

  return <div ref={host} className="ss-globe" aria-label="Live map of FDA drug recalls" role="img" />;
}

