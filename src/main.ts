import * as THREE from 'three';
import { Controls } from './controls.ts';
import { Ocean } from './ocean.ts';
import { SeaSimulation } from './sea.ts';
import { Ship } from './ship.ts';
import './style.css';

const HORIZON_COLOR = '#80766d';
const appElement = document.querySelector<HTMLElement>('#app');
if (!appElement) throw new Error('Missing application root');
const app: HTMLElement = appElement;

function showFailure(message: string): void {
  const notice = document.createElement('div');
  notice.className = 'failure-message';
  notice.textContent = message;
  app.replaceChildren(notice);
}

function startScene(): void {
  const canvas = document.createElement('canvas');
  canvas.className = 'voyage-canvas';
  app.append(canvas);

  let context: WebGL2RenderingContext | null;
  try {
    context = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
  } catch {
    context = null;
  }
  if (!context) {
    showFailure('WebGL2 is required to sail this scene. Try a browser with hardware acceleration enabled.');
    return;
  }

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true });
  } catch {
    showFailure('WebGL2 is required to sail this scene. Try a browser with hardware acceleration enabled.');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(HORIZON_COLOR);
  const sea = new SeaSimulation();
  const ship = new Ship();
  const ocean = new Ocean(sea);
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  const camera = new THREE.PerspectiveCamera(70, width / height, 0.1, 5000);

  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uHorizonColor: { value: new THREE.Color(HORIZON_COLOR) },
      uTime: { value: sea.elapsed },
    },
    vertexShader: /* glsl */ `
      varying vec3 vSkyDirection;
      void main() {
        vSkyDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uHorizonColor;
      uniform float uTime;
      varying vec3 vSkyDirection;
      void main() {
        vec3 direction = normalize(vSkyDirection);
        float height = smoothstep(-0.16, 0.60, direction.y);
        vec3 color = mix(uHorizonColor, vec3(0.16, 0.17, 0.24), height * 0.94);
        float cloudA = sin(direction.x * 15.0 + direction.z * 8.0 +
          direction.y * 5.0 + uTime * 0.008);
        float cloudB = sin(direction.x * 27.0 - direction.z * 13.0 +
          direction.y * 10.0 - uTime * 0.006);
        float cloud = smoothstep(-0.45, 0.72, cloudA * 0.62 + cloudB * 0.38);
        color = mix(color, vec3(0.24, 0.22, 0.25), cloud * height * 0.17);
        vec3 sunDirection = normalize(vec3(-0.38, 0.045, -0.92));
        float sunFacing = max(dot(direction, sunDirection), 0.0);
        float sunDisc = smoothstep(0.996, 0.999, sunFacing);
        color = mix(color, vec3(0.86, 0.62, 0.39), sunDisc * 0.9);
        color += vec3(0.34, 0.17, 0.08) * pow(sunFacing, 20.0) * 0.16;
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(4500, 64, 32), skyMaterial);
  sky.frustumCulled = false;
  sky.renderOrder = -1;

  const hemisphere = new THREE.HemisphereLight('#c3b9b1', '#191a24', 0.85);
  const daylight = new THREE.DirectionalLight('#ddb07b', 1.6);
  daylight.position.set(-140, 260, -240);
  scene.add(sky, hemisphere, daylight, ocean.mesh, ship.root);
  const controls = new Controls(canvas, sea, ship);

  const cameraPosition = new THREE.Vector3();
  let animationFrame = 0;
  let lastFrameTime = performance.now();
  let hudAccumulator = 0;
  let running = true;

  function resize(): void {
    const viewportWidth = canvas.clientWidth || window.innerWidth;
    const viewportHeight = canvas.clientHeight || window.innerHeight;
    camera.aspect = viewportWidth / viewportHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(viewportWidth, viewportHeight, false);
  }

  function frame(now: number): void {
    if (!running || document.hidden) return;
    const dt = Math.max(0, Math.min(0.05, (now - lastFrameTime) / 1000));
    lastFrameTime = now;
    controls.update(dt);
    ship.advance(dt, controls.throttle, controls.rudder);
    sea.update(dt, ship.worldX, ship.worldZ);
    ship.followSea(dt, sea);
    ocean.update(sea);
    ship.applyView(camera, controls.lookYaw, controls.lookPitch, sea, controls.isometricView);
    camera.getWorldPosition(cameraPosition);
    sky.position.copy(cameraPosition);
    skyMaterial.uniforms['uTime'].value = sea.elapsed;
    hudAccumulator += dt;
    if (hudAccumulator >= 0.1) {
      hudAccumulator %= 0.1;
      controls.updateHud();
    }
    renderer.render(scene, camera);
    animationFrame = window.requestAnimationFrame(frame);
  }

  function onVisibilityChange(): void {
    if (document.hidden) {
      lastFrameTime = 0;
      if (animationFrame !== 0) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      return;
    }
    lastFrameTime = performance.now();
    if (running && animationFrame === 0) {
      animationFrame = window.requestAnimationFrame(frame);
    }
  }

  function onContextLost(event: Event): void {
    event.preventDefault();
    running = false;
    if (animationFrame !== 0) window.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    controls.dispose();
    showFailure('Graphics context lost. Reload to resume sailing.');
  }

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', onVisibilityChange);
  canvas.addEventListener('webglcontextlost', onContextLost);
  resize();
  sea.update(0, ship.worldX, ship.worldZ);
  ship.followSea(0, sea);
  ship.applyView(camera, controls.lookYaw, controls.lookPitch, sea, controls.isometricView);
  camera.getWorldPosition(cameraPosition);
  sky.position.copy(cameraPosition);
  renderer.render(scene, camera);
  if (!document.hidden) animationFrame = window.requestAnimationFrame(frame);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      running = false;
      if (animationFrame !== 0) window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      controls.dispose();
      ship.dispose();
      ocean.dispose();
      sky.geometry.dispose();
      skyMaterial.dispose();
      renderer.dispose();
      canvas.remove();
    });
  }
}

startScene();
