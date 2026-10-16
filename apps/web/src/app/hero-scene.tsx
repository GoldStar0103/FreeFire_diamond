'use client';

import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from './use-reduced-motion';

/**
 * Floating 3D diamonds behind the 110 hero. Cosmetic only — the buy link
 * sits above this canvas and never depends on WebGL being available.
 */
export function HeroScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || reducedMotion) return;

    let disposed = false;
    let teardown: (() => void) | undefined;

    const start = async () => {
      const THREE = await import('three');
      if (disposed || !canvas.isConnected) return;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 40);
      camera.position.set(0.6, 0.15, 6.2);

      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'low-power',
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);

      scene.add(new THREE.AmbientLight(0xb8a6ff, 0.85));
      const key = new THREE.PointLight(0x22d3ee, 18, 18);
      key.position.set(2.4, 1.6, 3.2);
      scene.add(key);
      const gold = new THREE.PointLight(0xf5c84c, 10, 14);
      gold.position.set(-1.6, -0.8, 2.4);
      scene.add(gold);

      const colors = [0x22d3ee, 0xa78bfa, 0xf5c84c, 0x67e8f9];
      const gems: Array<{
        mesh: InstanceType<typeof THREE.Mesh>;
        spin: InstanceType<typeof THREE.Vector3>;
        phase: number;
        baseY: number;
      }> = [];

      for (let i = 0; i < 22; i += 1) {
        const geo = new THREE.OctahedronGeometry(0.12 + Math.random() * 0.16, 0);
        const mat = new THREE.MeshStandardMaterial({
          color: colors[i % colors.length],
          metalness: 0.55,
          roughness: 0.18,
          emissive: colors[i % colors.length],
          emissiveIntensity: 0.22,
        });
        const mesh = new THREE.Mesh(geo, mat);
        const y = -1.5 + Math.random() * 3.2;
        mesh.position.set(0.4 + Math.random() * 3.4, y, -0.6 + Math.random() * 2.2);
        mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
        scene.add(mesh);
        gems.push({
          mesh,
          spin: new THREE.Vector3(0.4 + Math.random(), 0.6 + Math.random(), 0.25),
          phase: Math.random() * Math.PI * 2,
          baseY: y,
        });
      }

      const resize = () => {
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (!width || !height) return;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      };

      resize();
      window.addEventListener('resize', resize);

      const t0 = performance.now();
      renderer.setAnimationLoop(() => {
        const t = (performance.now() - t0) / 1000;
        for (const gem of gems) {
          gem.mesh.rotation.x += gem.spin.x * 0.008;
          gem.mesh.rotation.y += gem.spin.y * 0.01;
          gem.mesh.position.y = gem.baseY + Math.sin(t * 0.9 + gem.phase) * 0.18;
        }
        camera.position.x = 0.6 + Math.sin(t * 0.18) * 0.12;
        renderer.render(scene, camera);
      });

      teardown = () => {
        window.removeEventListener('resize', resize);
        renderer.setAnimationLoop(null);
        for (const gem of gems) {
          gem.mesh.geometry.dispose();
          (gem.mesh.material as InstanceType<typeof THREE.Material>).dispose();
        }
        renderer.dispose();
      };
    };

    start().catch(() => {
      /* WebGL unavailable — the hero still works without it. */
    });

    return () => {
      disposed = true;
      teardown?.();
    };
  }, [reducedMotion]);

  if (reducedMotion) return null;

  return <canvas ref={canvasRef} className="hm-hero-scene" aria-hidden="true" />;
}
