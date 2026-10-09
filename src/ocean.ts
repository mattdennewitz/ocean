import * as THREE from 'three';
import type { SeaSimulation } from './sea.ts';

const RING_COUNT = 192;
const SEGMENT_COUNT = 256;
const VERTICES_PER_RING = SEGMENT_COUNT + 1;
const HORIZON_COLOR = '#80766d';

const VERTEX_SHADER = /* glsl */ `
uniform vec4 uWaveParameters[8];
uniform float uPhases[8];
uniform vec4 uRogueParameters[6];

varying vec3 vWorldPosition;
varying vec3 vSeaNormal;
varying float vWaterHeight;
varying float vBaselineHeight;
varying float vRogueHeight;
varying float vSlope;

void main() {
  vec3 displaced = position;
  float height = 0.0;
  float dx = 0.0;
  float dz = 0.0;
  float baselineHeight = 0.0;
  float rogueHeight = 0.0;

  for (int index = 0; index < 8; index++) {
    vec4 wave = uWaveParameters[index];
    float phase = wave.z * dot(wave.xy, position.xz) + uPhases[index];
    float firstSine = sin(phase);
    float secondSine = sin(2.0 * phase);
    float amplitude = wave.w;
    float contribution = amplitude * (firstSine + 0.2 * secondSine);
    float derivative = amplitude * wave.z * (cos(phase) + 0.4 * cos(2.0 * phase));
    baselineHeight += contribution;
    height += contribution;
    dx += derivative * wave.x;
    dz += derivative * wave.y;
  }

  for (int index = 0; index < 3; index++) {
    vec4 centerAndDirection = uRogueParameters[index * 2];
    float strength = uRogueParameters[index * 2 + 1].x;
    if (strength > 0.0) {
      vec2 relative = position.xz - centerAndDirection.xy;
      vec2 direction = centerAndDirection.zw;
      vec2 acrossDirection = vec2(-direction.y, direction.x);
      float along = dot(relative, direction);
      float across = dot(relative, acrossDirection);
      float crossEnvelope = exp(-(across * across) / (2.0 * 120.0 * 120.0));
      float leading = exp(-(along * along) / (2.0 * 18.0 * 18.0));
      float trailingOffset = along + 42.0;
      float trailing = exp(-(trailingOffset * trailingOffset) / (2.0 * 24.0 * 24.0));
      float longitudinal = leading - 0.45 * trailing;
      float derivativeAlong = (-along / (18.0 * 18.0)) * leading +
        (0.45 * trailingOffset / (24.0 * 24.0)) * trailing;
      float derivativeAcross = (-across / (120.0 * 120.0)) * crossEnvelope * longitudinal;
      float rogueContribution = strength * crossEnvelope * longitudinal;
      height += rogueContribution;
      rogueHeight += rogueContribution;
      dx += strength * crossEnvelope * derivativeAlong * direction.x +
        strength * derivativeAcross * acrossDirection.x;
      dz += strength * crossEnvelope * derivativeAlong * direction.y +
        strength * derivativeAcross * acrossDirection.y;
    }
  }

  displaced.y = height;
  vWorldPosition = displaced;
  vSeaNormal = normalize(vec3(-dx, 1.0, -dz));
  vWaterHeight = height;
  vBaselineHeight = baselineHeight;
  vRogueHeight = rogueHeight;
  vSlope = length(vec2(dx, dz));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uHorizonColor;
uniform float uTime;
uniform float uIntensity;

varying vec3 vWorldPosition;
varying vec3 vSeaNormal;
varying float vWaterHeight;
varying float vBaselineHeight;
varying float vRogueHeight;
varying float vSlope;


float waterNoise(vec2 point) {
  float broad = sin(point.x * 0.17 + point.y * 0.12 + uTime * 0.08) *
    sin(point.y * 0.15 - point.x * 0.09);
  float fine = sin(point.x * 0.49 + point.y * 0.31 + uTime * 0.13);
  return 0.5 + 0.32 * broad + 0.18 * fine;
}

vec3 proceduralSky(vec3 ray) {
  float height = smoothstep(-0.16, 0.60, ray.y);
  vec3 sky = mix(uHorizonColor, vec3(0.16, 0.17, 0.24), height * 0.94);
  float cloudA = sin(ray.x * 15.0 + ray.z * 8.0 + ray.y * 5.0 + uTime * 0.008);
  float cloudB = sin(ray.x * 27.0 - ray.z * 13.0 + ray.y * 10.0 - uTime * 0.006);
  float cloud = smoothstep(-0.45, 0.72, cloudA * 0.62 + cloudB * 0.38);
  sky = mix(sky, vec3(0.24, 0.22, 0.25), cloud * height * 0.17);
  vec3 sunDirection = normalize(vec3(-0.38, 0.045, -0.92));
  float sunFacing = max(dot(ray, sunDirection), 0.0);
  float sunDisc = smoothstep(0.996, 0.999, sunFacing);
  sky = mix(sky, vec3(0.86, 0.62, 0.39), sunDisc * 0.9);
  sky += vec3(0.34, 0.17, 0.08) * pow(sunFacing, 20.0) * 0.16;
  return sky;
}

void main() {
  vec3 normal = normalize(vSeaNormal);
  vec2 detailDirection = vec2(
    cos(vWorldPosition.x * 1.65 + vWorldPosition.z * 0.71 + uTime * 0.9) * 0.014,
    sin(vWorldPosition.z * 1.82 - vWorldPosition.x * 0.43 - uTime * 0.72) * 0.012
  );
  normal = normalize(normal + vec3(detailDirection.x, 0.0, detailDirection.y));
  vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
  vec3 lightDirection = normalize(vec3(-0.34, 0.24, -0.91));
  float diffuse = 0.68 + 0.32 * max(dot(normal, lightDirection), 0.0);
  float shadeBand = floor(diffuse * 3.0) / 3.0;
  float trough = smoothstep(-1.8, -0.2, vBaselineHeight);
  vec3 deepWater = vec3(0.025, 0.035, 0.062);
  vec3 litWater = vec3(0.105, 0.145, 0.195);
  vec3 water = mix(deepWater, litWater, trough * 0.72 + 0.12) *
    (0.58 + shadeBand * 0.42);

  vec3 reflectionDirection = reflect(-viewDirection, normal);
  float facing = max(dot(normal, viewDirection), 0.0);
  float fresnel = 0.035 + 0.4 * pow(1.0 - facing, 3.8);
  water = mix(water, proceduralSky(reflectionDirection), fresnel);

  float specularAngle = max(dot(reflect(-lightDirection, normal), viewDirection), 0.0);
  float broadHighlight = pow(specularAngle, 18.0) * 0.11;
  float sharpHighlight = pow(specularAngle, 64.0) * 0.14;
  water += vec3(0.48, 0.34, 0.22) * (broadHighlight + sharpHighlight);

  float noise = waterNoise(vWorldPosition.xz);
  float ordinaryCaps = smoothstep(0.1, 1.75, vBaselineHeight) *
    smoothstep(0.12, 0.68, vSlope) * noise * (0.035 + 0.46 * uIntensity);
  float rogueCaps = smoothstep(1.25, 5.0, vRogueHeight) *
    smoothstep(0.1, 0.6, vSlope) * noise * 0.68;
  float foam = clamp(max(ordinaryCaps, rogueCaps), 0.0, 0.88);
  float foamBand = floor(foam * 3.0) / 3.0;
  water = mix(water, vec3(0.49, 0.43, 0.37), foamBand * 0.56);

  float distanceFromShip = length(vWorldPosition.xz);
  float fog = smoothstep(1100.0, 1900.0, distanceFromShip);
  water = mix(water, uHorizonColor, fog);
  gl_FragColor = vec4(water, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Ocean {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly material: THREE.ShaderMaterial;

  constructor(sea: SeaSimulation) {
    const vertexCount = 1 + RING_COUNT * VERTICES_PER_RING;
    const positions = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array(RING_COUNT * SEGMENT_COUNT * 6);
    let indexOffset = 0;

    for (let ring = 1; ring <= RING_COUNT; ring += 1) {
      const radius = 2400 * (ring / RING_COUNT) ** 2;
      const ringStart = 1 + (ring - 1) * VERTICES_PER_RING;
      for (let segment = 0; segment <= SEGMENT_COUNT; segment += 1) {
        const vertex = ringStart + segment;
        if (segment === SEGMENT_COUNT) {
          positions[vertex * 3] = positions[ringStart * 3];
          positions[vertex * 3 + 2] = positions[ringStart * 3 + 2];
          continue;
        }
        const angle = (segment / SEGMENT_COUNT) * Math.PI * 2;
        positions[vertex * 3] = Math.cos(angle) * radius;
        positions[vertex * 3 + 2] = Math.sin(angle) * radius;
      }
    }

    const firstRingStart = 1;
    for (let segment = 0; segment < SEGMENT_COUNT; segment += 1) {
      indices[indexOffset] = 0;
      indices[indexOffset + 1] = firstRingStart + segment + 1;
      indices[indexOffset + 2] = firstRingStart + segment;
      indexOffset += 3;
    }

    for (let ring = 2; ring <= RING_COUNT; ring += 1) {
      const innerStart = 1 + (ring - 2) * VERTICES_PER_RING;
      const outerStart = 1 + (ring - 1) * VERTICES_PER_RING;
      for (let segment = 0; segment < SEGMENT_COUNT; segment += 1) {
        const inner = innerStart + segment;
        const innerNext = inner + 1;
        const outer = outerStart + segment;
        const outerNext = outer + 1;
        indices[indexOffset] = inner;
        indices[indexOffset + 1] = innerNext;
        indices[indexOffset + 2] = outerNext;
        indices[indexOffset + 3] = inner;
        indices[indexOffset + 4] = outerNext;
        indices[indexOffset + 5] = outer;
        indexOffset += 6;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    const horizonColor = new THREE.Color(HORIZON_COLOR);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uWaveParameters: { value: sea.waveParameters },
        uPhases: { value: sea.phases },
        uRogueParameters: { value: sea.rogueParameters },
        uHorizonColor: { value: horizonColor },
        uTime: { value: sea.elapsed },
        uIntensity: { value: sea.intensity },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: THREE.FrontSide,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  update(sea: SeaSimulation): void {
    this.material.uniforms['uTime'].value = sea.elapsed;
    this.material.uniforms['uIntensity'].value = sea.intensity;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
